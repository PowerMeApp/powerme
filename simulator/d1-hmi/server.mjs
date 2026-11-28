// server.mjs — HTTP + SSE phục vụ các trụ giả lập D1 (một hoặc nhiều trụ trong MỘT tiến trình).
//
// LÀM GÌ
//   - GET  /                      → public/tong.html: trang tổng, danh sách mọi trụ
//   - GET  /tru/<cpId>            → public/tru.html: trang từng trụ (HMI bấm được + hành trình phiên)
//   - GET  /static/<tên>.css|js   → file tĩnh trong public/, tên đơn, chống ".."
//   - GET  /vendor/three/<file>   → đúng hai file build của three.js trong node_modules (hình 3D)
//   - GET  /vendor/qrcode.mjs     → qrcode-generator (QA-09, tem QR trên trang trụ); thiếu gói → 404
//   - GET  /tru3d/tru3d.js        → bundle hình 3D (React + r3f) đã build ở tru3d/dist/; chưa build → 404
//   - GET  /tong/events           → SSE trang tổng: "tong" (tóm tắt mọi trụ, tối đa ~2 lần/giây)
//   - GET  /events/<cpId>         → SSE của MỘT trụ: "hello" (snapshot + nhật ký + điểm biểu đồ),
//                                    rồi "state" (~7 lần/giây), "log", "point"
//   - GET  /api/tong              → tóm tắt mọi trụ (JSON)
//   - GET  /api/<cpId>/state      → snapshot JSON của một trụ
//   - POST /api/<cpId>/<hành động> body JSON → station.act(<hành động>, body) → { ok, message }
//   - POST /api/<cpId>/swipeReader → đầu đọc RFID USB (T146), route riêng có kiểm chặt (swipeReader())
//   Đường cũ (trước QA-03) vẫn chạy và trỏ vào TRỤ ĐẦU TIÊN: GET /events, GET /api/state,
//   POST /api/<hành động>, POST /api/swipeReader (smoke, healthcheck Dockerfile, HMI cũ).
// VÌ SAO
//   http thuần của Node: không thêm dependency, demo chỉ cần `node server.mjs`.
// GIẢ ĐỊNH
//   Chỉ nghe 127.0.0.1 — màn hình demo, không có xác thực HTTP (mật khẩu HMI là mật khẩu giả của
//   trụ, không phải bảo mật của server này).
//
// Env: CSMS_URL (ws://localhost:9000/ocpp), HMI_PORT (8100), HMI_HOST (127.0.0.1)
//      Một trụ: CP_ID (RH24D1-00001), CP_PASSWORD.
//      Nhiều trụ: CP_IDS=ID1,ID2,... và CP_PASSWORDS=pw1,pw2,... (cùng thứ tự; bỏ trống một vị trí
//        = trụ đó không gửi Basic Auth). Có CP_IDS thì CP_ID/CP_PASSWORD bị bỏ qua.
//      Cho kiểm thử (áp cho mọi trụ): RETRY_MS, REPLAY_LOSS, METER_INTERVAL, PING_SEC, REBOOT_MS,
//      SPEED; STALE_METERSTOP=1: StopTransaction sau một lần rớt mạng mang meterStop cũ (EXP-01).
//      OFFLINE_AUTH=normal|rejected|notsupported (T150): trụ cho CSMS tắt authorize offline, hay
//        "cứng đầu" (key readonly → Rejected, hoặc không có key → NotSupported) và nhận mọi thẻ offline.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createStation } from './station.mjs';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const env = process.env;

