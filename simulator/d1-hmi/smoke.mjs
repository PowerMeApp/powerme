// smoke.mjs — kiểm thử thật cho HMI trụ D1: dựng CSMS tối thiểu, chạy server.mjs, điều khiển qua
// HTTP, khẳng định CHUỖI BẢN TIN OCPP mà CSMS nhận được.
//
// LÀM GÌ
//   1. Dựng RPCServer ocpp-rpc (strictMode, cổng ngẫu nhiên) ngay trong script này.
//   2. Chạy `node server.mjs` làm tiến trình con, trỏ CSMS_URL vào đó (thời gian rút ngắn qua env:
//      MeterValues 1 s, thử lại 1 s, không mất mẫu khi phát lại để kết quả xác định).
//   3. Điều khiển bằng POST /api/... như HMI thật, in PASS/FAIL từng khẳng định, exit 1 nếu có FAIL.
// KHÔNG nằm trong CI. Chạy: node simulator/d1-hmi/smoke.mjs

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ocpp from 'ocpp-rpc';

const { RPCServer } = ocpp;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const HMI_PORT = 20000 + Math.floor(Math.random() * 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CSMS tối thiểu ──────────────────────────────────────────────────────────
const rx = []; // { action, params, conn, at }
let connCount = 0;
let cp = null; // RPCServerClient hiện tại
let nextTx = 100;
const known = new Set(['DEMO-CARD-0001', 'DEMO-WALLET-0001']);
const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true });
// Mô phỏng Security Profile 2: CSMS chỉ nhận khi Basic Auth có đúng mật khẩu (CP_PASSWORD của trụ).
const CP_SECRET = `smoke-${randomBytes(12).toString('hex')}`; // sinh lúc chạy, không phải literal
const authSeen = []; // mật khẩu nhận được ở mỗi lần bắt tay
server.auth((accept, reject, handshake) => {
  const pw = handshake.password?.toString('utf8');
  authSeen.push(pw);
  if (pw !== CP_SECRET) return reject(401, 'Invalid credential');
  accept();
});
server.on('client', (client) => {
  const conn = ++connCount;
  cp = client;
  const rec = (action) => (ctx) => {
    rx.push({ action, params: ctx.params, conn, at: Date.now() });
  };
  client.handle('BootNotification', (ctx) => {
    rec('BootNotification')(ctx);
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 };
  });
  client.handle('StatusNotification', (ctx) => (rec('StatusNotification')(ctx), {}));
  client.handle(
    'Heartbeat',
    (ctx) => (rec('Heartbeat')(ctx), { currentTime: new Date().toISOString() }),
  );
  client.handle('MeterValues', (ctx) => (rec('MeterValues')(ctx), {}));
  client.handle('Authorize', (ctx) => {
    rec('Authorize')(ctx);
    return { idTagInfo: { status: known.has(ctx.params.idTag) ? 'Accepted' : 'Invalid' } };
  });
  client.handle('StartTransaction', (ctx) => {
    rec('StartTransaction')(ctx);
    return { transactionId: nextTx++, idTagInfo: { status: 'Accepted' } };
  });
  client.handle(
    'StopTransaction',
    (ctx) => (rec('StopTransaction')(ctx), { idTagInfo: { status: 'Accepted' } }),
  );
});
const httpServer = await server.listen(0);
const csmsPort = httpServer.address().port;

// ── Tiện ích kiểm thử ───────────────────────────────────────────────────────
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function until(fn, ms = 10_000, label = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  console.log(`      (hết giờ chờ ${label})`);
  return false;
}
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${HMI_PORT}/api/${path}`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
};
const state = () => fetch(`http://127.0.0.1:${HMI_PORT}/api/state`).then((r) => r.json());
const count = (action, pred = () => true) =>
  rx.filter((m) => m.action === action && pred(m)).length;
const seq = () => rx.map((m) => m.action);

