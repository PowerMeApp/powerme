/**
 * Test tích hợp migration 0002 (T61, ADR-0016 D-C): thêm is_online / online_changed_at và backfill
 * lifecycle legacy `offline`.
 *
 * Vì sao tồn tại: 0002 sửa DỮ LIỆU đang có (UPDATE lifecycle) trên bảng người dùng thật. Test dựng
 * DB "như demo đã có 0001" (0000 + 0001 + bảng _migrations + vài trụ ở đủ các lifecycle), gọi
 * helper `migrate` (cùng logic demo/migrate.mjs) và kiểm: chỉ 0002 được áp, hàng `offline` →
 * `in_service` + `is_online=false`, hàng khác KHÔNG bị đụng, giá trị enum `offline` vẫn còn.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, Db } from '../src/db/db.module.js';
import { MIGRATIONS_DIR, migrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('migration 0002 — tách kết nối khỏi lifecycle (nâng cấp DB đã có 0001)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const f of ['0000_init.sql', '0001_quyet-dinh-be-11.sql']) {
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ('0000_init'), ('0001_quyet-dinh-be-11');`,
    );
    // Trụ ở đủ lifecycle; last_message_at đặt để chắc chắn backfill không sửa nó.
    await q(
      `INSERT INTO charge_points (serial_number, lifecycle, last_message_at, current_epoch) VALUES
         ('M2-REG', 'registered', NULL, 0),
         ('M2-AWT', 'awaiting_connection', NULL, 0),
         ('M2-INS', 'in_service', '2026-10-20T10:00:00Z', 3),
         ('M2-OFF', 'offline', '2026-10-20T11:00:00Z', 4),
         ('M2-OFF2', 'offline', '2026-10-20T12:00:00Z', 1),
         ('M2-DIS', 'disabled', '2026-10-20T13:00:00Z', 2),
         ('M2-DEC', 'decommissioned', NULL, 0)`,
    );
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  it('migrate() chỉ áp 0002 (0000 và 0001 đã ghi trong _migrations)', async () => {
    expect(await migrate(db.$client)).toEqual(['0002_tach-ket-noi-khoi-lifecycle']);
    expect(await migrate(db.$client)).toEqual([]); // chạy lại không áp gì
  });

  it('(f) hàng lifecycle=offline → in_service + is_online=false; last_message_at/epoch giữ nguyên', async () => {
    const rows = await q(
      `SELECT serial_number, lifecycle::text, is_online, online_changed_at, last_message_at, current_epoch
         FROM charge_points WHERE serial_number LIKE 'M2-OFF%' ORDER BY serial_number`,
    );
    expect(rows.map((r) => [r['serial_number'], r['lifecycle'], r['is_online']])).toEqual([
      ['M2-OFF', 'in_service', false],
      ['M2-OFF2', 'in_service', false],
    ]);
    expect((rows[0]?.['last_message_at'] as Date).toISOString()).toBe('2026-10-20T11:00:00.000Z');
    expect(rows[0]?.['current_epoch']).toBe(4);
    expect(rows[0]?.['online_changed_at']).toBeNull();
  });

  it('hàng không phải offline KHÔNG bị đổi lifecycle; mọi hàng cũ is_online=false', async () => {
    const rows = await q(
      `SELECT serial_number, lifecycle::text, is_online FROM charge_points
        WHERE serial_number NOT LIKE 'M2-OFF%' ORDER BY serial_number`,
    );
    expect(rows.map((r) => [r['serial_number'], r['lifecycle']])).toEqual([
      ['M2-AWT', 'awaiting_connection'],
      ['M2-DEC', 'decommissioned'],
      ['M2-DIS', 'disabled'],
      ['M2-INS', 'in_service'],
      ['M2-REG', 'registered'],
    ]);
    expect(rows.every((r) => r['is_online'] === false)).toBe(true);
  });

  it('cột mới: is_online boolean NOT NULL default false; online_changed_at timestamptz NULL', async () => {
    const cols = await q(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'charge_points' AND column_name IN ('is_online', 'online_changed_at')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      {
        column_name: 'is_online',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
      {
        column_name: 'online_changed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    // Không thêm cột trùng last_seen_at: last_message_at đóng vai đó.
    expect(
      await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'charge_points' AND column_name = 'last_seen_at'`,
      ),
    ).toHaveLength(0);
  });

  it('giá trị enum legacy `offline` vẫn còn (không xoá được an toàn) nhưng không còn hàng nào dùng', async () => {
    const labels = (
      await q(`SELECT unnest(enum_range(NULL::charge_point_lifecycle))::text AS v`)
    ).map((r) => r['v']);
    expect(labels).toContain('offline');
    expect(await q(`SELECT 1 FROM charge_points WHERE lifecycle = 'offline'`)).toHaveLength(0);
  });
});