// ── Danh sách trụ ───────────────────────────────────────────────────────────
// Identity được nối vào URL (/tru/<id>, /api/<id>/...) nên chỉ cho chữ/số/._- (tối đa 48 ký tự).
const ID_RE = /^[A-Za-z0-9._-]{1,48}$/;
function stationList() {
  if (env.CP_IDS) {
    const ids = env.CP_IDS.split(',').map((s) => s.trim());
    const pws = (env.CP_PASSWORDS ?? '').split(',').map((s) => s.trim());
    // QA-08: tên hiển thị (vd. tên trạm) cùng thứ tự CP_IDS; trống → chỉ hiện identity.
    const names = (env.CP_NAMES ?? '').split(',').map((s) => s.trim());
    // Mã in trên trụ (display_code) — mã tài xế nhập/quét trên app, khác identity OCPP.
    const codes = (env.CP_CODES ?? '').split(',').map((s) => s.trim());
    // QA-09: địa chỉ trạm (ngăn bằng "|" vì địa chỉ có dấu phẩy) và số súng thật trong DB (1 hoặc 2).
    const addrs = (env.CP_ADDRESSES ?? '').split('|').map((s) => s.trim());
    const guns = (env.CP_GUNS ?? '').split(',').map((s) => Number(s.trim()));
    return ids.map((id, i) => ({
      id,
      password: pws[i] || undefined,
      name: names[i] || null,
      code: codes[i] || null,
      address: addrs[i] || null,
      guns: guns[i] === 1 ? 1 : 2,
    }));
  }
  return [
    {
      id: env.CP_ID ?? 'RH24D1-00001',
      password: env.CP_PASSWORD || undefined,
      name: env.CP_NAME?.trim() || null,
      code: env.CP_CODE?.trim() || null,
      address: env.CP_ADDRESS?.trim() || null,
      guns: env.CP_GUNS?.trim() === '1' ? 1 : 2,
    },
  ];
}
const list = stationList();
for (const { id } of list) {
  if (!ID_RE.test(id)) {
    console.error(`CP_ID/CP_IDS không hợp lệ: "${id}" (chỉ chữ, số, . _ -; tối đa 48 ký tự)`);
    process.exit(2);
  }
}
if (new Set(list.map((s) => s.id)).size !== list.length) {
  console.error('CP_IDS có identity trùng nhau');
  process.exit(2);
}

const common = {
  csmsUrl: env.CSMS_URL ?? 'ws://localhost:9000/ocpp',
  retryMs: num(env.RETRY_MS, 30_000),
  replayLoss: num(env.REPLAY_LOSS, 0.25),
  meterInterval: num(env.METER_INTERVAL, 10),
  pingSec: num(env.PING_SEC, 30),
  rebootMs: num(env.REBOOT_MS, 3000),
  speed: num(env.SPEED, 1),
  staleMeterStop: env.STALE_METERSTOP === '1',
  offlineAuth: env.OFFLINE_AUTH || 'normal',
};

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const tongClients = new Set();

// Mỗi trụ: station + tập client SSE riêng. Trang một trụ chỉ nhận dữ liệu của trụ đó.
const stations = new Map();
for (const { id, password, name, code, address, guns } of list) {
  const station = createStation({
    ...common,
    cpId: id,
    ...(password ? { authPassword: password } : {}),
  });
  const entry = { id, name, code, address, guns, station, clients: new Set() };
  // Đẩy snapshot khi có thay đổi nhưng không quá ~7 lần/giây.
  let pending = false;
  station.events.on('change', () => {
    scheduleTong();
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!entry.clients.size) return;
      const snap = snapOf(entry);
      for (const r of entry.clients) send(r, 'state', snap);
    }, 150);
  });
  station.events.on('log', (e) => {
    for (const r of entry.clients) send(r, 'log', e);
  });
  station.events.on('point', (p) => {
    for (const r of entry.clients) send(r, 'point', p);
  });
  stations.set(id, entry);
}
const first = stations.values().next().value;

// ── Trang tổng: tóm tắt nhỏ, không có nhật ký/hành trình ───────────────────
/** Snapshot của một trụ kèm tên hiển thị (QA-08). */
function snapOf(entry) {
  return {
    ...entry.station.snapshot(),
    name: entry.name,
    displayCode: entry.code,
    address: entry.address,
    guns: entry.guns,
  };
}

function summary(entry) {
  const s = snapOf(entry);
  return {
    cpId: s.cpId,
    name: s.name,
    displayCode: s.displayCode,
    address: s.address,
    net: { state: s.net.state, halfOpen: s.net.halfOpen, nextRetrySec: s.net.nextRetrySec },
    speed: s.speed,
    clockAheadSec: s.clockAheadSec,
    queue: s.queue.total,
    connectors: s.connectors.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      errorCode: c.errorCode,
      plugged: c.plugged,
      kw: c.kw,
      kwh: c.kwh,
      soc: c.soc,
      txId: c.txId,
      txActive: c.txActive,
      idTag: c.idTag,
      remoteWaitSec: c.remoteWaitSec,
    })),
  };
}
const tong = () => ({
  csmsUrl: common.csmsUrl,
  stations: [...stations.values()].map((e) => summary(e)),
});
let tongPending = false;
function scheduleTong() {
  if (tongPending || !tongClients.size) return;
  tongPending = true;
  setTimeout(() => {
    tongPending = false;
    const data = tong();
    for (const r of tongClients) send(r, 'tong', data);
  }, 500);
}

