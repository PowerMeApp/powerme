/**
 * Bộ chạy demo MỘT LỆNH cho Review 2: `npm run demo -w @powerme/csms` (hoặc `npm run demo` trong apps/csms).
 *
 * Vì sao tồn tại: máy dev không có Docker/Postgres. Script này dựng cả chuỗi chỉ với Node:
 *   1. Postgres nhúng (embedded-postgres 17 beta) ở 127.0.0.1:54330, data trong apps/csms/.demo-data/
 *   2. áp các migration còn thiếu trong drizzle/ (0000, 0001… theo bảng _migrations) và nạp demo/seed.sql
 *   3. build CSMS nếu dist/ cũ hơn src/, rồi chạy `node dist/main.js` (cổng OCPP 9000)
 *   4. nếu có: HMI trụ D1 (`simulator/d1-hmi/server.mjs`, :8100) và bảng điều khiển CSMS (:3000)
 *   5. in bảng tóm tắt URL; Ctrl+C dừng và kill toàn bộ tiến trình con (kể cả cây con trên Windows)
 *
 * Tuỳ chọn:
 *   --no-hmi            không chạy HMI trụ D1
 *   --port-offset N     cộng N vào mọi cổng (pg 54330, ocpp 9000, hmi 8100, console 3000)
 *   --reset             xoá .demo-data (DB, mọi phiên đã sinh) rồi dựng lại từ đầu (= npm run demo:reset)
 *   --db-only           chỉ Postgres + seed (= npm run demo:db), xem db-embedded.mjs
 *
 * HMI và console đã có trong repo; script vẫn tự phát hiện và chỉ cảnh báo nếu thiếu. Script chỉ IN URL,
 * không tự mở trình duyệt.
 * Biến môi trường cấp cho HMI (đã đối chiếu với simulator/d1-hmi/server.mjs ở BE-10): CSMS_URL, CP_ID,
 * HMI_PORT (server.mjs chỉ đọc HMI_PORT; PORT truyền thêm cho an toàn) và STALE_METERSTOP (mặc định bật).
 * HMI và scripted-station.mjs dùng CÙNG identity RH24D1-00001: không chạy cả hai cùng lúc.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSMS_DIR, killTree, prepareDb, resetDataDir } from './db-embedded.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(CSMS_DIR, '..', '..');
const HMI_ENTRY = path.join(REPO_ROOT, 'simulator', 'd1-hmi', 'server.mjs');
const CONSOLE_DIR = path.join(CSMS_DIR, 'src', 'console');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const offsetAt = args.indexOf('--port-offset');
const OFFSET = offsetAt >= 0 ? Number(args[offsetAt + 1]) : 0;
if (!Number.isInteger(OFFSET)) {
  console.error('--port-offset phải là số nguyên');
  process.exit(2);
}
const PORTS = {
  ocpp: 9000 + OFFSET,
  hmi: 8100 + OFFSET,
  console: 3000 + OFFSET,
};
const CP_ID = process.env.CP_ID ?? 'RH24D1-00001';

if (flag('--db-only')) {
  // Giao cho db-embedded.mjs chạy chế độ riêng; truyền nguyên các cờ liên quan.
  const rest = args.filter((a) => a !== '--db-only');
  const r = spawnSync(process.execPath, [path.join(CSMS_DIR, 'demo', 'db-embedded.mjs'), ...rest], {
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

// ---- In log có nhãn màu ----------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const LABELS = {
  demo: (s) => paint('1;37', s),
  db: (s) => paint('36', s),
  csms: (s) => paint('32', s),
  hmi: (s) => paint('35', s),
  warn: (s) => paint('33', s),
};
function say(label, line) {
  const tag = (LABELS[label] ?? ((s) => s))(`[${label}]`.padEnd(7));
  console.log(`${tag} ${line}`);
}
const info = (m) => say('demo', m);
const warn = (m) => say('demo', LABELS.warn(`CẢNH BÁO: ${m}`));

// ---- Quản lý tiến trình con --------------------------------------------------------------
const children = new Set();
let shuttingDown = false;
let db = null;

function pipeLines(stream, label) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) say(label, line);
    }
  });
  stream.on('end', () => buf && say(label, buf));
}

function launch(label, command, argv, { cwd, env }) {
  const child = spawn(command, argv, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  pipeLines(child.stdout, label);
  pipeLines(child.stderr, label);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      say(label, LABELS.warn(`đã thoát (code=${code ?? '-'} signal=${signal ?? '-'})`));
      if (label === 'csms') void shutdown(1);
    }
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  info('đang dừng…');
  for (const child of children) killTree(child.pid);
  if (db) {
    try {
      db.stopSync();
    } catch (err) {
      warn(`dừng Postgres lỗi: ${err?.message ?? err}`);
    }
  }
  info('đã dừng sạch.');
  process.exit(exitCode);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGBREAK', () => void shutdown(0));

// ---- Tiện ích --------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function waitFor(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (shuttingDown) return false;
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/** Build tsc nếu dist/main.js chưa có hoặc cũ hơn file .ts mới nhất trong src/. */
function ensureBuilt() {
  const main = path.join(CSMS_DIR, 'dist', 'main.js');
  const upToDate =
    existsSync(main) && statSync(main).mtimeMs >= newestMtime(path.join(CSMS_DIR, 'src'));
  if (upToDate) {
    info('dist/ đã mới — bỏ qua build');
    return;
  }
  info('build CSMS (tsc)…');
  const tsc = require.resolve('typescript/bin/tsc', { paths: [CSMS_DIR] });
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: CSMS_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('build CSMS thất bại (xem lỗi tsc ở trên)');
}

