/**
 * Test tích hợp migration 0024 (T32 Phần 8b bổ sung, WP5): bảng `top_up_payment_conflicts` ghi các
 * lần trả thành công mâu thuẫn trên top-up (Ân chốt 16/11).
 *
 * Vì sao tồn tại: hỏng âm thầm có thể là migration đụng dữ liệu top-up đang có; UNIQUE sai cột
 * (một cột `gateway_transaction_no` thì không ghi được hai top-up, chỉ `top_up_id` thì mất lần trả
 * mâu thuẫn thứ hai); cho đánh dấu "đã xem" mà không biết ai / không ghi đã xử lý thế nào; số tiền
 * âm; hoặc schema TS lệch DB.
 *
 * Phần 1: tĩnh (số file). Phần 2: DB ngay trước 0024 có seed demo + seed-app + top-up → migrate →
 * dữ liệu giữ nguyên. Phần 3: DB sạch (0000 → mới nhất): ràng buộc, index, COMMENT, schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì describe DB bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { topUpPaymentConflicts } from '../src/db/schema/billing.js';
import { paymentResultSourceEnum, topUpPaymentConflictReasonEnum } from '../src/db/schema/enums.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0024 = '0024_top-up-payment-conflicts';
const BEFORE = listMigrations().filter((n) => n < M0024);
// Migration đến sau 0024: migrate() áp cả chúng sau 0024.
const AFTER = listMigrations().filter((n) => n > M0024);
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

describe('migration 0024 — tĩnh', () => {
  it('chỉ một file mang số 0024, đứng sau 0022 (0023 để cho T134, có hay chưa đều được)', () => {
    expect(listMigrations().filter((n) => n.startsWith('0024'))).toEqual([M0024]);
    expect(BEFORE).toContain('0022_anh-mau-xe');
    expect(BEFORE.filter((n) => n > '0022_anh-mau-xe').every((n) => n.startsWith('0023'))).toBe(
      true,
    );
  });
});

describeDb('migration 0024 — top_up_payment_conflicts (T32 Phần 8b)', () => {
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

  /** Top-up credited ghi thẳng bằng SQL (tài xế + tài khoản mới). */
  async function creditedTopUp(): Promise<number> {
    seq += 1;
    const user = (
      await one(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m24-${seq}@t`],
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
           VALUES ($1, $2, 100000, 100000, 'credited', $3, $4, now() + interval '15 minutes', now())
           RETURNING id`,
          [`M24REF${seq}`, acc, String(90_000_000 + seq), `m24-key-${seq}`],
        )
      )['id'],
    );
  }

  async function admin(): Promise<number> {
    seq += 1;
    const user = Number(
      (
        await one(
          `INSERT INTO users (email, full_name, role) VALUES ($1, 'A', 'admin') RETURNING id`,
          [`m24-admin-${seq}@t`],
        )
      )['id'],
    );
    await q('INSERT INTO admins (user_id) VALUES ($1)', [user]);
    return user;
  }

  const insert = (topUpId: number, over: Record<string, unknown> = {}) => {
    const v = {
      gateway_transaction_no: '91000001',
      amount_vnd: 100_000,
      source: 'ipn',
      reason: 'extra_payment',
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
      ...over,
    };
    return q(
      `INSERT INTO top_up_payment_conflicts (top_up_id, gateway_transaction_no, amount_vnd, paid_at,
         source, reason, reviewed_at, reviewed_by, review_note)
       VALUES ($1, $2, $3, now(), $4::payment_result_source, $5::top_up_payment_conflict_reason,
         $6::timestamptz, $7, $8)
       RETURNING id`,
      [
        topUpId,
        v.gateway_transaction_no,
        v.amount_vnd,
        v.source,
        v.reason,
        v.reviewed_at,
        v.reviewed_by,
        v.review_note,
      ],
    );
  };

  it('nâng cấp DB có seed + top-up: áp 0024, dữ liệu top_ups giữ nguyên, bảng mới rỗng; chạy lại không áp gì', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
    await creditedTopUp();
    const before = await q('SELECT * FROM top_ups ORDER BY id');
    expect(before.length).toBeGreaterThan(0);

    expect(await migrate(db.$client)).toEqual([M0024, ...AFTER]);
    // Cột do migration sau 0024 thêm (0027: unfinished_claims) không thuộc phạm vi test này.
    const after = (await q('SELECT * FROM top_ups ORDER BY id')).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k in before[0]!)),
    );
    expect(after).toEqual(before);
    expect(await q('SELECT count(*)::int AS n FROM top_up_payment_conflicts')).toEqual([{ n: 0 }]);
    expect(await migrate(db.$client)).toEqual([]);
  });

  describe('DB sạch (0000 → mới nhất): ràng buộc và schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('dòng hợp lệ; created_at / updated_at mặc định now(); chưa xem', async () => {
      const t = await creditedTopUp();
      const [row] = await insert(t);
      const r = await one(
        `SELECT reviewed_at, reviewed_by, review_note, created_at IS NOT NULL AS c,
                updated_at IS NOT NULL AS u FROM top_up_payment_conflicts WHERE id=$1`,
        [row!['id']],
      );
      expect(r).toEqual({
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
        c: true,
        u: true,
      });
    });

    it('UNIQUE theo cặp (top_up_id, gateway_transaction_no): cùng top-up cùng txn → 23505; cùng top-up khác txn, hoặc cùng txn khác top-up → được', async () => {
      const a = await creditedTopUp();
      const b = await creditedTopUp();
      await insert(a, { gateway_transaction_no: '92000001' });
      await expect(insert(a, { gateway_transaction_no: '92000001' })).rejects.toMatchObject({
        code: '23505',
        constraint: 'top_up_payment_conflicts_top_up_txn_key',
      });
      await insert(a, { gateway_transaction_no: '92000002' });
      await insert(b, { gateway_transaction_no: '92000001' });
    });

    it('amount_vnd < 0 → CHECK; 0 được', async () => {
      const t = await creditedTopUp();
      await expect(insert(t, { amount_vnd: -1 })).rejects.toMatchObject({
        code: '23514',
        constraint: 'top_up_payment_conflicts_amount_check',
      });
      await insert(t, { gateway_transaction_no: '93000001', amount_vnd: 0 });
    });

    it('reviewed_at / reviewed_by cùng có hoặc cùng trống; đã xem thì review_note bắt buộc, không rỗng', async () => {
      const t = await creditedTopUp();
      const a = await admin();
      await expect(
        insert(t, {
          gateway_transaction_no: '94000001',
          reviewed_at: new Date(),
          review_note: 'x',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'top_up_payment_conflicts_reviewed_check',
      });
      await expect(
        insert(t, { gateway_transaction_no: '94000002', reviewed_by: a, review_note: 'x' }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'top_up_payment_conflicts_reviewed_check',
      });
      for (const [i, note] of [null, '', '   '].entries())
        await expect(
          insert(t, {
            gateway_transaction_no: `9400001${i}`,
            reviewed_at: new Date(),
            reviewed_by: a,
            review_note: note,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'top_up_payment_conflicts_review_note_check',
        });
      await insert(t, {
        gateway_transaction_no: '94000020',
        reviewed_at: new Date(),
        reviewed_by: a,
        review_note: 'Đã tra soát với VNPay, hoàn tay',
      });
    });

    it('FK: top_up_id phải có; reviewed_by phải là admins (user không phải admin → 23503)', async () => {
      await expect(insert(999_999_999)).rejects.toMatchObject({ code: '23503' });
      const t = await creditedTopUp();
      seq += 1;
      const driverUser = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
            [`m24-notadmin-${seq}@t`],
          )
        )['id'],
      );
      await expect(
        insert(t, {
          gateway_transaction_no: '95000001',
          reviewed_at: new Date(),
          reviewed_by: driverUser,
          review_note: 'x',
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'top_up_payment_conflicts_reviewed_by_fkey',
      });
    });

    it('enum, index (partial chưa xem, reviewed_by), FK NO ACTION, COMMENT', async () => {
      expect(
        await q(
          `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS v
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE t.typname IN ('payment_result_source', 'top_up_payment_conflict_reason')
           GROUP BY t.typname ORDER BY t.typname`,
        ),
      ).toEqual([
        { typname: 'payment_result_source', v: ['ipn', 'querydr', 'recheck'] },
        { typname: 'top_up_payment_conflict_reason', v: ['extra_payment', 'amount_differs'] },
      ]);
      const idx = await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'top_up_payment_conflicts'
         ORDER BY indexname`,
      );
      expect(idx.map((r) => r['indexname'])).toEqual([
        'top_up_payment_conflicts_pkey',
        'top_up_payment_conflicts_reviewed_by_idx',
        'top_up_payment_conflicts_top_up_txn_key',
        'top_up_payment_conflicts_unreviewed_idx',
      ]);
      expect(
        String(
          idx.find((r) => r['indexname'] === 'top_up_payment_conflicts_unreviewed_idx')![
            'indexdef'
          ],
        ),
      ).toMatch(/\(created_at\) WHERE \(reviewed_at IS NULL\)/);
      expect(
        await q(
          `SELECT conname, confdeltype AS d FROM pg_constraint
           WHERE conrelid = 'top_up_payment_conflicts'::regclass AND contype = 'f' ORDER BY conname`,
        ),
      ).toEqual([
        { conname: 'top_up_payment_conflicts_reviewed_by_fkey', d: 'a' },
        { conname: 'top_up_payment_conflicts_top_up_id_fkey', d: 'a' },
      ]);
      const comment = await one(
        `SELECT obj_description('top_up_payment_conflicts'::regclass, 'pg_class') AS t,
                col_description('top_up_payment_conflicts'::regclass,
                  (SELECT attnum FROM pg_attribute WHERE attrelid = 'top_up_payment_conflicts'::regclass
                   AND attname = 'review_note')) AS n`,
      );
      expect(String(comment['t'])).toContain('không có nút hoàn');
      expect(String(comment['n'])).toContain('Bắt buộc');
    });

    it('billing.ts / enums.ts khai khớp: cột, UNIQUE, CHECK, index', () => {
      const t = getTableConfig(topUpPaymentConflicts);
      const col = (n: string) => t.columns.find((c) => c.name === n)!;
      for (const n of [
        'top_up_id',
        'gateway_transaction_no',
        'amount_vnd',
        'paid_at',
        'source',
        'reason',
      ])
        expect(col(n).notNull).toBe(true);
      for (const n of ['reviewed_at', 'reviewed_by', 'review_note'])
        expect(col(n).notNull).toBe(false);
      expect(col('gateway_transaction_no').getSQLType()).toBe('varchar(100)');
      expect(col('source').getSQLType()).toBe('payment_result_source');
      expect(col('reason').getSQLType()).toBe('top_up_payment_conflict_reason');
      expect(t.uniqueConstraints.map((u) => u.getName())).toEqual([
        'top_up_payment_conflicts_top_up_txn_key',
      ]);
      expect(t.uniqueConstraints[0]!.columns.map((c) => c.name)).toEqual([
        'top_up_id',
        'gateway_transaction_no',
      ]);
      expect(t.checks.map((c) => c.name).sort()).toEqual([
        'top_up_payment_conflicts_amount_check',
        'top_up_payment_conflicts_review_note_check',
        'top_up_payment_conflicts_reviewed_check',
      ]);
      expect(t.indexes.map((i) => i.config.name).sort()).toEqual([
        'top_up_payment_conflicts_reviewed_by_idx',
        'top_up_payment_conflicts_unreviewed_idx',
      ]);
      expect(paymentResultSourceEnum.enumValues).toEqual(['ipn', 'querydr', 'recheck']);
      expect(topUpPaymentConflictReasonEnum.enumValues).toEqual([
        'extra_payment',
        'amount_differs',
      ]);
    });
  });
});