// ── File tĩnh ──────────────────────────────────────────────────────────────
const PUBLIC = (name) => new URL(`./public/${name}`, import.meta.url);
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
// three.js: chỉ phục vụ ĐÚNG các file trong danh sách này, lấy từ node_modules (devDependency ở gốc
// repo). three.module.js import './three.core.js' nên hai file nằm cùng thư mục ảo /vendor/three/.
// Không có gói (vd. image Docker cài --omit=dev) → 404 → trang tự về hình 2D.
const VENDOR = new Map();
try {
  const dir = path.dirname(createRequire(import.meta.url).resolve('three'));
  for (const f of ['three.module.js', 'three.core.js']) VENDOR.set(f, path.join(dir, f));
} catch {
  /* không có three → không có route vendor */
}
// QA-09: thư viện tạo tem QR (MIT, một file ESM, không phụ thuộc). Thiếu → trang chỉ hiện mã chữ.
let QRCODE_FILE = null;
try {
  const p = createRequire(import.meta.url).resolve('qrcode-generator');
  QRCODE_FILE = path.join(path.dirname(p), 'qrcode.mjs');
} catch {
  /* không có qrcode-generator */
}

// Bundle hình 3D (QA-04): ĐÚNG một file tên cố định do `npm run sim:tru3d:build` sinh ra trong
// tru3d/dist/ (không commit). Đọc lúc có yêu cầu nên build xong không cần khởi động lại server;
// chưa build → 404 → tru-3d.js tự về hình 2D.
const TRU3D = new Map([['tru3d.js', new URL('./tru3d/dist/tru3d.js', import.meta.url)]]);

const sseHead = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};
function openStationSse(entry, req, res) {
  res.writeHead(200, sseHead);
  const st = entry.station;
  send(res, 'hello', { state: snapOf(entry), log: st.logHistory(), series: st.series() });
  entry.clients.add(res);
  req.on('close', () => entry.clients.delete(res));
}
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const notFound = (res) => res.writeHead(404).end('not found');
async function act(entry, action, req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const args = body ? JSON.parse(body) : {};
  const result = await entry.station.act(action, args);
  return json(res, result.ok ? 200 : 400, result);
}

