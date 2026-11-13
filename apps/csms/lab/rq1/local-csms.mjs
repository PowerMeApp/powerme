/**
 * Dựng CSMS PowerMe cục bộ cho harness RQ1: Postgres nhúng (cụm RIÊNG, không đụng DB demo) +
 * migration + demo/seed.sql + `node dist/main.js` với tham số thí nghiệm. Dừng sạch cả hai.
 *
 * Tái dùng `demo/db-embedded.mjs` (khởi động/dừng Postgres nhúng, migration, seed). Khác demo ở
 * chỗ: thư mục dữ liệu và cổng do người gọi chọn, DB bị XOÁ VÀ TẠO LẠI mỗi lần gọi (mỗi cấu hình
 * thí nghiệm chạy trên DB sạch), console tắt, log CSMS ghi ra file thay vì màn hình.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import {
  applyMigration,
  applySeed,
  connectDemoDb,
  CSMS_DIR,
  killTree,
  startEmbeddedDb,
} from '../../demo/db-embedded.mjs';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
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

/** Build tsc nếu dist/main.js chưa có hoặc cũ hơn src/ (cùng quy tắc với demo/run-demo.mjs). */
export function ensureBuilt(log = () => {}) {
  const main = path.join(CSMS_DIR, 'dist', 'main.js');
  if (existsSync(main) && statSync(main).mtimeMs >= newestMtime(path.join(CSMS_DIR, 'src'))) return;
  log('build CSMS (tsc)…');
  const tsc = require.resolve('typescript/bin/tsc', { paths: [CSMS_DIR] });
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: CSMS_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('build CSMS thất bại (xem lỗi tsc ở trên)');
}

/**
 * Biến môi trường CSMS của thí nghiệm. Trả cả đối tượng để ghi vào meta.json: mọi tham số khác
 * mặc định sản phẩm phải nhìn thấy được trong đầu ra.
 */
export function experimentEnv({ databaseUrl, ocppPort, reconciliationEnabled, timing }) {
  return {
    DATABASE_URL: databaseUrl,
    OCPP_PORT: String(ocppPort),
    CONSOLE_ENABLED: 'false',
    // Trụ thí nghiệm được chèn thẳng vào DB, không qua onboard() nên không có credential.
    ALLOW_LEGACY_NO_CREDENTIAL: 'true',
    RECONCILIATION_ENABLED: reconciliationEnabled ? 'true' : 'false',
    // ĐÃ RÚT NGẮN so với sản phẩm (120 s / 10 s) — xem README mục "Mối đe doạ tính hợp lệ".
    OFFLINE_GRACE_S: String(timing.graceS),
    METER_VALUE_SAMPLE_INTERVAL_S: String(timing.intervalS),
    // Giữ mặc định sản phẩm.
    RECONCILE_GAP_FACTOR: String(timing.gapFactor),
    RECONCILE_ENERGY_TOLERANCE_WH: '1',
    REPLAY_SKEW_THRESHOLD_S: '5',
    SESSION_START_TIMEOUT_S: '120',
    SESSION_HARD_CAP_H: '24',
    OCPP_HEARTBEAT_INTERVAL_SECONDS: '300',
  };
}

/**
 * `envOverrides` (tuỳ chọn): biến môi trường CSMS đè lên `experimentEnv`. Harness RQ1 không dùng;
 * lab/nfr03 dùng để bật lại kiểm credential (ALLOW_LEGACY_NO_CREDENTIAL=false) như staging.
 *
 * @returns `{ db, endpoint, env, csmsPid, logFile, stop() }` — `db` là pg.Client đã nối tới DB thí nghiệm.
 */
export async function startLocalCsms({
  pgDir,
  pgPort,
  ocppPort,
  database = 'powerme_rq1',
  reconciliationEnabled,
  timing,
  logFile,
  envOverrides = {},
  log = () => {},
}) {
  if (await portOpen(pgPort)) throw new Error(`cổng Postgres ${pgPort} đang bận — đổi --pg-port`);
  if (await portOpen(ocppPort)) throw new Error(`cổng OCPP ${ocppPort} đang bận — đổi --ocpp-port`);

  let pg = null;
  let child = null;
  let client = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (client) await client.end().catch(() => {});
    if (child?.pid) killTree(child.pid);
    if (pg) pg.stopSync();
  };

  try {
    log(`Postgres nhúng: ${pgDir} cổng ${pgPort}…`);
    pg = await startEmbeddedDb({ dataDir: pgDir, port: pgPort, database });

    // DB sạch cho mỗi cấu hình: xoá rồi tạo lại (startEmbeddedDb chỉ tạo khi chưa có).
    const admin = await connectDemoDb(pg.url.replace(/\/[^/]+$/, '/postgres'));
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally {
      await admin.end();
    }
    client = await connectDemoDb(pg.url);
    await applyMigration(client);
    await applySeed(client);

    ensureBuilt(log);
    const env = {
      ...experimentEnv({ databaseUrl: pg.url, ocppPort, reconciliationEnabled, timing }),
      ...envOverrides,
    };
    const out = createWriteStream(logFile, { flags: 'w' });
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: CSMS_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    let exited = null;
    child.on('exit', (code) => (exited = code ?? -1));

    const deadline = Date.now() + 60_000;
    while (!(await portOpen(ocppPort))) {
      if (exited !== null) throw new Error(`CSMS thoát sớm (mã ${exited}) — xem ${logFile}`);
      if (Date.now() > deadline) throw new Error(`CSMS không nghe cổng ${ocppPort} sau 60 s`);
      await sleep(300);
    }
    log(`CSMS (pid ${child.pid}) nghe ws://127.0.0.1:${ocppPort}/ocpp — log: ${logFile}`);
    return {
      db: client,
      endpoint: `ws://127.0.0.1:${ocppPort}/ocpp`,
      // Không ghi DATABASE_URL vào meta (có mật khẩu DB cục bộ).
      env: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'DATABASE_URL')),
      csmsPid: child.pid,
      logFile,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
