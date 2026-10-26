/**
 * Test tích hợp `scripts/migrate.mjs` — tập lệnh mà image staging chạy trước khi khởi động CSMS
 * (infra/staging/deploy.sh: `docker compose run --rm csms node scripts/migrate.mjs`).
 *
 * Vì sao tồn tại: deploy.sh dựa vào mã thoát (0 = xong, ≠ 0 = dừng, không khởi động app trên
 * schema nửa vời) và vào việc chạy lại không áp gì. Test chạy script như một tiến trình Node thật
 * (đúng cách image gọi) trên DB sạch rồi kiểm bảng `_migrations`.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createDb, Db } from '../src/db/db.module.js';
import { listMigrations } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate.mjs');

function runScript(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describeDb('scripts/migrate.mjs — tập lệnh migrate của image staging', () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('DB sạch: áp mọi file theo thứ tự, thoát 0, bảng _migrations khớp thư mục drizzle/', async () => {
    const r = runScript({ DATABASE_URL: DATABASE_URL as string });
    expect(r.code).toBe(0);
    const names = listMigrations();
    for (const n of names) expect(r.out).toContain(`drizzle/${n}.sql`);
    const rows = (await db.$client.query('SELECT name FROM _migrations ORDER BY name')).rows;
    expect(rows.map((x: { name: string }) => x.name)).toEqual(names);
  });

  it('chạy lần hai: thoát 0 và không áp gì thêm (idempotent)', async () => {
    const before = (
      await db.$client.query('SELECT name, applied_at FROM _migrations ORDER BY name')
    ).rows;
    const r = runScript({ DATABASE_URL: DATABASE_URL as string });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/đã áp drizzle\//);
    const after = (await db.$client.query('SELECT name, applied_at FROM _migrations ORDER BY name'))
      .rows;
    expect(after).toEqual(before);
  });

  it('thiếu DATABASE_URL → thoát 2; DB không nối được → thoát 1 (deploy.sh dừng, không khởi động app)', () => {
    expect(runScript({}).code).toBe(2);
    const bad = runScript({ DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z' });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('LỖI');
  });
});
