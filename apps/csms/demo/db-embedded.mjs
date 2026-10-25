/**
 * Postgres nhúng cho demo Review 2 — khởi động, áp migration, nạp dữ liệu mẫu, dừng sạch.
 *
 * Vì sao tồn tại: máy dev của nhóm không có Docker và không có Postgres, nhưng demo (và 19 test
 * tích hợp) cần một Postgres thật — PGlite không đủ vì migration dùng partition. Gói
 * `embedded-postgres` kèm sẵn binary Postgres cho Windows/Linux/macOS, chỉ cần Node.
 *
 * LƯU Ý PHIÊN BẢN: `embedded-postgres` chỉ phát hành beta 17.x/18.x, nên demo chạy Postgres 17 beta
 * (ghim đúng `17.10.0-beta.17`, chỉ là devDependency). CI và staging dùng Postgres 16 chuẩn
 * (infra/docker-compose.yml). Kết quả demo KHÔNG thay thế kiểm thử trên Postgres 16.
 *
 * File này là thư viện (run-demo.mjs import) và cũng chạy riêng được:
 *   node demo/db-embedded.mjs        # = npm run demo:db — chỉ bật DB + seed, Ctrl+C để dừng
 *
 * Liên quan: drizzle/*.sql (migration, áp bằng demo/migrate.mjs), demo/seed.sql (dữ liệu mẫu),
 * test/helpers/apply-migrations.ts (bản TypeScript của cùng logic cho test tích hợp).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const CSMS_DIR = path.resolve(here, '..');
export const DEMO_DATA_DIR = path.join(CSMS_DIR, '.demo-data');
export const PG_DATA_DIR = path.join(DEMO_DATA_DIR, 'pg');

const BASE_PORT = 54330;
const DB_USER = 'powerme';
const DB_PASSWORD = 'powerme';
const DB_NAME = 'powerme_demo';
const TEST_DB_NAME = 'powerme_test';

/** Cấu hình kết nối cho một độ lệch cổng (--port-offset). */
export function dbConfig(portOffset = 0) {
  const port = BASE_PORT + portOffset;
  return {
    port,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    url: `postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`,
    testUrl: `postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`,
  };
}

/** Gói `pg` dùng chung với csms (đã có trong dependency của workspace). */
function loadPg() {
  const mod = require('pg');
  return mod.default ?? mod;
}

/** Đường dẫn pg_ctl trong gói binary của nền tảng hiện tại (null nếu không thấy). */
function findPgCtl() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const pkg = `@embedded-postgres/${platform}-${process.arch}`;
  try {
    const root = path.dirname(require.resolve(`${pkg}/package.json`));
    const exe = path.join(
      root,
      'native',
      'bin',
      process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl',
    );
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Giết cả cây tiến trình (Windows: taskkill /T /F; nơi khác: SIGKILL). */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* đã thoát */
    }
  }
}

/** Xoá toàn bộ .demo-data (DB sẽ initdb + migrate + seed lại ở lần chạy sau). */
export async function resetDataDir() {
  await rm(DEMO_DATA_DIR, { recursive: true, force: true });
}

/**
 * Khởi động cụm Postgres nhúng. Trả về `{ url, port, stop }`.
 * Lần đầu (chưa có PG_VERSION) sẽ chạy initdb.
 */
