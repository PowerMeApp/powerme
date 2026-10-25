/**
 * Áp migration cho demo — tuần tự theo tên file trong drizzle/, có bảng theo dõi `_migrations`.
 *
 * Vì sao tồn tại: DB demo (.demo-data) tồn tại qua nhiều lần chạy. Trước đây demo bỏ qua migration
 * khi "schema đã có", nên DB đã có 0000 không bao giờ lên 0001. Giờ mỗi lần chạy áp những file
 * còn thiếu; DB cũ (có bảng nhưng chưa có `_migrations`) được ghi nhận 0000 đã áp rồi áp tiếp
 * 0001 lên dữ liệu hiện có, không mất phiên/meter đã sinh.
 *
 * Bản TypeScript tương đương cho test: test/helpers/apply-migrations.ts — sửa một nơi thì sửa nơi kia.
 * Chạy riêng: DATABASE_URL=... node demo/migrate.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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
    console.error('Thiếu DATABASE_URL');
    process.exit(2);
  }
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const client = new (pg.default ?? pg).Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, (m) => console.log(`[migrate] ${m}`));
  } finally {
    await client.end();
  }
}
