import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHmiActions } from './hmi-actions.mjs';
import { isReaderFrame, maskReaderText } from './rfid-reader.mjs';

const TAG = '0000012345';
const accepted = { idTagInfo: { status: 'Accepted' } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness(authorize = async () => accepted) {
  const make = (id) => ({
    id,
    plugged: true,
    status: 'Preparing',
    fault: null,
    errorCode: 'NoError',
    inoperative: false,
    tx: null,
    readerGeneration: 0,
  });
  const conns = new Map([
    [1, make(1)],
    [2, make(2)],
  ]);
  const sent = [],
    starts = [],
    steps = [];
  const net = { state: 'online', epoch: 1, booted: true, halfOpen: false };
  const actions = makeHmiActions({
    conns,
    net,
    opt: {},
    changed() {},
    tl() {},
    jStep(c, kind, info, opts) {
      steps.push({ connector: c.id, kind, ...info, close: !!opts?.close });
    },
    idleStatus: (c) => (c.plugged ? 'Preparing' : 'Available'),
    async setStatus(c, status) {
      c.status = status;
      c.readerGeneration++;
    },
    async emit(action, payload, options) {
      sent.push({ action, payload, options });
      return authorize(payload);
    },
    async startTx(c, idTag, source) {
      starts.push({ connector: c.id, idTag, source });
      c.tx = { id: 7 };
      c.status = 'Charging';
      return true;
    },
    async stopTx(c) {
      c.tx = null;
    },
  });
  const scan = (body = {}) => actions.swipeReader({ connector: 1, idTag: TAG, ...body });
  return { actions, conns, sent, starts, steps, net, scan };
}

test('device profile accepts only exact ASCII strings without normalization', () => {
  assert.equal(isReaderFrame(TAG), true);
  for (const value of [
    '',
    '123456789',
    '12345678901',
    ' 0000012345',
    '0000012345 ',
    '0000012345\n',
    '0000012345\r',
    '00000\t12345',
    '<12345678>',
    '１２３４５６７８９０',
    [TAG],
    12345,
    {},
    null,
    undefined,
  ])
    assert.equal(isReaderFrame(value), false);
});

test('masking removes physical identifiers without changing fixture labels', () => {
  assert.equal(maskReaderText(JSON.stringify({ idTag: TAG })), '{"idTag":"[reader identifier]"}');
  assert.equal(maskReaderText('DEMO-CARD-0001'), 'DEMO-CARD-0001');
});

test('exact leading-zero idTag is authorized before a single RFID start', async () => {
  const h = harness();
  assert.equal((await h.scan()).ok, true);
  assert.deepEqual(h.sent, [
    { action: 'Authorize', payload: { idTag: TAG }, options: { buffer: false } },
  ]);
  assert.deepEqual(h.starts, [{ connector: 1, idTag: TAG, source: 'rfid' }]);
  assert.equal(h.conns.get(1).readerPending, false);
});

test('malformed or ambiguous physical requests never send OCPP', async () => {
  const h = harness();
  for (const body of [
    null,
    [],
    1,
    TAG,
    {},
    { connector: '1', idTag: TAG },
    { connector: 0, idTag: TAG },
    { connector: 1, idTag: [TAG] },
    { connector: 1, idTag: TAG, card: 'valid' },
    { connector: 1, idTag: TAG, source: 'fixture' },
    { connector: 1, idTag: TAG, extra: true },
    { connector: 1, idTag: '123456789' },
  ]) {
    assert.equal((await h.actions.swipeReader(body)).ok, false);
  }
  assert.equal(h.sent.length, 0);
});

for (const status of ['Invalid', 'Blocked', 'Expired', 'ConcurrentTx']) {
  test('CSMS ' + status + ' does not start or map to fixture', async () => {
    const h = harness(async () => ({ idTagInfo: { status } }));
    const result = await h.scan();
    assert.equal(result.code, 'rejected');
    assert.ok(result.message.includes(status));
    assert.equal(h.starts.length, 0);
    assert.equal(h.sent[0].payload.idTag, TAG);
    assert.equal(h.conns.get(1).readerPending, false);
  });
}

for (const response of [null, {}, { idTagInfo: { status: 'Unexpected' } }]) {
  test('absent or unrecognized authorization stays uncertain', async () => {
    const h = harness(async () => response);
    assert.equal((await h.scan()).code, 'network');
    assert.equal(h.starts.length, 0);
    assert.equal(h.conns.get(1).readerPending, false);
  });
}

test('duplicate pending swipes are locked before the authorization await', async () => {
  const wait = deferred(),
    h = harness(() => wait.promise);
  const first = h.scan();
  assert.equal(h.conns.get(1).readerPending, true);
  assert.equal((await h.scan()).code, 'busy');
  assert.equal(h.sent.length, 1);
  wait.resolve(accepted);
  await first;
  assert.equal(h.starts.length, 1);
  assert.equal((await h.scan()).ok, false);
});

test('two connector authorizations are independent', async () => {
  const wait = deferred(),
    h = harness(() => wait.promise);
  const first = h.scan(),
    second = h.scan({ connector: 2 });
  assert.equal(h.sent.length, 2);
  wait.resolve(accepted);
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(h.starts.length, 2);
});

for (const change of [
  (h) => {
    h.conns.get(1).plugged = false;
  },
  (h) => {
    h.conns.get(1).fault = 'GroundFailure';
  },
  (h) => {
    h.conns.get(1).inoperative = true;
  },
  (h) => {
    h.conns.get(1).status = 'Finishing';
  },
  (h) => {
    h.conns.get(1).tx = { id: 9 };
  },
  (h) => {
    h.net.state = 'offline';
  },
  (h) => {
    h.net.halfOpen = true;
  },
  (h) => {
    h.net.booted = false;
  },
]) {
  test('unsafe connector or network prevents any authorization', async () => {
    const h = harness();
    change(h);
    assert.equal((await h.scan()).ok, false);
    assert.equal(h.sent.length, 0);
  });
  test('state changed while authorizing cannot use stale Accepted', async () => {
    const wait = deferred(),
      h = harness(() => wait.promise);
    const pending = h.scan();
    change(h);
    wait.resolve(accepted);
    assert.equal((await pending).code, 'stale');
    assert.equal(h.starts.length, 0);
    assert.equal(h.conns.get(1).readerPending, false);
  });
}

test('unplug and replug while authorizing invalidates the physical attempt', async () => {
  const wait = deferred(),
    h = harness(() => wait.promise);
  const pending = h.scan();
  await h.actions.unplug({ connector: 1 });
  await h.actions.plug({ connector: 1 });
  wait.resolve(accepted);
  assert.equal((await pending).code, 'stale');
  assert.equal(h.starts.length, 0);
});

test('network reconnect epoch cannot reuse an earlier Accepted', async () => {
  const wait = deferred(),
    h = harness(() => wait.promise);
  const pending = h.scan();
  h.net.epoch++;
  wait.resolve(accepted);
  assert.equal((await pending).code, 'stale');
  assert.equal(h.starts.length, 0);
});

test('authorization exception releases lock and allows a fresh retry', async () => {
  let calls = 0;
  const h = harness(async () => {
    if (++calls === 1) throw new Error('timeout');
    return accepted;
  });
  assert.equal((await h.scan()).code, 'network');
  assert.equal(h.conns.get(1).readerPending, false);
  assert.equal((await h.scan()).ok, true);
  assert.equal(h.starts.length, 1);
});

test('masking preserves transaction ids, meter readings and timestamps', () => {
  const text = JSON.stringify({
    idTag: TAG,
    parentIdTag: TAG,
    transactionId: 1234567890,
    meterStart: 1234567890123,
    meterStop: 9999999999,
    timestamp: '2026-11-24T00:00:00Z',
  });
  const masked = JSON.parse(maskReaderText(text));
  assert.equal(masked.transactionId, 1234567890);
  assert.equal(masked.meterStart, 1234567890123);
  assert.equal(masked.meterStop, 9999999999);
  assert.equal(masked.timestamp, '2026-11-24T00:00:00Z');
  assert.equal(masked.parentIdTag, '[reader identifier]');
});

test('reader journey steps never carry the raw identifier and mark the reader source', async () => {
  const h = harness(async (payload) =>
    payload.idTag === TAG ? accepted : { idTagInfo: { status: 'Invalid' } },
  );
  assert.equal((await h.scan()).code, 'started');
  h.conns.get(2).tx = null;
  assert.equal((await h.scan({ connector: 2, idTag: '0000099999' })).code, 'rejected');
  assert.deepEqual(h.steps, [
    {
      connector: 1,
      kind: 'authorize',
      idTag: '[reader identifier]',
      status: 'Accepted',
      reader: true,
      close: false,
    },
    {
      connector: 2,
      kind: 'authorize',
      idTag: '[reader identifier]',
      status: 'Invalid',
      reader: true,
      close: true,
    },
  ]);
  assert.equal(JSON.stringify(h.steps).includes(TAG), false);
});
