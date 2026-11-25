import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import ocpp from 'ocpp-rpc';
import { createStation } from './station.mjs';

const TAG = '0000012345';
const OTHER = '0000067890';
const accepted = { idTagInfo: { status: 'Accepted' } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function until(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(10);
  }
  assert.fail('Timed out waiting for local test state');
}
async function setup(t, overrides = {}) {
  const rx = [];
  let cp;
  const rpc = new ocpp.RPCServer({ protocols: ['ocpp1.6'], strictMode: true });
  rpc.auth((accept) => accept());
  rpc.on('client', (client) => {
    cp = client;
    for (const action of ['StatusNotification', 'MeterValues', 'StopTransaction']) {
      client.handle(action, ({ params }) => {
        rx.push({ action, params });
        return {};
      });
    }
    client.handle('BootNotification', () => ({
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: 60,
    }));
    client.handle('Heartbeat', () => ({ currentTime: new Date().toISOString() }));
    client.handle('Authorize', ({ params }) => {
      rx.push({ action: 'Authorize', params, identity: client.identity });
      return overrides.authorize
        ? overrides.authorize(params, client)
        : {
            idTagInfo: {
              status: params.idTag === TAG || params.idTag === OTHER ? 'Accepted' : 'Invalid',
            },
          };
    });
    client.handle('StartTransaction', ({ params }) => {
      rx.push({ action: 'StartTransaction', params, identity: client.identity });
      return overrides.start
        ? overrides.start(params, client)
        : { transactionId: 1234567890 + params.connectorId, ...accepted };
    });
  });
  const http = await rpc.listen(0, '127.0.0.1');
  const csmsUrl = 'ws://127.0.0.1:' + http.address().port + '/ocpp';
  const station = createStation({ csmsUrl, cpId: 'RFID-LOCAL-TEST', retryMs: 60000 });
  t.after(async () => {
    await station.close();
    await rpc.close();
  });
  await station.start();
  const act = (name, body) => station.act(name, { connector: 1, ...body });
  const scan = (body) => act('swipeReader', { idTag: TAG, ...body });
  return {
    station,
    rx,
    act,
    scan,
    csmsUrl,
    cp: () => cp,
    count: (action) => rx.filter((item) => item.action === action).length,
  };
}

test('loopback: exact leading-zero tag -> Authorize -> one Start, masked HMI output', async (t) => {
  const h = await setup(t);
  await h.act('plug');
  assert.equal((await h.scan()).code, 'started');
  const calls = h.rx.filter((m) => ['Authorize', 'StartTransaction'].includes(m.action));
  assert.deepEqual(
    calls.map((m) => m.action),
    ['Authorize', 'StartTransaction'],
  );
  assert.ok(calls.every((m) => m.params.idTag === TAG));
  assert.equal(h.station.snapshot().connectors[0].txId, 1234567891);
  assert.equal(h.station.snapshot().connectors[0].idTag, '[reader identifier]');
  assert.equal(JSON.stringify(h.station.logHistory()).includes(TAG), false);
  assert.equal(JSON.stringify(h.station.snapshot()).includes(TAG), false);
  assert.ok(JSON.stringify(h.station.logHistory()).includes('1234567891'));
  assert.equal((await h.scan()).ok, false);
  assert.equal(h.count('StartTransaction'), 1);
});

for (const status of ['Invalid', 'Blocked', 'Expired']) {
  test('loopback: ' + status + ' sends no Start', async (t) => {
    const h = await setup(t, { authorize: () => ({ idTagInfo: { status } }) });
    await h.act('plug');
    assert.equal((await h.scan()).code, 'rejected');
    assert.equal(h.count('StartTransaction'), 0);
  });
}

test('loopback: unregistered numeric reader tag is never mapped to seed card', async (t) => {
  const h = await setup(t);
  await h.act('plug');
  assert.equal((await h.scan({ idTag: '0000099999' })).code, 'rejected');
  assert.equal(h.rx.find((m) => m.action === 'Authorize').params.idTag, '0000099999');
  assert.equal(h.count('StartTransaction'), 0);
});