// POST /api/<cpId>/swipeReader (và /api/swipeReader cũ → trụ đầu tiên). Chỉ loopback (peer + Host
// đúng cổng), cùng origin, Sec-Fetch-Site same-origin/none, application/json, thân ≤ 512 B; kiểm
// đúng {connector, idTag} nằm trong hành động swipeReader (hmi-actions.mjs).
async function swipeReader(entry, req, res) {
  const reject = (status, message) => json(res, status, { ok: false, message });
  const localHost = new Set(['127.0.0.1', 'localhost', '[::1]']);
  let host;
  try {
    host = new URL('http://' + req.headers.host);
  } catch {
    return reject(403, 'Đầu đọc chỉ nhận yêu cầu cùng origin trên máy local.');
  }
  const remote = req.socket.remoteAddress;
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ||
    !localHost.has(host.hostname) ||
    host.port !== String(server.address().port) ||
    (req.headers.origin && req.headers.origin !== host.origin) ||
    (req.headers['sec-fetch-site'] &&
      !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
  )
    return reject(403, 'Đầu đọc chỉ nhận yêu cầu cùng origin trên máy local.');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    return reject(415, 'Đầu đọc yêu cầu application/json.');
  let body = '',
    size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512) return reject(413, 'Khung đầu đọc quá dài.');
    body += chunk;
  }
  let args;
  try {
    args = JSON.parse(body);
  } catch {
    return reject(400, 'Khung đầu đọc JSON không hợp lệ.');
  }
  const result = await entry.station.act('swipeReader', args);
  return json(res, result.ok ? 200 : 400, result);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Tách path thành các đoạn ĐÃ giải mã; đoạn rỗng, "." hay ".." hoặc chứa gạch chéo → 404.
  let parts;
  try {
    parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
  } catch {
    return notFound(res);
  }
  if (parts.some((p) => p === '.' || p === '..' || /[\\/]/.test(p))) return notFound(res);
  const get = req.method === 'GET';
  try {
    if (get && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(PUBLIC('tong.html')));
    }
    if (get && parts[0] === 'tru' && parts.length === 2) {
      if (!stations.has(parts[1])) return notFound(res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(PUBLIC('tru.html')));
    }
    // File tĩnh của trang: CHỈ tên file đơn (chữ/số/gạch) trong public/, đuôi .css/.js.
    if (get && parts[0] === 'static' && parts.length === 2) {
      const name = parts[1];
      const type = STATIC_TYPES[name.slice(name.lastIndexOf('.'))];
      if (!/^[\w-]+\.(css|js)$/.test(name) || !type) return notFound(res);
      try {
        const body = await readFile(PUBLIC(name));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(body);
      } catch {
        return notFound(res);
      }
    }
    if (get && parts[0] === 'vendor' && parts[1] === 'qrcode.mjs' && parts.length === 2) {
      if (!QRCODE_FILE) return notFound(res);
      let body;
      try {
        body = await readFile(QRCODE_FILE);
      } catch {
        return notFound(res);
      }
      res.writeHead(200, { 'content-type': STATIC_TYPES['.js'], 'cache-control': 'max-age=86400' });
      return res.end(body);
    }
    if (get && parts[0] === 'vendor' && parts[1] === 'three' && parts.length === 3) {
      const file = VENDOR.get(parts[2]);
      if (!file) return notFound(res);
      res.writeHead(200, {
        'content-type': STATIC_TYPES['.js'],
        'cache-control': 'max-age=86400',
      });
      return res.end(await readFile(file));
    }
    if (get && parts[0] === 'tru3d' && parts.length === 2) {
      const file = TRU3D.get(parts[1]);
      if (!file) return notFound(res);
      let body;
      try {
        body = await readFile(file);
      } catch {
        return notFound(res);
      }
      res.writeHead(200, { 'content-type': STATIC_TYPES['.js'], 'cache-control': 'no-cache' });
      return res.end(body);
    }
    if (get && url.pathname === '/tong/events') {
      res.writeHead(200, sseHead);
      send(res, 'tong', tong());
      tongClients.add(res);
      req.on('close', () => tongClients.delete(res));
      return;
    }
    if (get && url.pathname === '/api/tong') return json(res, 200, tong());
    // Đường cũ → trụ đầu tiên
    if (get && url.pathname === '/events') return openStationSse(first, req, res);
    if (get && parts[0] === 'events' && parts.length === 2) {
      const entry = stations.get(parts[1]);
      return entry ? openStationSse(entry, req, res) : notFound(res);
    }
    // Đầu đọc RFID USB (T146): route riêng có kiểm chặt, theo trụ. Đặt TRƯỚC route hành động chung
    // để "swipeReader" không bao giờ đi qua đường không kiểm tra.
    if (req.method === 'POST' && parts[0] === 'api' && parts.at(-1) === 'swipeReader') {
      if (parts.length === 2) return swipeReader(first, req, res);
      if (parts.length === 3) {
        const entry = stations.get(parts[1]);
        return entry ? swipeReader(entry, req, res) : notFound(res);
      }
      return notFound(res);
    }
    if (parts[0] === 'api' && parts.length === 2) {
      if (get && parts[1] === 'state') return json(res, 200, snapOf(first));
      if (req.method === 'POST') return act(first, parts[1], req, res);
    }
    if (parts[0] === 'api' && parts.length === 3) {
      const entry = stations.get(parts[1]);
      if (!entry) return notFound(res);
      if (get && parts[2] === 'state') return json(res, 200, snapOf(entry));
      if (req.method === 'POST') return act(entry, parts[2], req, res);
    }
    notFound(res);
  } catch (e) {
    json(res, 500, { ok: false, message: e.message });
  }
});

// HMI không có xác thực: mặc định chỉ loopback. HMI_HOST=0.0.0.0 CHỈ dùng trong container, khi
// cổng được publish riêng cho loopback của máy chủ (infra/staging/docker-compose.yml).
const HOST = env.HMI_HOST || '127.0.0.1';
const PORT = num(env.HMI_PORT, 8100);
server.listen(PORT, HOST, () => {
  const ids = [...stations.keys()];
  console.log(
    `HMI trụ D1 tại http://${HOST}:${server.address().port}  (${ids.length} trụ: ${ids.join(', ')}; CSMS ${common.csmsUrl})`,
  );
  for (const e of stations.values()) e.station.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () =>
    Promise.all([...stations.values()].map((e) => e.station.close())).finally(() =>
      process.exit(0),
    ),
  );
}
