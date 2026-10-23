// server.mjs — HTTP + SSE phục vụ màn hình HMI của trụ giả lập D1.
//
// LÀM GÌ
//   - GET  /               → public/index.html (một file, không build)
//   - GET  /events         → SSE: "hello" (snapshot + nhật ký cũ), rồi "state" (snapshot, tối đa
//                            ~7 lần/giây) và "log" (từng dòng nhật ký OCPP mới)
//   - GET  /api/state      → snapshot JSON (dùng cho smoke test)
//   - POST /api/<hành động> body JSON → gọi station.act(<hành động>, body) → { ok, message }
// VÌ SAO
//   Dùng http thuần của Node: không thêm dependency, demo chỉ cần `node server.mjs`.
// GIẢ ĐỊNH
//   Chỉ nghe 127.0.0.1 — đây là màn hình demo, không có xác thực HTTP (mật khẩu HMI là mật khẩu
//   giả của trụ, không phải bảo mật của server này).
//
// Env: CSMS_URL (ws://localhost:9000/ocpp), CP_ID (RH24D1-00001), HMI_PORT (8100),
//      và cho kiểm thử: RETRY_MS, REPLAY_LOSS, METER_INTERVAL, PING_SEC, REBOOT_MS, SPEED.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStation } from './station.mjs';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const env = process.env;

const station = createStation({
  csmsUrl: env.CSMS_URL ?? 'ws://localhost:9000/ocpp',
  cpId: env.CP_ID ?? 'RH24D1-00001',
  retryMs: num(env.RETRY_MS, 30_000),
  replayLoss: num(env.REPLAY_LOSS, 0.25),
  meterInterval: num(env.METER_INTERVAL, 10),
  pingSec: num(env.PING_SEC, 30),
  rebootMs: num(env.REBOOT_MS, 3000),
  speed: num(env.SPEED, 1),
});

const PORT = num(env.HMI_PORT, 8100);
const htmlPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Đẩy snapshot khi có thay đổi nhưng không quá ~7 lần/giây.
let pending = false;
station.events.on('change', () => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    const snap = station.snapshot();
    for (const r of clients) send(r, 'state', snap);
  }, 150);
});
station.events.on('log', (entry) => {
  for (const r of clients) send(r, 'log', entry);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(htmlPath));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      send(res, 'hello', { state: station.snapshot(), log: station.logHistory() });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(station.snapshot()));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const args = body ? JSON.parse(body) : {};
      const result = await station.act(url.pathname.slice(5), args);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HMI trụ D1 tại http://127.0.0.1:${PORT}  (CSMS ${station.snapshot().csmsUrl})`);
  station.start();
});

process.on('SIGINT', () => station.close().finally(() => process.exit(0)));