test('loopback: concurrent Enter calls lock same gun, second gun stays independent', async (t) => {
  const wait = deferred();
  const h = await setup(t, { authorize: () => wait.promise });
  await h.act('plug');
  await h.act('plug', { connector: 2 });
  const first = h.scan();
  await until(() => h.count('Authorize') === 1);
  assert.equal((await h.scan()).code, 'busy');
  const second = h.scan({ connector: 2, idTag: OTHER });
  assert.ok(h.station.snapshot().connectors.every((c) => c.readerPending));
  wait.resolve(accepted);
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(h.count('Authorize'), 2);
  assert.equal(h.count('StartTransaction'), 2);
});

test('loopback: unplug/replug invalidates a delayed Accepted', async (t) => {
  const wait = deferred();
  const h = await setup(t, { authorize: () => wait.promise });
  await h.act('plug');
  const pending = h.scan();
  await until(() => h.count('Authorize') === 1);
  const unplug = h.act('unplug');
  const replug = h.act('plug');
  wait.resolve(accepted);
  await Promise.all([unplug, replug]);
  assert.equal((await pending).code, 'stale');
  assert.equal(h.count('StartTransaction'), 0);
});

test('loopback: lost connection/no Authorize response never starts', async (t) => {
  const wait = deferred();
  const h = await setup(t, { authorize: () => wait.promise });
  await h.act('plug');
  const pending = h.scan();
  await until(() => h.count('Authorize') === 1);
  await h.cp().close({ force: true });
  assert.equal((await pending).code, 'network');
  wait.resolve(accepted);
  assert.equal(h.count('StartTransaction'), 0);
  assert.equal(h.station.snapshot().connectors[0].readerPending, false);
});

test('loopback: rejected authorization releases lock for retry', async (t) => {
  let n = 0;
  const h = await setup(t, {
    authorize: () => (++n === 1 ? { idTagInfo: { status: 'Blocked' } } : accepted),
  });
  await h.act('plug');
  assert.equal((await h.scan()).code, 'rejected');
  assert.equal((await h.scan()).code, 'started');
  assert.equal(h.count('StartTransaction'), 1);
});

test('loopback: Start emitted but response lost stays awaiting, no repeat Start', async (t) => {
  const wait = deferred();
  const h = await setup(t, {
    start: (_params, client) => {
      setImmediate(() => client.close({ force: true }));
      return wait.promise;
    },
  });
  await h.act('plug');
  assert.equal((await h.scan()).code, 'awaiting');
  assert.equal(h.count('StartTransaction'), 1);
  assert.equal(h.station.snapshot().connectors[0].txId, null);
  assert.equal((await h.scan()).ok, false);
  assert.equal(h.count('StartTransaction'), 1);
  wait.resolve({ transactionId: 71, ...accepted });
});

test('loopback: scheduled RemoteStart cannot overwrite reader transaction', async (t) => {
  const wait = deferred();
  const h = await setup(t, { authorize: () => wait.promise });
  await h.act('plug');
  const pending = h.scan();
  await until(() => h.count('Authorize') === 1);
  const scheduled = [];
  const original = globalThis.setImmediate;
  t.mock.method(globalThis, 'setImmediate', (fn, ...args) => {
    if (fn.toString().includes('startTx(target')) {
      scheduled.push(fn);
      return {};
    }
    return original(fn, ...args);
  });
  const reply = await h
    .cp()
    .call('RemoteStartTransaction', { connectorId: 1, idTag: 'DEMO-CARD-0001' });
  assert.equal(reply.status, 'Accepted');
  assert.equal(scheduled.length, 1);
  wait.resolve(accepted);
  assert.equal((await pending).code, 'started');
  scheduled[0]();
  await pause(50);
  assert.equal(h.count('StartTransaction'), 1);
  assert.equal(h.station.snapshot().connectors[0].source, 'rfid');
  assert.equal(h.station.snapshot().connectors[0].txId, 1234567891);
});

