// smoke.mjs — kiểm thử thật cho HMI trụ D1: dựng CSMS tối thiểu, chạy server.mjs, điều khiển qua
// HTTP, khẳng định CHUỖI BẢN TIN OCPP mà CSMS nhận được.
//
// LÀM GÌ
//   1. Dựng RPCServer ocpp-rpc (strictMode, cổng ngẫu nhiên) ngay trong script này.
//   2. Chạy `node server.mjs` làm tiến trình con, trỏ CSMS_URL vào đó (thời gian rút ngắn qua env:
//      MeterValues 1 s, thử lại 1 s, không mất mẫu khi phát lại để kết quả xác định).
//   3. Điều khiển bằng POST /api/... như HMI thật, in PASS/FAIL từng khẳng định, exit 1 nếu có FAIL.
//   4. (QA-03) Chạy thêm MỘT tiến trình server.mjs với HAI trụ (CP_IDS): mỗi trụ boot riêng,
//      RemoteStart vào trụ 2 không ảnh hưởng trụ 1, API/SSE/trang theo cpId, tốc độ ×20.
//   CSMS giả tách bản tin theo identity: phần 1–9 chỉ nhìn trụ SMOKE-D1 (đường API cũ).
// KHÔNG nằm trong CI. Chạy: node simulator/d1-hmi/smoke.mjs

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
const known = new Set(['DEMO-CARD-0001', 'DEMO-CARD-0002']);
const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true });
// Mô phỏng Security Profile 2: CSMS chỉ nhận khi Basic Auth có đúng mật khẩu (CP_PASSWORD của trụ).
const secret = () => `smoke-${randomBytes(12).toString('hex')}`; // sinh lúc chạy, không phải literal
const CP_SECRET = secret();
const PW = { 'SMOKE-D1': CP_SECRET, 'SMOKE-M1': secret(), 'SMOKE-M2': secret() };
const authSeen = []; // mật khẩu SMOKE-D1 gửi ở mỗi lần bắt tay
const authOther = []; // [identity, đúng mật khẩu?] của các trụ phần 10
server.auth((accept, reject, handshake) => {
  const pw = handshake.password?.toString('utf8');
  if (handshake.identity === 'SMOKE-D1') authSeen.push(pw);
  else authOther.push([handshake.identity, pw === PW[handshake.identity]]);
  if (!PW[handshake.identity] || pw !== PW[handshake.identity])
    return reject(401, 'Invalid credential');
  accept();
});
const rxBy = {}; // identity khác SMOKE-D1 → bản tin nhận được
const cpBy = {}; // identity → RPCServerClient hiện tại
server.on('client', (client) => {
  const main = client.identity === 'SMOKE-D1';
  const conn = main ? ++connCount : 0;
  if (main) cp = client;
  cpBy[client.identity] = client;
  const sink = main ? rx : (rxBy[client.identity] ??= []);
  const rec = (action) => (ctx) => {
    sink.push({ action, params: ctx.params, conn, at: Date.now() });
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

// ── 10. Nhiều trụ trong một tiến trình (QA-03) ─────────────────────────────
let child2 = null;
async function multiStation() {
  console.log('\n— Nhiều trụ: CP_IDS=SMOKE-M1,SMOKE-M2 —');
  const PORT2 = HMI_PORT + 1;
  child2 = spawn(process.execPath, [`${HERE}server.mjs`], {
    env: {
      ...process.env,
      HMI_PORT: String(PORT2),
      CSMS_URL: `ws://127.0.0.1:${csmsPort}/ocpp`,
      CP_IDS: 'SMOKE-M1,SMOKE-M2',
      CP_PASSWORDS: `${PW['SMOKE-M1']},${PW['SMOKE-M2']}`,
      METER_INTERVAL: '1',
      RETRY_MS: '1000',
      REPLAY_LOSS: '0',
      PING_SEC: '5',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${PORT2}`;
  const g = (p) => fetch(base + p);
  const st = (id) => g(`/api/${id}/state`).then((r) => r.json());
  const apiM = async (id, path, body) =>
    (
      await fetch(`${base}/api/${id}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
    ).json();
  const m = (id, action, pred = () => true) =>
    (rxBy[id] ?? []).filter((x) => x.action === action && pred(x));
  const M1 = 'SMOKE-M1';
  const M2 = 'SMOKE-M2';

  await until(
    () => m(M1, 'StatusNotification').length >= 3 && m(M2, 'StatusNotification').length >= 3,
    15_000,
    'hai trụ boot',
  );
  const heads = [M1, M2].map((id) =>
    (rxBy[id] ?? [])
      .slice(0, 4)
      .map((x) => x.action)
      .join(','),
  );
  check(
    'Hai trụ: MỖI trụ có socket riêng, Boot rồi Status ×3 của riêng nó',
    heads.every(
      (h) => h === 'BootNotification,StatusNotification,StatusNotification,StatusNotification',
    ) &&
      cpBy[M1] &&
      cpBy[M2] &&
      cpBy[M1] !== cpBy[M2],
    heads.join(' | '),
  );
  check(
    'Hai trụ: mỗi trụ bắt tay bằng đúng mật khẩu của nó (CP_PASSWORDS cùng thứ tự)',
    authOther.length >= 2 && authOther.every(([, ok]) => ok),
    authOther.map(([id, ok]) => `${id}:${ok}`).join(','),
  );
  const tong = await (await g('/api/tong')).json();
  check(
    'GET /api/tong liệt kê 2 trụ, cả hai online',
    tong.stations.map((x) => `${x.cpId}:${x.net.state}`).join(',') ===
      'SMOKE-M1:online,SMOKE-M2:online',
    JSON.stringify(tong.stations.map((x) => x.cpId)),
  );
  const pg = await g(`/tru/${M2}`);
  const pgText = await pg.text();
  check(
    'GET /tru/SMOKE-M2 → trang trụ (có khối "Phiên sạc trên trụ này")',
    pg.status === 200 && pgText.includes('id="phien"'),
  );
  const bad = [
    '/tru/SMOKE-NOPE',
    '/tru/%3Cscript%3E',
    '/api/SMOKE-NOPE/state',
    '/api/..%2fSMOKE-M1/state',
    '/events/SMOKE-NOPE',
  ];
  const badCodes = [];
  for (const p of bad) badCodes.push((await g(p)).status);
  const badPost = await fetch(`${base}/api/SMOKE-NOPE/plug`, { method: 'POST', body: '{}' });
  check(
    'cpId lạ / có ".." / thẻ HTML → 404 (trang, API, SSE, POST)',
    badCodes.every((c) => c === 404) && badPost.status === 404,
    [...badCodes, badPost.status].join(','),
  );
  // SSE theo trụ: chỉ đọc gói "hello" đầu tiên
  const ac = new AbortController();
  const sse = await fetch(`${base}/events/${M2}`, { signal: ac.signal });
  const reader = sse.body.getReader();
  let buf = '';
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const hello = JSON.parse(
    buf
      .split('\n')
      .find((l) => l.startsWith('data: '))
      .slice(6),
  );
  check(
    'SSE /events/SMOKE-M2: gói hello là snapshot của SMOKE-M2 (kèm nhật ký + điểm biểu đồ)',
    hello.state.cpId === M2 && Array.isArray(hello.log) && typeof hello.series === 'object',
  );
  check(
    'Đường cũ /api/state của tiến trình nhiều trụ = trụ đầu tiên',
    (await (await g('/api/state')).json()).cpId === M1,
  );

  // RemoteStart vào súng 1 của trụ 2 khi CHƯA cắm súng → Accepted, chờ cắm
  const n1Before = (rxBy[M1] ?? []).length;
  const rs = await cpBy[M2].call('RemoteStartTransaction', {
    idTag: 'DEMO-CARD-0002',
    connectorId: 1,
  });
  const s2 = await st(M2);
  const s1 = await st(M1);
  check(
    'RemoteStart vào trụ 2 (chưa cắm) → Accepted, trụ 2 chờ cắm súng, hành trình có bước remoteStart',
    rs.status === 'Accepted' &&
      s2.connectors[0].remoteWaitSec > 0 &&
      s2.connectors[0].journeys.at(-1)?.steps[0]?.kind === 'remoteStart',
  );
  check(
    'Trụ 1 không bị ảnh hưởng: không chờ cắm, không có hành trình',
    s1.connectors.every((c) => c.remoteWaitSec == null && c.journeys.length === 0),
  );
  await apiM(M2, 'plug', { connector: 1 });
  await until(() => m(M2, 'StartTransaction').length >= 1, 10_000, 'StartTransaction trụ 2');
  const start2 = m(M2, 'StartTransaction')[0];
  check(
    'Cắm súng trụ 2 → trụ 2 gửi StartTransaction với idTag của RemoteStart',
    start2?.params.idTag === 'DEMO-CARD-0002' && start2.params.connectorId === 1,
  );
  check(
    'Trụ 1 không gửi StartTransaction / StatusNotification nào trong lúc đó',
    m(M1, 'StartTransaction').length === 0 &&
      (rxBy[M1] ?? []).slice(n1Before).every((x) => x.action === 'Heartbeat'),
  );
  await until(async () => (await st(M2)).connectors[0].txId != null, 5000, 'txId trụ 2');

  // Tốc độ ×20 riêng trụ 2
  const bad5 = await apiM(M2, 'speed', { value: 5 });
  const sp = await apiM(M2, 'speed', { value: 20 });
  check('Tốc độ: ×5 bị từ chối, ×20 nhận', !bad5.ok && sp.ok, `${bad5.message} / ${sp.message}`);
  const mvFrom = m(M2, 'MeterValues').length;
  await sleep(3000);
  const mv20 = m(M2, 'MeterValues').slice(mvFrom + 1); // bỏ mẫu đầu (đang chuyển tốc độ)
  const ts = (x) => Date.parse(x.params.meterValue[0].timestamp);
  const ratio =
    mv20.length >= 2 ? (ts(mv20.at(-1)) - ts(mv20[0])) / (mv20.at(-1).at - mv20[0].at) : 0;
  check(
    '×20: timestamp MeterValues của trụ 2 chạy ~20 lần giờ thật',
    ratio > 14 && ratio < 26,
    `${mv20.length} mẫu, tỉ lệ ${ratio.toFixed(1)}`,
  );
  const [a2, a1] = [await st(M2), await st(M1)];
  check(
    '×20 chỉ áp cho trụ 2: trụ 2 speed 20, đồng hồ đi trước giờ thật; trụ 1 vẫn ×1',
    a2.speed === 20 && a2.clockAheadSec > 20 && a1.speed === 1 && Math.abs(a1.clockAheadSec) < 2,
    `M2 lệch ${a2.clockAheadSec}s, M1 lệch ${a1.clockAheadSec}s`,
  );
  check(
    'Trang trụ có thời gian mô phỏng VÀ thời gian thật của phiên',
    a2.connectors[0].elapsed > a2.connectors[0].realElapsed * 5 &&
      a2.connectors[0].realElapsed >= 3,
    `mô phỏng ${a2.connectors[0].elapsed}s / thật ${a2.connectors[0].realElapsed}s`,
  );
  const busy = await apiM(M2, 'syncclock');
  check('Về giờ thật bị từ chối khi đang có phiên', !busy.ok);

  // RemoteStop trụ 2 → StopTransaction; hành trình đủ bước
  const tx2 = a2.connectors[0].txId;
  const rstop = await cpBy[M2].call('RemoteStopTransaction', { transactionId: tx2 });
  await until(() => m(M2, 'StopTransaction').length >= 1, 5000, 'StopTransaction trụ 2');
  await sleep(300);
  const stop2 = m(M2, 'StopTransaction')[0];
  check(
    'RemoteStop trụ 2 → StopTransaction reason Remote, meterStop > meterStart',
    rstop.status === 'Accepted' &&
      stop2?.params.reason === 'Remote' &&
      stop2.params.meterStop > start2.params.meterStart,
  );
  const j = (await st(M2)).connectors[0].journeys.at(-1);
  const kinds = j.steps.map((x) => x.kind).join(',');
  check(
    'Hành trình phiên trụ 2: remoteStart → startSent → startResult → charging → remoteStop → stopSent → stopResult',
    kinds === 'remoteStart,startSent,startResult,charging,remoteStop,stopSent,stopResult' &&
      j.summary?.meterStop === stop2.params.meterStop &&
      j.summary.txId === tx2,
    kinds,
  );
  check('Trụ 1 vẫn không có phiên nào', m(M1, 'StopTransaction').length === 0);
  await apiM(M2, 'speed', { value: 1 });
  const sync = await apiM(M2, 'syncclock');
  check(
    'Về giờ thật sau phiên: đồng hồ trụ 2 khớp giờ thật',
    sync.ok && Math.abs((await st(M2)).clockAheadSec) < 2,
  );
}

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
  const page = await (await get('/tru/SMOKE-D1')).text();
  check(
    'Trang trụ /tru/SMOKE-D1 có khối trụ + chú thích "Hình minh hoạ — không phải ảnh sản phẩm thật"',
    page.includes('id="tru"') && page.includes('Hình minh hoạ — không phải ảnh sản phẩm thật'),
  );
  const tongPage = await (await get('/')).text();
  check('Trang tổng "/" là danh sách trụ', tongPage.includes('/tong/events'));
  // three.js cho hình 3D: chỉ đúng hai file, từ node_modules
  const three = await get('/vendor/three/three.module.js');
  check(
    'Vendor: /vendor/three/three.module.js → 200 JS (three là devDependency ở gốc repo)',
    three.status === 200 && (three.headers.get('content-type') ?? '').startsWith('text/javascript'),
    String(three.status),
  );
  const vendEvil = [
    '/vendor/three/three.cjs',
    '/vendor/three/..%2fpackage.json',
    '/vendor/three/%2e%2e',
    '/vendor/three/..%5c..%5cpackage.json',
  ];
  const vendCodes = [];
  for (const p of vendEvil) vendCodes.push((await get(p)).status);
  check(
    'Vendor: file ngoài danh sách / có ".." → 404',
    vendCodes.every((c) => c === 404),
    vendCodes.join(','),
  );
  // Bundle hình 3D React (QA-04): đúng một file tên cố định; chưa build thì 404 (trang về 2D)
  const built = existsSync(new URL('./tru3d/dist/tru3d.js', import.meta.url));
  const t3 = await get('/tru3d/tru3d.js');
  check(
    `Tru3d: /tru3d/tru3d.js → ${built ? '200 JS (đã build)' : '404 (chưa build → hình 2D)'}`,
    built
      ? t3.status === 200 && (t3.headers.get('content-type') ?? '').startsWith('text/javascript')
      : t3.status === 404,
    String(t3.status),
  );
  const t3Codes = [];
  for (const p of [
    '/tru3d/index.html',
    '/tru3d/..%2fvite.config.mjs',
    '/tru3d/..%2f..%2fpackage.json',
    '/tru3d/src/main.jsx',
    '/tru3d/dist/tru3d.js',
  ])
    t3Codes.push((await get(p)).status);
  check(
    'Tru3d: file ngoài danh sách / có ".." / thư mục con → 404',
    t3Codes.every((c) => c === 404),
    t3Codes.join(','),
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

  // 3. Rớt mạng 5 s; trong lúc đó súng B tự mở phiên bằng thẻ hợp lệ thứ hai (offline)
  const bootsBefore = count('Boot' + 'Notification');
  const connBefore = connCount;
  const dropAt = Date.now();
  await api('drop', { seconds: 5 });
  await until(async () => (await state()).net.state === 'offline', 5000, 'offline');
  const st0 = await state();
  check('Trụ báo offline sau khi rớt mạng', st0.net.state === 'offline');
  await api('plug', { connector: 2 });
  const swB = await api('swipe', { connector: 2, card: 'valid2' });
  check(
    'Offline: thẻ đã đăng ký vẫn được nhận theo danh sách cục bộ (giả định)',
    swB.ok,
    swB.message,
  );
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

  await multiStation();
} catch (e) {
  failed++;
  console.log('FAIL  ngoại lệ trong smoke test:', e);
} finally {
  child.kill();
  child2?.kill();
  await server.close().catch(() => {});
  console.log(failed ? `\n${failed} khẳng định FAIL` : '\nTất cả khẳng định PASS');
  process.exit(failed ? 1 : 0);
}