export async function startEmbeddedDb({ portOffset = 0, log = () => {} } = {}) {
  const cfg = dbConfig(portOffset);
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  await mkdir(DEMO_DATA_DIR, { recursive: true });

  const server = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    persistent: true,
    // Windows initdb mặc định WIN1252 (theo locale máy) — migration có tiếng Việt nên ép UTF8.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // Chỉ lắng nghe loopback — demo không được lộ ra mạng.
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: (msg) => log(String(msg).trimEnd()),
    onError: (msg) => log(String(msg instanceof Error ? msg.message : msg).trimEnd()),
  });

  if (!existsSync(path.join(PG_DATA_DIR, 'PG_VERSION'))) {
    log('initdb lần đầu (vài giây)…');
    await server.initialise();
  }
  try {
    await server.start();
  } catch (err) {
    throw new Error(
      `Postgres nhúng không khởi động được trên cổng ${cfg.port} (cổng đang bận? tiến trình cũ còn sống?): ${err?.message ?? err}`,
    );
  }

  // Dừng sạch: pg_ctl stop -m fast (checkpoint, ngắt kết nối đàng hoàng). Không dùng server.stop()
  // của thư viện vì hai lẽ: (1) trên Windows nó taskkill /f postgres nên lần sau phải chạy crash
  // recovery; (2) hook thoát của thư viện (async-exit-hook) chạy NGAY khi nhận SIGINT, giết postgres
  // rồi process.exit. Nên gỡ tham chiếu `process` của thư viện sau khi start để hook đó thành no-op;
  // ta giữ `child` và tự dừng. Hàm dừng ĐỒNG BỘ (spawnSync) để xong trước khi hook thoát khác kịp
  // process.exit giữa chừng.
  const child = server.process;
  server.process = undefined;
  const isRunning = () => {
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let stopped = false;
  const stopSync = () => {
    if (stopped) return;
    stopped = true;
    const pgCtl = findPgCtl();
    if (pgCtl) {
      spawnSync(pgCtl, ['stop', '-D', PG_DATA_DIR, '-m', 'fast', '-w', '-t', '20'], {
        stdio: 'ignore',
      });
    }
    if (isRunning()) killTree(child.pid); // phương án cuối
  };

  // Tạo database nếu chưa có.
  const { Client } = loadPg();
  const admin = new Client({
    host: '127.0.0.1',
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    // Hai DB: `powerme_demo` cho demo, `powerme_test` cho test tích hợp (chúng DROP SCHEMA public
    // nên tuyệt đối không được trỏ vào DB demo).
    for (const name of [cfg.database, TEST_DB_NAME]) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        name,
      ]);
      if (!rowCount) await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.end();
  }
  return { ...cfg, stopSync };
}

/** Mở một client pg tới DB demo. */
export async function connectDemoDb(url) {
  const { Client } = loadPg();
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Áp mọi migration trong drizzle/ còn thiếu (0000, 0001, …) theo thứ tự tên, theo dõi bằng bảng
 * `_migrations`. DB demo cũ đã có 0000 sẽ tự lên các migration sau mà không mất dữ liệu.
 * Chi tiết: demo/migrate.mjs.
 */
export async function applyMigration(client, log = () => {}) {
  const applied = await migrate(client, log);
  return applied.length > 0;
}

/** Nạp demo/seed.sql (idempotent nhờ ON CONFLICT DO NOTHING). */
export async function applySeed(client, log = () => {}) {
  await client.query(readFileSync(path.join(here, 'seed.sql'), 'utf8'));
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM charge_points) AS charge_points,
            (SELECT count(*) FROM connectors) AS connectors,
            (SELECT count(*) FROM rfid_cards) AS rfid_cards,
            (SELECT count(*) FROM tariff_periods) AS tariff_periods`,
  );
  log(`seed xong: ${JSON.stringify(rows[0])}`);
}

/** Bật DB + migration + seed; dùng chung cho `demo:db` và `demo`. */
export async function prepareDb({ portOffset = 0, log = () => {}, pgLog = () => {} } = {}) {
  const db = await startEmbeddedDb({ portOffset, log: pgLog });
  const client = await connectDemoDb(db.url);
  try {
    await applyMigration(client, log);
    await applySeed(client, log);
  } finally {
    await client.end();
  }
  return db;
}

// ---- Chạy riêng: npm run demo:db ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const offsetAt = args.indexOf('--port-offset');
  const portOffset = offsetAt >= 0 ? Number(args[offsetAt + 1]) : 0;
  const log = (m) => console.log(`[db] ${m}`);
  if (args.includes('--reset')) {
    await resetDataDir();
    log('đã xoá .demo-data');
  }
  const db = await prepareDb({
    portOffset,
    log,
    pgLog: (m) => /ERROR|FATAL/.test(m) && log(m),
  });
  console.log(
    `\nPostgres demo sẵn sàng:\n  DATABASE_URL=${db.url}\n` +
      `  Test tích hợp (DB riêng, bị DROP SCHEMA mỗi lần chạy): DATABASE_URL=${db.testUrl} npm test -w @powerme/csms\n` +
      `  Ctrl+C để dừng.\n`,
  );
  const shutdown = () => {
    db.stopSync();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
}