// ---- Chính -----------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  if (flag('--reset')) {
    await resetDataDir();
    info('đã xoá .demo-data — dựng lại từ đầu');
  }

  info('khởi động Postgres nhúng…');
  db = await prepareDb({
    portOffset: OFFSET,
    log: (m) => say('db', m),
    // Postgres nói nhiều; chỉ lộ lỗi nghiêm trọng.
    pgLog: (m) => /ERROR|FATAL|PANIC/.test(m) && say('db', m),
  });
  say('db', `sẵn sàng ${db.url}`);

  ensureBuilt();

  info('khởi động CSMS…');
  launch('csms', process.execPath, ['dist/main.js'], {
    cwd: CSMS_DIR,
    env: {
      DATABASE_URL: db.url,
      OCPP_PORT: String(PORTS.ocpp),
      // Seed demo chưa đi qua onboard() nên trụ chưa có credential (review PR #33).
      ALLOW_LEGACY_NO_CREDENTIAL: 'true',
      CONSOLE_PORT: String(PORTS.console),
      // Giá trị theo infra/.env.example
      OCPP_HEARTBEAT_INTERVAL_SECONDS: '300',
      METER_VALUE_SAMPLE_INTERVAL_S: '10',
      RECONCILE_GAP_FACTOR: '3',
      RECONCILE_ENERGY_TOLERANCE_WH: '1',
      SESSION_START_TIMEOUT_S: '120',
      SESSION_HARD_CAP_H: '24',
      REPLAY_SKEW_THRESHOLD_S: '5',
    },
  });
  const csmsUp = await waitFor(() => portOpen(PORTS.ocpp), 60_000);
  if (!csmsUp) throw new Error(`CSMS không nghe cổng ${PORTS.ocpp} sau 60 s`);
  say('csms', LABELS.csms(`đã nghe ws://localhost:${PORTS.ocpp}/ocpp/<serialNumber>`));

  // Console vận hành (PR riêng): chỉ báo khi route thật sự trả lời.
  let consoleUrl = null;
  if (existsSync(CONSOLE_DIR)) {
    const up = await waitFor(() => httpOk(`http://127.0.0.1:${PORTS.console}/`), 20_000, 500);
    if (up) consoleUrl = `http://localhost:${PORTS.console}/`;
    else
      warn(
        `có src/console nhưng http://127.0.0.1:${PORTS.console}/ không trả lời — kiểm tra log [csms]`,
      );
  } else {
    warn('chưa có src/console (PR bảng điều khiển CSMS chưa merge) — bỏ qua console');
  }

  // HMI trụ D1 (PR riêng).
  let hmiUrl = null;
  if (flag('--no-hmi')) {
    info('--no-hmi: không chạy HMI');
  } else if (!existsSync(HMI_ENTRY)) {
    warn(
      'chưa có simulator/d1-hmi/server.mjs (PR HMI chưa merge) — bỏ qua HMI. Trụ thử: node apps/csms/lab/fake-station.mjs',
    );
  } else {
    launch('hmi', process.execPath, [HMI_ENTRY], {
      cwd: path.dirname(HMI_ENTRY),
      env: {
        CSMS_URL: `ws://localhost:${PORTS.ocpp}/ocpp`,
        CP_ID,
        // server.mjs chỉ đọc HMI_PORT (PORT bị bỏ qua); giữ cả hai cho khỏi vênh nếu HMI đổi.
        PORT: String(PORTS.hmi),
        HMI_PORT: String(PORTS.hmi),
        // Mặc định BẬT để demo có phiên `review`: sau rớt mạng, StopTransaction mang meterStop cũ
        // (mô phỏng hiện tượng 3 của EXP-01). Tắt: STALE_METERSTOP=0 npm run demo.
        STALE_METERSTOP: process.env.STALE_METERSTOP ?? '1',
      },
    });
    const up = await waitFor(() => httpOk(`http://127.0.0.1:${PORTS.hmi}/`), 20_000, 500);
    if (up) hmiUrl = `http://localhost:${PORTS.hmi}/`;
    else warn(`HMI không trả lời trên cổng ${PORTS.hmi} — xem log [hmi]`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rows = [
    ['Postgres', db.url.replace(/:powerme@/, ':***@')],
    ['CSMS OCPP', `ws://localhost:${PORTS.ocpp}/ocpp/${CP_ID}`],
    ['Console CSMS', consoleUrl ?? '(chưa có)'],
    ['HMI trụ D1', hmiUrl ?? '(chưa có / tắt)'],
    [
      'Test tích hợp',
      `DATABASE_URL=${db.testUrl} npm test -w @powerme/csms  (DB riêng, đừng trỏ vào DB demo)`,
    ],
    [
      'Trụ kịch bản',
      `node apps/csms/demo/scripted-station.mjs ds-01a --url ws://localhost:${PORTS.ocpp}/ocpp`,
    ],
    [
      'Trụ thử (lab)',
      `node apps/csms/lab/fake-station.mjs  (ID=${CP_ID} CSMS=ws://localhost:${PORTS.ocpp}/ocpp)`,
    ],
    [
      'Lưu ý',
      `HMI và trụ kịch bản dùng chung ID ${CP_ID}: chỉ chạy MỘT trong hai (--no-hmi nếu dùng trụ kịch bản)`,
    ],
    ['Dừng', 'Ctrl+C trong cửa sổ này'],
    ['Làm lại từ đầu', 'npm run demo:reset -w @powerme/csms'],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log('');
  console.log(LABELS.demo(`=== Demo PowerMe sẵn sàng sau ${secs} s ===`));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(w)}  ${v}`);
  console.log('');
}

main().catch(async (err) => {
  console.error(`[demo] LỖI: ${err?.stack ?? err}`);
  await shutdown(1);
});