// ── Chạy trụ ────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, [`${HERE}server.mjs`], {
  env: {
    ...process.env,
    HMI_PORT: String(HMI_PORT),
    CSMS_URL: `ws://127.0.0.1:${csmsPort}/ocpp`,
    CP_ID: 'SMOKE-D1',
    CP_PASSWORD: CP_SECRET,
    METER_INTERVAL: '1',
    RETRY_MS: '1000',
    REPLAY_LOSS: '0',
    PING_SEC: '1',
    REBOOT_MS: '500',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

try {
  console.log(`CSMS thử nghiệm :${csmsPort}, HMI :${HMI_PORT}\n`);

  // 1. Khởi động: Boot → Status ×3 (connector 0, 1, 2)
  await until(() => count('StatusNotification') >= 3, 10_000, 'boot');
  const head = seq().slice(0, 4).join(',');
  check(
    'Khởi động: BootNotification rồi StatusNotification ×3',
    head === 'BootNotification,StatusNotification,StatusNotification,StatusNotification',
    head,
  );
  check(
    'Status ban đầu: connector 0,1,2 đều Available',
    rx
      .slice(1, 4)
      .map((m) => `${m.params.connectorId}:${m.params.status}`)
      .join(',') === '0:Available,1:Available,2:Available',
  );

  // 1b. File tĩnh của hình trụ minh hoạ (QA-02): phục vụ đúng, và không đọc được file ngoài whitelist
  const get = (p) => fetch(`http://127.0.0.1:${HMI_PORT}${p}`);
  const js = await get('/static/tru-sac.js');
  check(
    'Tĩnh: /static/tru-sac.js → 200, text/javascript',
    js.status === 200 && (js.headers.get('content-type') ?? '').startsWith('text/javascript'),
  );
  const css = await get('/static/tru-sac.css');
  check(
    'Tĩnh: /static/tru-sac.css → 200, text/css',
    css.status === 200 && (css.headers.get('content-type') ?? '').startsWith('text/css'),
  );
  const evil = ['/static/..%2fserver.mjs', '/static/%2e%2e/server.mjs', '/static/..%5cserver.mjs'];
  const evilCodes = [];
  for (const p of evil) evilCodes.push((await get(p)).status);
  check(
    'Tĩnh: đường dẫn có ".." / %2e / gạch chéo → 404',
    evilCodes.every((c) => c === 404),
    evilCodes.join(','),
  );
  check(
    'Tĩnh: file không có trong public/ hoặc sai đuôi → 404',
    (await get('/static/khong-co.js')).status === 404 &&
      (await get('/static/index.html')).status === 404,
  );
  const page = await (await get('/')).text();
  check(
    'Trang HMI có khối trụ + chú thích "Hình minh hoạ — không phải ảnh sản phẩm thật"',
    page.includes('id="tru"') && page.includes('Hình minh hoạ — không phải ảnh sản phẩm thật'),
  );

  // 2. Cắm súng A, quẹt thẻ hợp lệ
  await api('mode', { connector: 1, type: 'kwh', value: 5 });
  await api('plug', { connector: 1 });
  await until(() =>
    count(
      'StatusNotification',
      (m) => m.params.connectorId === 1 && m.params.status === 'Preparing',
    ),
  );
  check(
    'Cắm súng A → StatusNotification Preparing',
    count(
      'StatusNotification',
      (m) => m.params.connectorId === 1 && m.params.status === 'Preparing',
    ) === 1,
  );
  const bad = await api('swipe', { connector: 1, card: 'unknown' });
  check(
    'Thẻ lạ bị CSMS từ chối, KHÔNG có StartTransaction',
    !bad.ok && count('StartTransaction') === 0,
    bad.message,
  );
  const sw = await api('swipe', { connector: 1, card: 'valid' });
  await until(
    () =>
      count('StartTransaction') >= 1 &&
      count('StatusNotification', (m) => m.params.status === 'Charging') >= 1,
  );
  const iAuth = seq().indexOf('Authorize');
  const iStart = seq().indexOf('StartTransaction');
  check(
    'Quẹt thẻ → Authorize rồi StartTransaction',
    sw.ok && iAuth > 0 && iStart > iAuth,
    seq().slice(-5).join(','),
  );
  const start1 = rx.find((m) => m.action === 'StartTransaction');
  check(
    'meterStart là số nguyên Wh',
    Number.isInteger(start1.params.meterStart),
    String(start1.params.meterStart),
  );
  const tx1 = 100;
  await until(() => count('MeterValues') >= 3, 15_000, 'MeterValues');
  const mv = rx.find((m) => m.action === 'MeterValues');
  const energy = mv.params.meterValue[0].sampledValue.find(
    (s) => s.measurand === 'Energy.Active.Import.Register',
  );
  check('≥ 3 MeterValues khi đang sạc', count('MeterValues') >= 3, `${count('MeterValues')} bản`);
  check(
    'Energy là số nguyên, đơn vị Wh',
    /^\d+$/.test(energy.value) && energy.unit === 'Wh',
    `${energy.value} ${energy.unit}`,
  );
  check('MeterValues mang transactionId của phiên', mv.params.transactionId === tx1);

  // 3. Rớt mạng 5 s; trong lúc đó súng B tự mở phiên bằng thẻ ví (offline)
  const bootsBefore = count('Boot' + 'Notification');
  const connBefore = connCount;
  const dropAt = Date.now();
  await api('drop', { seconds: 5 });
  await until(async () => (await state()).net.state === 'offline', 5000, 'offline');
  const st0 = await state();
  check('Trụ báo offline sau khi rớt mạng', st0.net.state === 'offline');
  await api('plug', { connector: 2 });
  const swB = await api('swipe', { connector: 2, card: 'wallet' });
  check('Offline: thẻ ví vẫn được nhận theo danh sách cục bộ (giả định)', swB.ok, swB.message);
  await sleep(3000);
  const st1 = await state();
  check(
    'Hàng đợi tăng khi offline (MeterValues + Start)',
    st1.queue.total >= 3 && st1.queue.byAction.StartTransaction === 1,
    JSON.stringify(st1.queue),
  );
  const mvDuring = count('MeterValues');
  check('Không bản tin nào đến CSMS trong lúc offline', count('StartTransaction') === 1);

  // 4. Nối lại
  await until(() => connCount > connBefore && count('StartTransaction') >= 2, 15_000, 'nối lại');
  const reconnectAt = rx.find((m) => m.conn > connBefore)?.at ?? Date.now();
  await sleep(1500);
  check(
    'Nối lại bằng socket mới (epoch mới)',
    connCount === connBefore + 1 && (await state()).net.epoch === 2,
    `conn=${connCount}`,
  );
  check(
    'Nối lại KHÔNG gửi BootNotification',
    count('BootNotification') === bootsBefore,
    `Boot=${count('BootNotification')}`,
  );
  if (process.env.DBG)
    console.log(
      (await state()).timeline.map((t) => t.text),
      rx.map((m) => m.conn + m.action).join(' '),
    );
  const after = rx.filter((m) => m.conn > connBefore);
  const iStartB = after.findIndex(
    (m) => m.action === 'StartTransaction' && m.params.connectorId === 2,
  );
  const iFirstMv = after.findIndex((m) => m.action === 'MeterValues');
  check(
    'Phát bù: bản tin giao dịch/trạng thái trước, MeterValues cũ sau (như EXP-01)',
    iStartB >= 0 && iFirstMv > iStartB,
    after
      .slice(0, 5)
      .map((m) => m.action)
      .join(','),
  );
  const startB = rx.find((m) => m.action === 'StartTransaction' && m.params.connectorId === 2);
  check(
    'StartTransaction buffer giữ timestamp gốc (trước lúc nối lại)',
    Date.parse(startB.params.timestamp) < reconnectAt - 500,
    `${startB.params.timestamp} < ${new Date(reconnectAt).toISOString()}`,
  );
  const replayed = rx.filter(
    (m) =>
      m.action === 'MeterValues' &&
      m.conn > connBefore &&
      Date.parse(m.params.meterValue[0].timestamp) < reconnectAt - 500,
  );
  check(
    'MeterValues phát bù có timestamp cũ (≥ 2 mẫu)',
    replayed.length >= 2,
    `${replayed.length} mẫu cũ, ${mvDuring} trước đó`,
  );
  check(
    'MeterValues súng B mang transactionId do CSMS cấp sau nối lại',
    rx.some(
      (m) =>
        m.action === 'MeterValues' && m.params.connectorId === 2 && m.params.transactionId === 101,
    ),
  );
  check('Sau phát bù hàng đợi rỗng', (await state()).queue.total === 0);
  check('Thời gian rớt ≈ 5 s thật', Date.now() - dropAt > 4500);

  // 5. Lệnh từ CSMS
  const wrong = await cp.call('RemoteStopTransaction', { transactionId: 9999 });
  check('RemoteStop sai transactionId → Rejected', wrong.status === 'Rejected');
  const busy = await cp.call('RemoteStartTransaction', { idTag: 'DEMO-CARD-0001', connectorId: 1 });
  check('RemoteStart súng đang bận → Rejected', busy.status === 'Rejected');
  const cfg = await cp.call('GetConfiguration', { key: ['MeterValueSampleInterval', 'NoSuchKey'] });
  check(
    'GetConfiguration trả key hỗ trợ + unknownKey',
    cfg.configurationKey[0].value === '1' && cfg.unknownKey[0] === 'NoSuchKey',
  );
  const rs = await cp.call('RemoteStopTransaction', { transactionId: 101 });
  await until(() => count('StopTransaction', (m) => m.params.transactionId === 101));
  const stopB = rx.find((m) => m.action === 'StopTransaction' && m.params.transactionId === 101);
  check(
    'RemoteStop đúng id → Accepted rồi StopTransaction reason Remote',
    rs.status === 'Accepted' && stopB?.params.reason === 'Remote',
  );

  // 6. Dừng tại trụ
  const lastMeter = () =>
    rx.filter((m) => m.action === 'MeterValues' && m.params.transactionId === tx1).at(-1);
  const stp = await api('stop', { connector: 1 });
  await until(() => count('StopTransaction', (m) => m.params.transactionId === tx1));
  const stop1 = rx.find((m) => m.action === 'StopTransaction' && m.params.transactionId === tx1);
  check('Dừng tại trụ → StopTransaction reason Local', stp.ok && stop1?.params.reason === 'Local');
  const lastE = Number(
    lastMeter().params.meterValue[0].sampledValue.find(
      (s) => s.measurand === 'Energy.Active.Import.Register',
    ).value,
  );
  check(
    'meterStop ≥ chỉ số MeterValues cuối, là số nguyên',
    Number.isInteger(stop1.params.meterStop) && stop1.params.meterStop >= lastE,
    `${stop1.params.meterStop} ≥ ${lastE}`,
  );
  const fin = rx
    .filter((m) => m.action === 'StatusNotification' && m.params.connectorId === 1)
    .map((m) => m.params.status);
  check(
    'Trình tự trạng thái súng A: Preparing → Charging → Finishing',
    fin.slice(-3).join(',') === 'Preparing,Charging,Finishing' ||
      fin.join(',').includes('Preparing,Charging,Finishing'),
    fin.join('→'),
  );
  await api('unplug', { connector: 1 });
  await api('unplug', { connector: 2 });
  await until(
    () =>
      count(
        'StatusNotification',
        (m) => m.params.connectorId === 1 && m.params.status === 'Available',
      ) >= 2,
  );
  check(
    'Rút súng sau phiên → Available',
    rx.filter((m) => m.action === 'StatusNotification' && m.params.connectorId === 1).at(-1).params
      .status === 'Available',
  );

  // 7. Lỗi súng
  await api('fault', { connector: 1, errorCode: 'GroundFailure' });
  await until(() => count('StatusNotification', (m) => m.params.status === 'Faulted'));
  const f = rx.find((m) => m.action === 'StatusNotification' && m.params.status === 'Faulted');
  check('Gây lỗi → Faulted với errorCode GroundFailure', f?.params.errorCode === 'GroundFailure');
  await api('clearfault', { connector: 1 });
  await sleep(300);
  check(
    'Xoá lỗi → Available',
    rx.at(-1).params.status === 'Available' && rx.at(-1).params.errorCode === 'NoError',
  );

  // 8. Half-open: phát hiện nhờ ping timeout, nối lại không Boot
  const connHO = connCount;
  await api('halfopen', { seconds: 2 });
  const sHO = await state();
  check('Half-open: trụ ban đầu vẫn tưởng online', sHO.net.state === 'online' && sHO.net.halfOpen);
  await until(() => connCount > connHO, 20_000, 'half-open nối lại');
  check(
    'Half-open: ping timeout → tự nối lại, không Boot',
    connCount === connHO + 1 && count('BootNotification') === bootsBefore,
  );

  // 8b. Basic Auth: mọi lần bắt tay (kể cả nối lại sau rớt mạng) đều mang CP_PASSWORD
  check(
    'Basic Auth: mọi bắt tay mang đúng CP_PASSWORD, CSMS (từ chối sai mật khẩu) vẫn nhận kết nối',
    authSeen.length >= 2 && authSeen.every((pw) => pw === CP_SECRET),
    `${authSeen.length} lần bắt tay`,
  );

  // 9. Reboot: nối lại và gửi Boot
  const bootsPre = count('BootNotification');
  await api('reboot');
  await until(() => count('BootNotification') > bootsPre, 15_000, 'reboot');
  check('Reboot → BootNotification mới', count('BootNotification') === bootsPre + 1);
} catch (e) {
  failed++;
  console.log('FAIL  ngoại lệ trong smoke test:', e);
} finally {
  child.kill();
  await server.close().catch(() => {});
  console.log(failed ? `\n${failed} khẳng định FAIL` : '\nTất cả khẳng định PASS');
  process.exit(failed ? 1 : 0);
}
