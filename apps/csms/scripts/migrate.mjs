/**
 * Áp migration — tuần tự theo tên file trong drizzle/, có bảng theo dõi `_migrations`.
 *
 * Vì sao tồn tại: một bản duy nhất cho demo (demo/db-embedded.mjs import `migrate`) và cho staging
 * (image Docker chạy `node scripts/migrate.mjs`, xem infra/staging/deploy.sh). Idempotent: chạy
 * lại không áp gì thêm. Thoát mã 1 khi có lỗi (file SQL lỗi, DB không nối được), mã 2 khi thiếu
 * DATABASE_URL — deploy.sh dừng lại và không khởi động ứng dụng trên schema nửa vời.
 *
 * DB cũ (có bảng nhưng chưa có `_migrations`, ví dụ DB demo trước BE-11) được ghi nhận file đầu
 * tiên là đã áp rồi áp tiếp các file sau lên dữ liệu hiện có, không mất phiên/meter đã sinh.
 *
 * Bản TypeScript tương đương cho test: test/helpers/apply-migrations.ts — sửa một nơi thì sửa nơi kia.
 * Chạy riêng: DATABASE_URL=... node scripts/migrate.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/ và demo/ cùng cấp với drizzle/ — cả trong repo lẫn trong image (/app/apps/csms hoặc /app).
export const MIGRATIONS_DIR = path.resolve(here, '..', 'drizzle');

export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

/** `client` là pg.Client đã connect. Trả danh sách migration vừa áp. */
export async function migrate(client, log = () => {}, dir = MIGRATIONS_DIR) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );
  const names = listMigrations(dir);
  // WP3/T72: renamed unpublished migrations require an explicit upgrade; never rerun their DDL.
  const legacy = [...done].filter((name) =>
    /^(0003_wp3_t31_charging|0004_wp3_t72_recovery|0005_wp3_station_search|0006_wp3_stop_attempts)$/.test(
      name,
    ),
  );
  if (legacy.length)
    throw new Error(
      `legacy_wp3_migration_history: ${legacy.join(', ')}; back up this database and reconcile its migration history before upgrading; no migration was applied`,
    );

  if (names[0] && done.size === 0) {
    const { rows } = await client.query("SELECT to_regclass('public.charge_points') AS t");
    if (rows[0].t) {
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [names[0]]);
      done.add(names[0]);
      log(`DB đã có schema từ trước — ghi nhận ${names[0]} là đã áp`);
    }
  }

  const applied = [];
  for (const name of names) {
    if (done.has(name)) continue;
    const file = path.join(dir, `${name}.sql`);
    if (!existsSync(file)) throw new Error(`thiếu file migration ${file}`);
    await client.query(readFileSync(file, 'utf8'));
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    applied.push(name);
    log(`đã áp drizzle/${name}.sql`);
  }
  if (applied.length === 0) log('schema đã mới nhất — không có migration cần áp');
  return applied;
}

// ---- Chạy riêng ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] Thiếu DATABASE_URL');
    process.exit(2);
  }
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const client = new (pg.default ?? pg).Client({ connectionString: url });
  try {
    await client.connect();
    const applied = await migrate(client, (m) => console.log(`[migrate] ${m}`));
    console.log(`[migrate] xong — áp ${applied.length} migration`);
  } catch (err) {
    console.error(`[migrate] LỖI: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
