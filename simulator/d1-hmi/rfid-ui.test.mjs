import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('./public/rfid-reader.js', import.meta.url), 'utf8');
const TAG = '0000012345';
function surface(fetch) {
  const listeners = {};
  const input = {
    value: '',
    disabled: false,
    setAttribute() {},
    addEventListener(name, fn) {
      listeners[name] = fn;
    },
  };
  const clear = {},
    message = { classList: { toggle() {} } };
  const window = {};
  vm.runInNewContext(code, { window, fetch });
  const update = window.bindRfidReader(input, clear, message, 2);
  const state = { net: { state: 'online', booted: true, epoch: 1, halfOpen: false } };
  const gun = {
    plugged: true,
    status: 'Preparing',
    errorCode: 'NoError',
    txActive: false,
    inoperative: false,
  };
  update(state, gun, true);
  const enter = (extra = {}) => listeners.keydown({ key: 'Enter', preventDefault() {}, ...extra });
  return { input, clear, message, listeners, update, enter, state, gun };
}

test('reader listens only on its own input; Enter preserves exact string and gun', async () => {
  const calls = [];
  const h = surface(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, message: 'confirmed' }) };
  });
  assert.deepEqual(Object.keys(h.listeners).sort(), ['blur', 'keydown']);
  h.input.value = TAG;
  await h.listeners.keydown({ key: 'a' });
  assert.equal(calls.length, 0);
  await h.enter();
  assert.deepEqual(calls, [{ url: '/api/swipeReader', body: { connector: 2, idTag: TAG } }]);
  assert.equal(h.input.value, '');
  assert.equal(h.message.textContent, 'confirmed');
});

test('reader clears malformed, trailing LF, modified or composing Enter without POST', async () => {
  let calls = 0;
  const h = surface(async () => {
    calls++;
  });
  for (const value of ['', '123456789', TAG + '\n', TAG + ' ', TAG + TAG, '<script>']) {
    h.input.value = value;
    await h.enter();
    assert.equal(h.input.value, '');
  }
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing', 'repeat']) {
    h.input.value = TAG;
    await h.enter({ [flag]: true });
  }
  assert.equal(calls, 0);
});

test('pending field stays disabled across SSE updates and duplicate Enter', async () => {
  let finish,
    calls = 0;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const h = surface(async () => {
    calls++;
    return wait;
  });
  h.input.value = TAG;
  const first = h.enter();
  assert.equal(h.input.disabled, true);
  assert.equal(h.clear.disabled, true);
  assert.equal(h.input.value, '');
  h.update(h.state, h.gun, true);
  assert.equal(h.input.disabled, true);
  await h.enter();
  assert.equal(calls, 1);
  finish({ json: async () => ({ ok: false, message: 'rejected' }) });
  await first;
  assert.equal(h.input.disabled, false);
  assert.equal(h.message.textContent, 'rejected');
});

test('SSE network, gun, pending and disconnect states disable and clear the field', () => {
  const h = surface(async () => {});
  for (const [network, gun, connected] of [
    [{ state: 'offline' }, {}, true],
    [{ halfOpen: true }, {}, true],
    [{ booted: false }, {}, true],
    [{}, { plugged: false }, true],
    [{}, { status: 'Finishing' }, true],
    [{}, { txActive: true }, true],
    [{}, { inoperative: true }, true],
    [{}, { readerPending: true }, true],
    [{}, {}, false],
  ]) {
    h.input.value = TAG;
    h.update({ net: { ...h.state.net, ...network } }, { ...h.gun, ...gun }, connected);
    assert.equal(h.input.disabled, true);
    assert.equal(h.input.value, '');
    h.update(h.state, h.gun, true);
    assert.equal(h.input.disabled, false);
  }
});

test('blur clears partial frame and fetch failure reports uncertain outcome', async () => {
  const h = surface(async () => {
    throw new Error('lost HTTP response');
  });
  h.input.value = '123';
  h.listeners.blur();
  assert.equal(h.input.value, '');
  h.input.value = TAG;
  await h.enter();
  assert.ok(h.message.textContent.includes('chưa xác định'));
  assert.equal(h.input.value, '');
  assert.equal(h.input.disabled, false);
});
