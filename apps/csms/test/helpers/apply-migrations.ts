/**
 * Áp migration cho test tích hợp — dùng chung để mọi test chạy đúng chuỗi 0000 → 0001 → …
 *
 * Vì sao tồn tại: trước BE-11 mỗi test tự đọc cứng `0000_init.sql`. Có migration thứ hai thì
 * phải áp TUẦN TỰ theo tên file, và phải có bảng theo dõi để DB đã có 0000 (DB demo) lên 0001
 * mà không mất dữ liệu. Logic này giống `scripts/migrate.mjs` (bản .mjs dùng cho demo và staging).
 *
 * - `migrate(client)` : áp những file chưa có trong `_migrations`, theo thứ tự tên.
 * - `resetAndMigrate(client)` : DROP SCHEMA public rồi `migrate` — dùng cho test (DB riêng!).
 *
 * Mỗi file migration tự có BEGIN/COMMIT; helper chỉ ghi `_migrations` sau khi file chạy xong.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Phần dùng tới của pg.Pool / pg.Client. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'drizzle');

/** Tên file migration (không gồm .sql), sắp theo tên. */
export function listMigrations(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

/** Trả danh sách migration vừa được áp trong lần gọi này. */
export async function migrate(client: Queryable, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await client.query('SELECT name FROM _migrations')).rows.map((r) => String(r['name'])),
  );
  const names = listMigrations(dir);
  // WP3/T72: keep the test runner's legacy-history refusal identical to the production runner.
  const legacy = [...done].filter((name) =>
    /^(0003_wp3_t31_charging|0004_wp3_t72_recovery|0005_wp3_station_search|0006_wp3_stop_attempts)$/.test(
      name,
    ),
  );
  if (legacy.length)
    throw new Error(
      `legacy_wp3_migration_history: ${legacy.join(', ')}; back up this database and reconcile its migration history before upgrading; no migration was applied`,
    );

  // DB dựng bằng 0000 trước khi có _migrations (ví dụ DB demo cũ): ghi nhận 0000 đã áp, KHÔNG
  // chạy lại (CREATE TYPE sẽ lỗi), để các migration sau áp lên dữ liệu hiện có.
  const first = names[0];
  if (first && done.size === 0) {
    const t = (await client.query("SELECT to_regclass('public.charge_points') AS t")).rows[0];
    if (t?.['t']) {
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [first]);
      done.add(first);
    }
  }

  const applied: string[] = [];
  for (const name of names) {
    if (done.has(name)) continue;
    const file = path.join(dir, `${name}.sql`);
    if (!existsSync(file)) throw new Error(`thiếu file migration ${file}`);
    await client.query(readFileSync(file, 'utf8'));
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }
  return applied;
}

/** DB sạch + toàn bộ migration. CHỈ dùng với DB test: lệnh này xoá cả schema public. */
export async function resetAndMigrate(client: Queryable): Promise<string[]> {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  return migrate(client);
}
