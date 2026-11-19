/**
 * Test tích hợp migration 0025 (T32 Phần 7, WP5): cột `e_invoices.vat_rate` lưu thuế suất GTGT đã
 * dùng cho hoá đơn (Khang chốt 17/11).
 *
 * Vì sao tồn tại: hỏng âm thầm có thể là backfill sai mốc (thuế suất theo lúc chạy migration thay
 * vì lúc thu tiền, hoặc mốc theo UTC thay vì giờ Việt Nam), cột để NULL / có DEFAULT (code quên
 * truyền thuế suất mà DB vẫn nhận), CHECK nhận giá trị lạ, hoặc schema TS lệch DB.
 *
 * Phần 1: tĩnh (số file). Phần 2: DB ngay trước 0025 có hoá đơn hai phía mốc → migrate → backfill
 * 8 / 10, các cột khác giữ nguyên. Phần 3: DB sạch (0000 → mới nhất): ràng buộc, COMMENT, schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì describe DB bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { eInvoices } from '../src/db/schema/billing.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0025 = '0025_e-invoice-vat-rate';
const BEFORE = listMigrations().filter((n) => n < M0025);
const AFTER = listMigrations().filter((n) => n > M0025);

describe('migration 0025 — tĩnh', () => {
  it('chỉ một file mang số 0025, đứng sau 0024 (0023 để cho T134, có hay chưa đều được)', () => {
    expect(listMigrations().filter((n) => n.startsWith('0025'))).toEqual([M0025]);
    expect(BEFORE).toContain('0024_top-up-payment-conflicts');
  });
});

describeDb('migration 0025 — e_invoices.vat_rate (T32 Phần 7)', () => {
  let db: Db;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  /** Top-up credited ghi thẳng bằng SQL (tài xế + tài khoản mới); `completedAt` null = cột trống. */
  async function creditedTopUp(completedAt: string | null): Promise<number> {
    seq += 1;
    const user = (
      await one(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m25-${seq}@t`],
      )
    )['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    const acc = (
      await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user])
    )['id'];
    return Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
             status, gateway_transaction_no, idempotency_key, expires_at, completed_at)
           VALUES ($1, $2, 100000, 100000, 'credited', $3, $4, now() + interval '15 minutes',
             $5::timestamptz)
           RETURNING id`,
          [`M25REF${seq}`, acc, String(95_000_000 + seq), `m25-key-${seq}`, completedAt],
        )
      )['id'],
    );
  }

  it('nâng cấp DB có hoá đơn: backfill theo thời điểm thu tiền (giờ Việt Nam), cột khác giữ nguyên; chạy lại không áp gì', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    const cases: [string | null, string | null, number][] = [
      // [completed_at, created_at của hoá đơn (null = mặc định now()), thuế suất mong đợi]
      ['2026-12-31T23:59:59.999+07:00', null, 8],
      ['2027-01-01T00:00:00+07:00', null, 10],
      // 17:30 UTC ngày 31/12 = 00:30 ngày 01/01 giờ Việt Nam.
      ['2026-12-31T17:30:00Z', null, 10],
      // Thiếu completed_at → lấy created_at của hoá đơn.
      [null, '2027-03-01T08:00:00+07:00', 10],
      [null, '2026-11-17T08:00:00+07:00', 8],
    ];
    const ids: number[] = [];
    for (const [completedAt, createdAt] of cases) {
      const t = await creditedTopUp(completedAt);
      ids.push(
        Number(
          (
            await one(
              `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_amount_vnd, created_at)
               VALUES ($1, 'requested', 100000, 7407, COALESCE($2::timestamptz, now()))
               RETURNING id`,
              [t, createdAt],
            )
          )['id'],
        ),
      );
    }
    const cols = `id, top_up_id, status::text, amount_vnd, vat_amount_vnd, attempt_count,
                  next_attempt_at, created_at`;
    const before = await q(`SELECT ${cols} FROM e_invoices ORDER BY id`);

    expect(await migrate(db.$client)).toEqual([M0025, ...AFTER]);
    expect(await q(`SELECT ${cols} FROM e_invoices ORDER BY id`)).toEqual(before);
    const rates = await q('SELECT id, vat_rate FROM e_invoices ORDER BY id');
    expect(rates).toEqual(ids.map((id, i) => ({ id: String(id), vat_rate: cases[i]![2] })));
    expect(await migrate(db.$client)).toEqual([]);
  });

  describe('DB sạch (0000 → mới nhất): ràng buộc và schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    const insert = async (rate: unknown) =>
      q(
        `INSERT INTO e_invoices (top_up_id, amount_vnd, vat_rate, vat_amount_vnd)
         VALUES ($1, 100000, $2, 7407) RETURNING id`,
        [await creditedTopUp('2026-11-17T08:00:00+07:00'), rate],
      );

    it('vat_rate NOT NULL, không DEFAULT: bỏ cột hoặc NULL → 23502', async () => {
      const t = await creditedTopUp('2026-11-17T08:00:00+07:00');
      await expect(
        q('INSERT INTO e_invoices (top_up_id, amount_vnd, vat_amount_vnd) VALUES ($1, 1, 0)', [t]),
      ).rejects.toMatchObject({ code: '23502' });
      await expect(insert(null)).rejects.toMatchObject({ code: '23502' });
      expect(
        await one(
          `SELECT is_nullable, column_default, data_type FROM information_schema.columns
           WHERE table_name = 'e_invoices' AND column_name = 'vat_rate'`,
        ),
      ).toEqual({ is_nullable: 'NO', column_default: null, data_type: 'smallint' });
    });

    it('CHECK e_invoices_vat_rate_check: 0 / 5 / 8 / 10 được; 7, 100, -8 → 23514', async () => {
      for (const ok of [0, 5, 8, 10]) await insert(ok);
      for (const bad of [7, 100, -8])
        await expect(insert(bad)).rejects.toMatchObject({
          code: '23514',
          constraint: 'e_invoices_vat_rate_check',
        });
    });

    it('COMMENT cột ghi thuế suất theo thời điểm thu tiền và dùng cho hoá đơn điều chỉnh', async () => {
      const c = await one(
        `SELECT col_description('e_invoices'::regclass,
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'e_invoices'::regclass
            AND attname = 'vat_rate')) AS c`,
      );
      expect(String(c['c'])).toContain('thời điểm thu tiền');
      expect(String(c['c'])).toContain('adjustForRefund');
    });

    it('billing.ts khai khớp: vat_rate smallint NOT NULL, không default, CHECK cùng tên', () => {
      const t = getTableConfig(eInvoices);
      const col = t.columns.find((c) => c.name === 'vat_rate')!;
      expect(col.getSQLType()).toBe('smallint');
      expect(col.notNull).toBe(true);
      expect(col.hasDefault).toBe(false);
      expect(t.checks.map((c) => c.name)).toContain('e_invoices_vat_rate_check');
    });
  });
});
