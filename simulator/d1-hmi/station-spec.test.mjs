// QA-11 — trụ chạy đúng phần cứng trong DB: số súng, kW từng súng, AC không gửi SoC, không có giá.
import test from 'node:test';
import assert from 'node:assert/strict';
import ocpp from 'ocpp-rpc';
import { parseSpec } from './model.mjs';
import { createStation } from './station.mjs';

const { RPCServer } = ocpp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseSpec: D1 mặc định, DC hai súng có trần riêng, AC một súng, chuỗi sai', () => {
  assert.deepEqual(parseSpec(''), {
    kind: 'dc',
    ratedKw: 120,
    model: 'D1-120',
    reportsSoc: true,
    guns: [
      { id: 1, maxKw: Infinity },
      { id: 2, maxKw: Infinity },
    ],
  });
  assert.deepEqual(parseSpec('dc120:120/60').guns, [
    { id: 1, maxKw: 120 },
    { id: 2, maxKw: 60 },
  ]);
  assert.deepEqual(parseSpec('AC22:22'), {
    kind: 'ac',
    ratedKw: 22,
    model: 'AC-22',
    reportsSoc: false,
    guns: [{ id: 1, maxKw: 22 }],
  });
  for (const bad of ['x', 'dc120', 'dc120:', 'dc0:10', 'dc10:0', 'dc10:1/2/3', 'hv10:10'])
    assert.throws(() => parseSpec(bad), /cấu hình trụ|công suất/, bad);
});

async function fakeCsms() {
  const rx = [];
  const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true });
  let client = null;
  server.on('client', (c) => {
    client = c;
    const rec = (action, reply) => (ctx) => (rx.push({ action, params: ctx.params }), reply());
    c.handle(
      'BootNotification',
      rec('BootNotification', () => ({
        status: 'Accepted',
        currentTime: new Date().toISOString(),
        interval: 60,
      })),
    );
    c.handle(
      'StatusNotification',
      rec('StatusNotification', () => ({})),
    );
    c.handle(
      'Heartbeat',
      rec('Heartbeat', () => ({ currentTime: new Date().toISOString() })),
    );
    c.handle(
      'MeterValues',
      rec('MeterValues', () => ({})),
    );
    c.handle(
      'StartTransaction',
      rec('StartTransaction', () => ({ transactionId: 7, idTagInfo: { status: 'Accepted' } })),
    );
    c.handle(
      'StopTransaction',
      rec('StopTransaction', () => ({})),
    );
  });
  const http = await server.listen(0, '127.0.0.1');
  return {
    rx,
    server,
    url: `ws://127.0.0.1:${http.address().port}`,
    get client() {
      return client;
    },
  };
}

test('trụ AC 22 kW một súng: Boot AC-22, chỉ súng 1, kW ≤ 22, không SoC, không giá', async (t) => {
  const csms = await fakeCsms();
  const station = createStation({
    csmsUrl: csms.url,
    cpId: 'QA11-AC',
    spec: 'ac22:22',
    meterInterval: 1,
    speed: 20,
  });
  t.after(async () => {
    await station.close();
    await csms.server.close({ force: true });
  });
  await station.start();
  await sleep(300);

  const boot = csms.rx.find((m) => m.action === 'BootNotification');
  assert.equal(boot.params.chargePointModel, 'AC-22');
  const ids = new Set(
    csms.rx.filter((m) => m.action === 'StatusNotification').map((m) => m.params.connectorId),
  );
  assert.deepEqual([...ids].sort(), [0, 1]);
  const conf = await csms.client.call('GetConfiguration', { key: ['NumberOfConnectors'] });
  assert.equal(conf.configurationKey[0].value, '1');

  const snap = station.snapshot();
  assert.equal(snap.connectors.length, 1);
  assert.deepEqual(snap.spec, {
    kind: 'ac',
    ratedKw: 22,
    model: 'AC-22',
    reportsSoc: false,
    guns: 1,
  });
  assert.equal('unitPrice' in snap, false);
  assert.equal('cost' in snap.connectors[0], false);
  assert.equal(snap.connectors[0].maxKw, 22);

  // Không có súng 2; chế độ "Theo số tiền" không còn (trụ không biết giá).
  assert.equal((await station.act('plug', { connector: 2 })).ok, false);
  assert.equal((await station.act('mode', { connector: 1, type: 'money', value: 1000 })).ok, false);

  assert.equal((await station.act('plug', { connector: 1 })).ok, true);
  await sleep(100);
  assert.equal(station.snapshot().connectors[0].soc, null);
  assert.equal((await station.act('password', { connector: 1, password: '123456' })).ok, true);
  await sleep(1500);
  const c = station.snapshot().connectors[0];
  assert.ok(c.kw > 0 && c.kw <= 22, `kW ${c.kw}`);
  assert.ok(c.voltage === 400, `V ${c.voltage}`);
  const meters = csms.rx.filter((m) => m.action === 'MeterValues');
  assert.ok(meters.length > 0, 'có MeterValues');
  for (const m of meters) {
    const measurands = m.params.meterValue[0].sampledValue.map((v) => v.measurand);
    assert.equal(measurands.includes('SoC'), false);
    const w = Number(
      m.params.meterValue[0].sampledValue.find((v) => v.measurand === 'Power.Active.Import').value,
    );
    assert.ok(w <= 22000, `W ${w}`);
  }
});

test('trụ DC 150 kW, súng 2 tối đa 75 kW: hai súng cùng sạc thì súng 2 không vượt 75 kW', async (t) => {
  const csms = await fakeCsms();
  const station = createStation({
    csmsUrl: csms.url,
    cpId: 'QA11-DC',
    spec: 'dc150:150/75',
    meterInterval: 1,
  });
  t.after(async () => {
    await station.close();
    await csms.server.close({ force: true });
  });
  await station.start();
  await sleep(300);
  for (const connector of [1, 2]) {
    await station.act('plug', { connector });
    await station.act('password', { connector, password: '123456' });
  }
  await sleep(1300);
  const [a, b] = station.snapshot().connectors;
  assert.ok(a.kw > 0 && a.kw <= 75, `A ${a.kw}`); // 150 kW chia đôi
  assert.ok(b.kw > 0 && b.kw <= 75, `B ${b.kw}`);
  assert.ok(typeof a.soc === 'number', 'DC có SoC');
  await station.act('stop', { connector: 2 });
  await sleep(1300);
  const solo = station.snapshot().connectors[0];
  assert.ok(solo.kw > 75 && solo.kw <= 150, `A một mình ${solo.kw}`);
  const soc = csms.rx
    .filter((m) => m.action === 'MeterValues')
    .some((m) => m.params.meterValue[0].sampledValue.some((v) => v.measurand === 'SoC'));
  assert.equal(soc, true);
});