test('loopback: physical HTTP route is bounded JSON and same-origin only', async (t) => {
  const h = await setup(t);
  const child = spawn(
    process.execPath,
    [new URL('./server.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    {
      env: {
        ...process.env,
        HMI_HOST: '127.0.0.1',
        HMI_PORT: '0',
        CSMS_URL: h.csmsUrl,
        CP_ID: 'RFID-HTTP-TEST',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(async () => {
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const send = (body, headers = {}) =>
    fetch(base + '/api/swipeReader', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const frame = { connector: 1, idTag: TAG };
  assert.equal((await send(frame, { origin: 'https://other.example' })).status, 403);
  assert.equal((await send(frame, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send(frame, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await send(frame, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('x'.repeat(513))).status, 413);
  const malformed = await send('{"idTag":"' + TAG + '"');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(TAG), false);
  assert.equal((await send({ ...frame, card: 'valid' })).status, 400);
  assert.equal(h.count('Authorize'), 0);
  await until(async () => (await (await fetch(base + '/api/state')).json()).net.booted);
  await fetch(base + '/api/plug', { method: 'POST', body: JSON.stringify({ connector: 1 }) });
  const result = await send(frame, { origin: base, 'sec-fetch-site': 'same-origin' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).code, 'started');
  assert.equal(h.count('Authorize'), 1);
});

// QA-03: một server nhiều trụ — đầu đọc theo trụ qua /api/<cpId>/swipeReader, cùng kiểm tra bảo mật.
async function spawnServer(t, env) {
  const child = spawn(
    process.execPath,
    [new URL('./server.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    {
      env: { ...process.env, HMI_HOST: '127.0.0.1', HMI_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(async () => {
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
  return output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
}

test('multi-station: reader on second station starts only that station', async (t) => {
  const h = await setup(t);
  const base = await spawnServer(t, { CSMS_URL: h.csmsUrl, CP_IDS: 'RFID-A,RFID-B' });
  const state = async (cp) => (await fetch(base + '/api/' + cp + '/state')).json();
  await until(async () => (await state('RFID-A')).net.booted && (await state('RFID-B')).net.booted);
  for (const cp of ['RFID-A', 'RFID-B'])
    await fetch(base + '/api/' + cp + '/plug', {
      method: 'POST',
      body: JSON.stringify({ connector: 1 }),
    });
  const result = await fetch(base + '/api/RFID-B/swipeReader', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ connector: 1, idTag: TAG }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).code, 'started');
  const starts = h.rx.filter((m) => m.action === 'StartTransaction');
  assert.deepEqual(
    starts.map((m) => m.identity),
    ['RFID-B'],
  );
  assert.deepEqual(
    h.rx.filter((m) => m.action === 'Authorize').map((m) => m.identity),
    ['RFID-B'],
  );
  const a = await state('RFID-A'),
    b = await state('RFID-B');
  assert.equal(a.connectors[0].txActive, false);
  assert.equal(b.connectors[0].txActive, true);
  assert.equal(b.connectors[0].source, 'rfid');
  assert.equal(JSON.stringify(b).includes(TAG), false);
  const steps = b.connectors[0].journeys.at(-1).steps;
  assert.ok(steps.some((st) => st.kind === 'authorize' && st.reader && st.status === 'Accepted'));
  assert.ok(steps.some((st) => st.kind === 'startSent' && st.reader === true));
});

test('multi-station: per-station reader route keeps same-origin, JSON and size checks', async (t) => {
  const h = await setup(t);
  const base = await spawnServer(t, { CSMS_URL: h.csmsUrl, CP_IDS: 'RFID-A,RFID-B' });
  const send = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const frame = { connector: 1, idTag: TAG };
  const route = '/api/RFID-B/swipeReader';
  assert.equal((await send(route, frame, { origin: 'https://other.example' })).status, 403);
  assert.equal((await send(route, frame, { origin: 'http://localhost:1' })).status, 403);
  assert.equal((await send(route, frame, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send(route, frame, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await send(route, frame, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(route, 'x'.repeat(513))).status, 413);
  assert.equal((await send(route, { ...frame, card: 'valid' })).status, 400);
  assert.equal((await send('/api/NOPE/swipeReader', frame)).status, 404);
  assert.equal((await send('/api/RFID-B/x/swipeReader', frame)).status, 404);
  assert.equal(h.count('Authorize'), 0);
});
