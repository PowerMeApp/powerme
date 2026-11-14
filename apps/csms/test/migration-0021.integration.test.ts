/**
 * Test tích hợp migration 0021 (T32 Phần 6): khoản trễ trên mọi trạng thái trừ pending, lịch
 * querydr `next_attempt_at`, ngoại lệ top-up (`exception_kind`, `exception_reviewed_at`), một dòng
 * loyalty `adjust` mỗi top-up, COMMENT sửa theo D1.
 *
 * Vì sao tồn tại: IPN (Phần 6) và querydr (Phần 8) dựa vào các ràng buộc này. Hỏng âm thầm có thể
 * là: CHECK cũ chặn lần trả thứ hai (IPN 99 mãi, VNPay gọi lại 10 lần rồi bỏ, tiền không ai hoàn),
 * khoản trễ lọt vào top-up pending, top-up pending cũ không có lịch querydr (Phần 8 không bao giờ
 * quét tới), ngoại lệ gắn sai trạng thái, hai dòng adjust cho một top-up, migrate lặng lẽ "chọn"
 * một trong hai dòng adjust trùng của dữ liệu cũ, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0021 (có seed demo + seed-app + top-up pending / credited) → migrate.
 * Phần 2: dữ liệu cũ có hai dòng adjust cùng top-up → migrate từ chối, nêu top_up_id.
 * Phần 3: DB sạch (0000 → mới nhất): từng ràng buộc + đối chiếu schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { loyaltyTransactions, topUps } from '../src/db/schema/billing.js';
import { topUpExceptionKindEnum } from '../src/db/schema/enums.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0021 = '0021_top-up-ipn-ngoai-le';
// Migration đến sau 0021 (0022 …): migrate() áp cả chúng sau 0021.
const AFTER = listMigrations().filter((n) => n > M0021);
const BEFORE_0021 = listMigrations().filter((n) => n < '0021');
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

const STATUSES = ['pending', 'credited', 'failed', 'expired', 'refunded'] as const;
type Status = (typeof STATUSES)[number];

describeDb('migration 0021 — top-up IPN, khoản trễ, querydr, ngoại lệ (T32 Phần 6)', () => {
  let db: Db;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

  async function buildBefore0021(): Promise<void> {
    await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE_0021)
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await q(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE_0021.map((n) => `('${n}')`).join(', ')};`,
    );
  }

  /** Tài xế mới + tài khoản credit + loyalty; trả {account, loyalty}. */
  async function accounts(): Promise<{ account: string; loyalty: string }> {
    seq += 1;
    const user = (
      await q(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m21-${seq}@t`],
      )
    )[0]!['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    const account = String(
      (await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user]))['id'],
    );
    const loyalty = String(
      (await one('INSERT INTO loyalty_accounts (driver_id) VALUES ($1) RETURNING id', [user]))[
        'id'
      ],
    );
    return { account, loyalty };
  }

  /** Top-up ghi thẳng bằng SQL; `extra` là cột thêm (tên → biểu thức SQL đã an toàn). */
  async function topUp(
    acc: string,
    status: Status,
    extra: Record<string, string> = {},
  ): Promise<string> {
    seq += 1;
    const cols = Object.keys(extra);
    const vals = cols.map((c) => extra[c]);
    return String(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
             status, idempotency_key, expires_at, refunded_at${cols.map((c) => `, ${c}`).join('')})
           VALUES ($1, $2, 100000, 100000, $3::top_up_status, $4, now() + interval '15 minutes',
             CASE WHEN $3 = 'refunded' THEN now() END${vals.map((v) => `, ${v}`).join('')})
           RETURNING id`,
          [`M21REF${seq}`, acc, status, `m21-key-${seq}`],
        )
      )['id'],
    );
  }

  const late = (ref: string) => ({
    late_gateway_ref: `'${ref}'`,
    late_paid_at: 'now()',
    late_amount_vnd: '100000',
  });

  async function adjust(loyalty: string, topUpId: string, entryNo: number) {
    await q(
      `INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points, top_up_id)
       VALUES ($1, $2, 'adjust', 0, $3)`,
      [loyalty, entryNo, topUpId],
    );
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('0021 là migration kế tiếp sau 0020 và chỉ có một file mang số 0021', () => {
    expect(listMigrations().filter((n) => n.startsWith('0021'))).toEqual([M0021]);
    expect(BEFORE_0021[BEFORE_0021.length - 1]).toBe('0020_t101_tariff_clock');
  });

  describe('đường nâng cấp: DB ngay trước 0021 có seed demo + seed-app + top-up cũ', () => {
    let before: Record<string, unknown>[] = [];
    let pendingId = '';
    let creditedId = '';
    let applied: string[] = [];

    beforeAll(async () => {
      await buildBefore0021();
      await q(SEED_SQL);
      await q(SEED_APP_SQL);
      const a = await accounts();
      pendingId = await topUp(a.account, 'pending');
      creditedId = await topUp((await accounts()).account, 'credited');
      before = await q('SELECT id, status, expires_at, completed_at FROM top_ups ORDER BY id');
      applied = await migrate(db.$client);
    });

    it('áp 0021; dữ liệu top-up cũ giữ nguyên; backfill next_attempt_at = expires_at + 2 phút chỉ cho pending', async () => {
      expect(applied).toEqual([M0021, ...AFTER]);
      expect(
        await q('SELECT id, status, expires_at, completed_at FROM top_ups ORDER BY id'),
      ).toEqual(before);
      const rows = await q(
        `SELECT id::text, status::text,
           next_attempt_at = expires_at + interval '2 minutes' AS backfilled,
           next_attempt_at IS NULL AS is_null, exception_kind, exception_reviewed_at
         FROM top_ups ORDER BY id`,
      );
      expect(rows.length).toBeGreaterThan(2);
      for (const r of rows) {
        if (r['status'] === 'pending') expect(r['backfilled']).toBe(true);
        else expect(r['is_null']).toBe(true);
        expect(r['exception_kind']).toBeNull();
        expect(r['exception_reviewed_at']).toBeNull();
      }
      expect(rows.find((r) => r['id'] === pendingId)!['backfilled']).toBe(true);
      expect(rows.find((r) => r['id'] === creditedId)!['is_null']).toBe(true);
    });

    it('CHECK, index, enum và COMMENT đúng', async () => {
      const defs = Object.fromEntries(
        (
          await q(
            `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'top_ups'::regclass AND conname IN
               ('top_ups_late_payment_status_check','top_ups_exception_reviewed_check',
                'top_ups_exception_kind_status_check')`,
          )
        ).map((r) => [r['conname'], r['def']]),
      );
      expect(defs['top_ups_late_payment_status_check']).toBe(
        "CHECK (((late_gateway_ref IS NULL) OR (status <> 'pending'::top_up_status)))",
      );
      expect(defs['top_ups_exception_reviewed_check']).toBe(
        'CHECK (((exception_reviewed_at IS NULL) OR (exception_kind IS NOT NULL)))',
      );
      expect(defs['top_ups_exception_kind_status_check']).toContain('loyalty_error');
      expect(
        await q(
          `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN
             ('top_ups_pending_next_attempt_idx','loyalty_transactions_one_adjust_per_top_up')
           ORDER BY indexname`,
        ),
      ).toEqual([
        {
          indexname: 'loyalty_transactions_one_adjust_per_top_up',
          indexdef:
            "CREATE UNIQUE INDEX loyalty_transactions_one_adjust_per_top_up ON public.loyalty_transactions USING btree (top_up_id) WHERE ((transaction_type = 'adjust'::loyalty_transaction_type) AND (top_up_id IS NOT NULL))",
        },
        {
          indexname: 'top_ups_pending_next_attempt_idx',
          indexdef:
            "CREATE INDEX top_ups_pending_next_attempt_idx ON public.top_ups USING btree (next_attempt_at) WHERE (status = 'pending'::top_up_status)",
        },
      ]);
      expect((await one(`SELECT enum_range(NULL::top_up_exception_kind)::text AS r`))['r']).toBe(
        '{unresolved_04,unresolved_07,loyalty_error}',
      );

      const comment = async (table: string, col: string) =>
        String(
          (
            await one(
              `SELECT col_description($1::regclass, attnum) AS c FROM pg_attribute
               WHERE attrelid = $1::regclass AND attname = $2`,
              [table, col],
            )
          )['c'],
        );
      const lateRef = await comment('top_ups', 'late_gateway_ref');
      expect(lateRef).toContain('vnp_TransactionNo');
      expect(lateRef).toContain('credited / refunded');
      expect(lateRef).not.toMatch(/cửa sổ 1 giờ|LATE_WINDOW/);
      expect(await comment('top_ups', 'late_paid_at')).toContain('vnp_PayDate');
      expect(await comment('top_ups', 'late_amount_vnd')).toContain('vnp_Amount / 100');
      expect(await comment('top_ups', 'next_attempt_at')).toContain('+ 5, 10, 20, 40, 60 phút');
      expect(await comment('top_ups', 'exception_kind')).toContain('loyalty_error');
      expect(await comment('top_ups', 'exception_reviewed_at')).toContain('Phần 10');
      expect(await comment('top_ups', 'completed_at')).toContain('rời pending');
      const closure = await comment('credit_accounts', 'closure_refunded_at');
      expect(closure).toContain('account_closure');
      expect(closure).toContain('= closed_at');
      expect(closure).not.toContain('không có gì để hoàn');
    });

    it('seed demo + seed-app chạy lại trên DB đã 0021 không lỗi, không thêm dòng', async () => {
      const n = await q('SELECT count(*)::int AS n FROM top_ups');
      await q(SEED_SQL);
      await q(SEED_APP_SQL);
      expect(await q('SELECT count(*)::int AS n FROM top_ups')).toEqual(n);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('dữ liệu cũ có hai dòng adjust cùng top-up → migrate từ chối, không sửa gì', () => {
    it('thông báo nêu top_up_id kèm số dòng; _migrations và dữ liệu giữ nguyên; sửa tay xong thì chạy được', async () => {
      await buildBefore0021();
      const a = await accounts();
      const dup = await topUp(a.account, 'credited');
      const ok = await topUp(a.account, 'credited');
      await adjust(a.loyalty, dup, 1);
      await adjust(a.loyalty, dup, 2);
      await adjust(a.loyalty, ok, 3);
      const before = await q('SELECT id, top_up_id FROM loyalty_transactions ORDER BY id');

      const err = await migrate(db.$client).then(
        () => null,
        (error: unknown) => error as { message: string; code?: string },
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('23505');
      expect(err!.message).toContain(`top_up_id ${dup} (2 dòng)`);
      expect(err!.message).not.toContain(`top_up_id ${ok}`);
      expect(await q('SELECT id, top_up_id FROM loyalty_transactions ORDER BY id')).toEqual(before);
      expect(await q('SELECT 1 FROM _migrations WHERE name = $1', [M0021])).toEqual([]);
      expect(
        await q(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'top_ups' AND column_name = 'next_attempt_at'`,
        ),
      ).toEqual([]);

      await q(`DELETE FROM loyalty_transactions WHERE top_up_id = $1 AND entry_no = 2`, [dup]);
      expect(await migrate(db.$client)).toEqual([M0021, ...AFTER]);
    });
  });

  describe('DB sạch (0000 → mới nhất): ràng buộc và schema TS', () => {
    let acc: { account: string; loyalty: string };

    beforeAll(async () => {
      await resetAndMigrate(db.$client);
      acc = await accounts();
    });

    it.each(['credited', 'refunded', 'failed', 'expired'] as const)(
      'khoản trễ trên %s → được',
      async (status) => {
        await topUp((await accounts()).account, status, late(`LATE-${status}`));
      },
    );

    it('khoản trễ trên pending → bị chặn', async () => {
      await expect(topUp(acc.account, 'pending', late('LATE-P'))).rejects.toMatchObject({
        code: '23514',
        constraint: 'top_ups_late_payment_status_check',
      });
    });

    it.each([
      ['loyalty_error', 'credited'],
      ['loyalty_error', 'refunded'],
      ['unresolved_04', 'expired'],
      ['unresolved_07', 'expired'],
    ] as const)(
      'exception_kind %s trên %s → được (kèm exception_reviewed_at)',
      async (kind, status) => {
        await topUp((await accounts()).account, status, {
          exception_kind: `'${kind}'`,
          exception_reviewed_at: 'now()',
        });
      },
    );

    it.each([
      ['loyalty_error', 'pending'],
      ['loyalty_error', 'failed'],
      ['loyalty_error', 'expired'],
      ['unresolved_04', 'pending'],
      ['unresolved_04', 'credited'],
      ['unresolved_07', 'failed'],
      ['unresolved_07', 'refunded'],
    ] as const)('exception_kind %s trên %s → bị chặn', async (kind, status) => {
      await expect(
        topUp((await accounts()).account, status, { exception_kind: `'${kind}'` }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'top_ups_exception_kind_status_check' });
    });

    it('exception_reviewed_at khi không có exception_kind → bị chặn', async () => {
      await expect(
        topUp((await accounts()).account, 'credited', { exception_reviewed_at: 'now()' }),
      ).rejects.toMatchObject({ code: '23514', constraint: 'top_ups_exception_reviewed_check' });
    });

    it('hai dòng adjust cùng top_up_id → 23505; adjust không gắn top-up và redeem cùng top-up không bị chặn', async () => {
      const a = await accounts();
      const t = await topUp(a.account, 'credited');
      await adjust(a.loyalty, t, 1);
      await expect(adjust(a.loyalty, t, 2)).rejects.toMatchObject({
        code: '23505',
        constraint: 'loyalty_transactions_one_adjust_per_top_up',
      });
      await q(
        `INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points)
         VALUES ($1, 3, 'adjust', 0), ($1, 4, 'adjust', 0)`,
        [a.loyalty],
      );
    });

    it('billing.ts / enums.ts khai đúng cột, CHECK, index mới', () => {
      const t = getTableConfig(topUps);
      const col = (n: string) => t.columns.find((c) => c.name === n);
      for (const n of ['next_attempt_at', 'exception_kind', 'exception_reviewed_at'])
        expect(col(n)?.notNull).toBe(false);
      expect(col('exception_kind')?.getSQLType()).toBe('top_up_exception_kind');
      expect(t.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'top_ups_late_payment_status_check',
          'top_ups_exception_reviewed_check',
          'top_ups_exception_kind_status_check',
        ]),
      );
      const idx = t.indexes.find((i) => i.config.name === 'top_ups_pending_next_attempt_idx')!;
      expect(idx.config.unique).toBe(false);
      expect(idx.config.columns.map((c) => (c as { name: string }).name)).toEqual([
        'next_attempt_at',
      ]);
      const l = getTableConfig(loyaltyTransactions).indexes.find(
        (i) => i.config.name === 'loyalty_transactions_one_adjust_per_top_up',
      )!;
      expect(l.config.unique).toBe(true);
      expect(topUpExceptionKindEnum.enumValues).toEqual([
        'unresolved_04',
        'unresolved_07',
        'loyalty_error',
      ]);
    });
  });
});
