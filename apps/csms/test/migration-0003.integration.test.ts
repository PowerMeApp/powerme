/**
 * Test tích hợp migration 0003 (T73): thuộc tính billing WF-02 của LERD-1 v0.4.
 *
 * Vì sao tồn tại: 0003 đổi nghĩa và đặt NOT NULL cho `top_ups.gateway_reference`, backfill rồi
 * NOT NULL `top_ups.expires_at`, thay UNIQUE ledger theo top-up, thêm giá trị enum
 * `loyalty_transaction_type.restore` và nhiều CHECK mới. Mỗi thứ có thể hỏng âm thầm trên DB đã có
 * dữ liệu billing (DB demo có một top-up + một dòng ledger từ demo/seed.sql).
 *
 * Phần 1 dựng DB "như demo đã có 0002" (0000 + 0001 + 0002 + `_migrations` + ví, top-up, ledger,
 * hoá đơn, điểm), gọi helper `migrate` (cùng logic scripts/migrate.mjs) và kiểm dữ liệu còn nguyên,
 * backfill đúng. Phần 2 kiểm ràng buộc trên chính DB đó (mỗi ràng buộc: ca hợp lệ và ca bị từ
 * chối). Phần 3 kiểm tiền kiểm: dữ liệu cũ vi phạm ràng buộc mới thì 0003 dừng, không áp gì.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createDb, Db } from '../src/db/db.module.js';
import { listMigrations, MIGRATIONS_DIR, migrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const BEFORE_0003 = ['0000_init', '0001_quyet-dinh-be-11', '0002_tach-ket-noi-khoi-lifecycle'];

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Chờ promise bị Postgres từ chối; trả lỗi để kiểm code/constraint/message. */
async function rejection(p: Promise<unknown>): Promise<PgError> {
  try {
    await p;
  } catch (err) {
    return err as PgError;
  }
  throw new Error('kỳ vọng Postgres từ chối nhưng câu lệnh đã chạy được');
}

/** DROP SCHEMA rồi dựng DB ở trạng thái 0002 (có `_migrations` ghi 0000–0002). */
async function buildAt0002(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const name of BEFORE_0003) {
    await query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
  }
  await query(
    `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
     INSERT INTO _migrations (name) VALUES ${BEFORE_0003.map((n) => `('${n}')`).join(', ')};`,
  );
}

describeDb('migration 0003 — billing WF-02 (nâng cấp DB đã có 0002)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};

  let accountId: number;
  let adminId: number;
  let creditedId: number;
  let pendingId: number;
  let loyaltyAccountId: number;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  describe('đường nâng cấp (DB ở 0002, có dữ liệu billing)', () => {
    beforeAll(async () => {
      await buildAt0002((sql) => db.$client.query(sql));
      const driverId = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m3.driver@test', 'Tai Xe', 'driver')
             RETURNING id`,
          )
        )['id'],
      );
      adminId = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m3.admin@test', 'Admin', 'admin')
             RETURNING id`,
          )
        )['id'],
      );
      await q(
        `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
        [driverId],
      );
      accountId = Number(
        (
          await one(
            `INSERT INTO credit_accounts (driver_id, status, balance_vnd) VALUES ($1, 'active', 200000)
             RETURNING id`,
            [driverId],
          )
        )['id'],
      );
      // Top-up credited (như demo/seed.sql) và một top-up pending; gateway_reference theo nghĩa cũ.
      creditedId = Number(
        (
          await one(
            `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_discount_vnd,
                                  amount_paid_vnd, status, idempotency_key, created_at, completed_at)
             VALUES ('M3-REF-1', $1, 200000, 0, 200000, 'credited', 'm3-idem-1',
                     '2026-10-20T10:00:00Z', '2026-10-20T10:01:00Z')
             RETURNING id`,
            [accountId],
          )
        )['id'],
      );
      pendingId = Number(
        (
          await one(
            `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_discount_vnd,
                                  amount_paid_vnd, status, idempotency_key, created_at)
             VALUES ('M3-REF-2', $1, 100000, 0, 100000, 'pending', 'm3-idem-2', '2026-10-21T08:00:00Z')
             RETURNING id`,
            [accountId],
          )
        )['id'],
      );
      await q(
        `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
                                          balance_after_vnd, top_up_id, created_at)
         VALUES ($1, 1, 'top_up', 200000, 200000, $2, '2026-10-20T10:01:00Z')`,
        [accountId, creditedId],
      );
      await q(
        `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_amount_vnd, attempt_count)
         VALUES ($1, 'requested', 200000, 18182, 0)`,
        [creditedId],
      );
      loyaltyAccountId = Number(
        (
          await one(
            `INSERT INTO loyalty_accounts (driver_id, points_balance) VALUES ($1, 500) RETURNING id`,
            [driverId],
          )
        )['id'],
      );
      await q(
        `INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points)
         VALUES ($1, 1, 'earn', 500)`,
        [loyaltyAccountId],
      );
    });

    it('(c) migrate() áp 0003 và các migration sau; _migrations khớp thư mục drizzle/; chạy lại không áp gì', async () => {
      expect(await migrate(db.$client)).toEqual(listMigrations().slice(BEFORE_0003.length));
      expect(await migrate(db.$client)).toEqual([]);
      const names = (await q('SELECT name FROM _migrations ORDER BY name')).map((r) => r['name']);
      expect(names.slice(0, BEFORE_0003.length)).toEqual(BEFORE_0003);
      expect(names).toEqual(listMigrations());
    });

    it('(a) dữ liệu cũ còn nguyên; expires_at backfill = created_at + 15 phút; cột mới rỗng', async () => {
      const rows = await q(
        `SELECT id, gateway_reference, status::text, amount_paid_vnd, points_redeemed, expires_at,
                gateway_transaction_no, refunded_at, refunded_by, late_gateway_ref, late_paid_at,
                late_amount_vnd, late_refunded_at
           FROM top_ups ORDER BY id`,
      );
      expect(
        rows.map((r) => [r['gateway_reference'], r['status'], Number(r['amount_paid_vnd'])]),
      ).toEqual([
        ['M3-REF-1', 'credited', 200000],
        ['M3-REF-2', 'pending', 100000],
      ]);
      expect(rows.map((r) => (r['expires_at'] as Date).toISOString())).toEqual([
        '2026-10-20T10:15:00.000Z',
        '2026-10-21T08:15:00.000Z',
      ]);
      for (const r of rows) {
        expect(r['points_redeemed']).toBe(0);
        for (const c of [
          'gateway_transaction_no',
          'refunded_at',
          'refunded_by',
          'late_gateway_ref',
          'late_paid_at',
          'late_amount_vnd',
          'late_refunded_at',
        ]) {
          expect(r[c]).toBeNull();
        }
      }
      const led = await q(
        `SELECT entry_no, transaction_type::text, amount_vnd, balance_after_vnd, top_up_id FROM credit_transactions`,
      );
      expect(
        led.map((r) => [Number(r['entry_no']), r['transaction_type'], Number(r['amount_vnd'])]),
      ).toEqual([[1, 'top_up', 200000]]);
      const acc = await one(
        `SELECT status::text, balance_vnd, closed_at, closure_refunded_at FROM credit_accounts`,
      );
      expect([
        acc['status'],
        Number(acc['balance_vnd']),
        acc['closed_at'],
        acc['closure_refunded_at'],
      ]).toEqual(['active', 200000, null, null]);
      const inv = await one(
        `SELECT status::text, attempt_count, last_error_kind, last_error_message, last_attempt_at FROM e_invoices`,
      );
      expect(inv).toEqual({
        status: 'requested',
        attempt_count: 0,
        last_error_kind: null,
        last_error_message: null,
        last_attempt_at: null,
      });
      expect(Number((await one(`SELECT count(*) AS n FROM loyalty_transactions`))['n'])).toBe(1);
    });

    it('cột mới đúng kiểu/nullable; gateway_reference và expires_at NOT NULL; COMMENT nói vnp_TxnRef', async () => {
      const cols = await q(
        `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE (table_name = 'top_ups' AND column_name IN ('gateway_reference', 'gateway_transaction_no',
                   'points_redeemed', 'expires_at', 'refunded_at', 'refunded_by', 'late_gateway_ref',
                   'late_paid_at', 'late_amount_vnd', 'late_refunded_at'))
             OR (table_name = 'e_invoices' AND column_name IN ('last_error_kind', 'last_error_message', 'last_attempt_at'))
             OR (table_name = 'credit_accounts' AND column_name IN ('closed_at', 'closure_refunded_at'))
          ORDER BY table_name, column_name`,
      );
      expect(
        cols.map(
          (c) =>
            `${c['table_name']}.${c['column_name']} ${c['udt_name']} ${c['is_nullable']} ${c['column_default'] ?? '-'}`,
        ),
      ).toEqual([
        'credit_accounts.closed_at timestamptz YES -',
        'credit_accounts.closure_refunded_at timestamptz YES -',
        'e_invoices.last_attempt_at timestamptz YES -',
        'e_invoices.last_error_kind e_invoice_error_kind YES -',
        'e_invoices.last_error_message text YES -',
        'top_ups.expires_at timestamptz NO -',
        'top_ups.gateway_reference text NO -',
        'top_ups.gateway_transaction_no text YES -',
        'top_ups.late_amount_vnd int8 YES -',
        'top_ups.late_gateway_ref text YES -',
        'top_ups.late_paid_at timestamptz YES -',
        'top_ups.late_refunded_at timestamptz YES -',
        'top_ups.points_redeemed int4 NO 0',
        'top_ups.refunded_at timestamptz YES -',
        'top_ups.refunded_by int8 YES -',
      ]);
      const comment = await one(
        `SELECT col_description('top_ups'::regclass, a.attnum) AS c FROM pg_attribute a
          WHERE a.attrelid = 'top_ups'::regclass AND a.attname = 'gateway_reference'`,
      );
      expect(String(comment['c'])).toContain('vnp_TxnRef');
    });

    it('index ledger: bỏ credit_transactions_one_per_top_up, có UNIQUE (top_up_id, transaction_type) partial; giữ one_debit_per_session', async () => {
      const idx = await q(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'credit_transactions' ORDER BY indexname`,
      );
      const names = idx.map((r) => r['indexname']);
      expect(names).not.toContain('credit_transactions_one_per_top_up');
      expect(names).toContain('credit_transactions_one_debit_per_session');
      const def = String(
        idx.find((r) => r['indexname'] === 'credit_transactions_one_per_top_up_and_type')?.[
          'indexdef'
        ],
      );
      expect(def).toContain('UNIQUE INDEX');
      expect(def).toContain('(top_up_id, transaction_type)');
      expect(def).toContain('WHERE (top_up_id IS NOT NULL)');
    });

    it('giá trị enum: restore nằm CUỐI loyalty_transaction_type; e_invoice_error_kind = transient, data', async () => {
      const vals = async (t: string) =>
        (
          await q(
            `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = $1 ORDER BY e.enumsortorder`,
            [t],
          )
        ).map((r) => r['enumlabel']);
      expect(await vals('loyalty_transaction_type')).toEqual([
        'earn',
        'redeem',
        'expire',
        'adjust',
        'restore',
      ]);
      expect(await vals('e_invoice_error_kind')).toEqual(['transient', 'data']);
    });
  });

  describe('(b) ràng buộc mới trên DB đã nâng cấp', () => {
    const insertTopUp = (ref: string, extra = '', extraVals = '') =>
      q(
        `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                              idempotency_key, expires_at${extra})
         VALUES ($1, $2, 50000, 50000, $1, now() + interval '15 minutes'${extraVals}) RETURNING id`,
        [ref, accountId],
      );

    it('một top-up có một dòng top_up và một dòng refund, nhưng không hai dòng top_up (hay hai refund)', async () => {
      await q(
        `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
                                          balance_after_vnd, top_up_id)
         VALUES ($1, 2, 'refund', -200000, 0, $2)`,
        [accountId, creditedId],
      );
      const dupTopUp = await rejection(
        q(
          `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
                                            balance_after_vnd, top_up_id)
           VALUES ($1, 3, 'top_up', 200000, 200000, $2)`,
          [accountId, creditedId],
        ),
      );
      expect(dupTopUp.code).toBe('23505');
      expect(dupTopUp.constraint).toBe('credit_transactions_one_per_top_up_and_type');
      const dupRefund = await rejection(
        q(
          `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
                                            balance_after_vnd, top_up_id)
           VALUES ($1, 3, 'refund', -1, -1, $2)`,
          [accountId, creditedId],
        ),
      );
      expect(dupRefund.constraint).toBe('credit_transactions_one_per_top_up_and_type');
    });

    it('hoàn top-up hợp lệ: status refunded + refunded_at + refunded_by (Admin)', async () => {
      const r = await one(
        `UPDATE top_ups SET status = 'refunded', refunded_at = '2026-10-22T09:00:00Z', refunded_by = $2
          WHERE id = $1 RETURNING status::text, refunded_by`,
        [creditedId, adminId],
      );
      expect([r['status'], Number(r['refunded_by'])]).toEqual(['refunded', adminId]);
    });

    it("loyalty_transactions dùng được 'restore' (BR-P37) gắn với top-up", async () => {
      const r = await one(
        `INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points, top_up_id)
         VALUES ($1, 2, 'restore', 500, $2) RETURNING transaction_type::text`,
        [loyaltyAccountId, creditedId],
      );
      expect(r['transaction_type']).toBe('restore');
    });

    it('late_gateway_ref UNIQUE: khoản muộn thứ hai cùng mã bị từ chối', async () => {
      await q(
        `UPDATE top_ups SET status = 'expired', late_gateway_ref = 'LATE-1', late_paid_at = '2026-10-21T10:00:00Z',
                late_amount_vnd = 95000 WHERE id = $1`,
        [pendingId],
      );
      const e = await rejection(
        insertTopUp(
          'M3-REF-LATE',
          ', status, late_gateway_ref, late_paid_at, late_amount_vnd',
          `, 'expired', 'LATE-1', now(), 50000`,
        ),
      );
      expect(e.code).toBe('23505');
      expect(e.constraint).toBe('top_ups_late_gateway_ref_key');
      // Hoàn khoản muộn sau lúc nhận: được.
      await q(`UPDATE top_ups SET late_refunded_at = '2026-10-21T12:00:00Z' WHERE id = $1`, [
        pendingId,
      ]);
    });

    it('NOT NULL: gateway_reference và expires_at bắt buộc khi tạo top-up', async () => {
      const noRef = await rejection(
        q(
          `INSERT INTO top_ups (credit_account_id, amount_vnd, amount_paid_vnd, idempotency_key, expires_at)
           VALUES ($1, 50000, 50000, 'm3-noref', now() + interval '15 minutes')`,
          [accountId],
        ),
      );
      expect(noRef.code).toBe('23502');
      const noExp = await rejection(
        q(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd, idempotency_key)
           VALUES ('M3-NOEXP', $1, 50000, 50000, 'm3-noexp')`,
          [accountId],
        ),
      );
      expect(noExp.code).toBe('23502');
    });

    it.each([
      [
        'expires_at không sau created_at',
        ', created_at',
        `, now() + interval '1 hour'`,
        'top_ups_expires_at_check',
      ],
      // `refunded` thiếu refunded_at luôn vi phạm hai CHECK cùng lúc: thiếu refunded_by thì
      // refunded_by_required, có refunded_by thì refunded_by_check — cả hai đều chặn.
      [
        'status refunded thiếu cả refunded_at lẫn refunded_by',
        ', status',
        `, 'refunded'`,
        'top_ups_refunded_check|top_ups_refunded_by_required_check',
      ],
      // ADMIN được thay bằng users.id của Admin lúc chạy (adminId chỉ có sau beforeAll).
      [
        'status refunded có refunded_by nhưng thiếu refunded_at',
        ', status, refunded_by',
        `, 'refunded', ADMIN`,
        'top_ups_refunded_check|top_ups_refunded_by_check',
      ],
      [
        'status refunded thiếu refunded_by (Admin hoàn, UC-ADM-08)',
        ', status, refunded_at',
        `, 'refunded', now()`,
        'top_ups_refunded_by_required_check',
      ],
      ['refunded_at khi chưa refunded', ', refunded_at', ', now()', 'top_ups_refunded_check'],
      ['refunded_by không có refunded_at', ', refunded_by', ', ADMIN', 'top_ups_refunded_by_check'],
      [
        'late_gateway_ref thiếu late_paid_at/amount',
        ', status, late_gateway_ref',
        `, 'expired', 'LATE-X'`,
        'top_ups_late_payment_check',
      ],
      [
        'late_amount_vnd âm',
        ', status, late_gateway_ref, late_paid_at, late_amount_vnd',
        `, 'expired', 'LATE-Y', now(), -1`,
        'top_ups_late_payment_check',
      ],
      [
        'late_refunded_at khi không có khoản muộn',
        ', late_refunded_at',
        ', now()',
        'top_ups_late_refunded_check',
      ],
      [
        'late_refunded_at trước late_paid_at',
        ', status, late_gateway_ref, late_paid_at, late_amount_vnd, late_refunded_at',
        `, 'expired', 'LATE-Z', now(), 1000, now() - interval '1 minute'`,
        'top_ups_late_refunded_check',
      ],
      [
        'khoản muộn trên top-up credited (tiền nhận hai lần, SD-2c D)',
        ', status, late_gateway_ref, late_paid_at, late_amount_vnd',
        `, 'credited', 'LATE-C', now(), 1000`,
        'top_ups_late_payment_status_check',
      ],
      [
        'khoản muộn trên top-up pending',
        ', late_gateway_ref, late_paid_at, late_amount_vnd',
        `, 'LATE-P', now(), 1000`,
        'top_ups_late_payment_status_check',
      ],
    ])('CHECK top_ups từ chối: %s', async (label, cols, vals, constraint) => {
      const ref = `M3-BAD-${label.replace(/\W+/g, '-')}`;
      const e = await rejection(
        q(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                                idempotency_key, expires_at${cols})
           VALUES ($1, $2, 50000, 50000, $1, now() + interval '15 minutes'${vals.replace('ADMIN', String(adminId))})`,
          [ref, accountId],
        ),
      );
      expect(e.code).toBe('23514');
      expect(constraint.split('|')).toContain(e.constraint);
    });

    it('điểm ⇔ giảm giá (BR-P35): 500 điểm + 5.000 VND được; lệch một bên hoặc điểm âm bị từ chối', async () => {
      const ins = (ref: string, points: number, discount: number) =>
        q(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_redeemed,
                                points_discount_vnd, amount_paid_vnd, idempotency_key, expires_at)
           VALUES ($1, $2, 50000, $3, $4, 50000 - $4::bigint, $1, now() + interval '15 minutes')
           RETURNING points_redeemed, amount_paid_vnd`,
          [ref, accountId, points, discount],
        );
      const ok = (await ins('M3-PTS-OK', 500, 5000))[0] ?? {};
      expect([ok['points_redeemed'], Number(ok['amount_paid_vnd'])]).toEqual([500, 45000]);
      // Tỉ lệ không ghi cứng: 300 điểm cho 5.000 VND vẫn được (chính sách do Admin cấu hình).
      await ins('M3-PTS-RATIO', 300, 5000);
      const noPoints = await rejection(ins('M3-PTS-0', 0, 5000));
      expect([noPoints.code, noPoints.constraint]).toEqual(['23514', 'top_ups_points_check']);
      const noDiscount = await rejection(ins('M3-PTS-1', 500, 0));
      expect(noDiscount.constraint).toBe('top_ups_points_check');
      const negative = await rejection(ins('M3-PTS-NEG', -1, 1000));
      expect(negative.constraint).toBe('top_ups_points_redeemed_check');
    });

    it('gateway_transaction_no UNIQUE khi có (BR-P13): nhiều NULL được, cùng vnp_TransactionNo cho top-up thứ hai bị từ chối', async () => {
      const ins = (ref: string, txnNo: string | null) =>
        q(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                                idempotency_key, expires_at, status, gateway_transaction_no)
           VALUES ($1, $2, 50000, 50000, $1, now() + interval '15 minutes', 'credited', $3)`,
          [ref, accountId, txnNo],
        );
      await ins('M3-TXN-NULL-1', null);
      await ins('M3-TXN-NULL-2', null);
      await ins('M3-TXN-1', 'VNP-14000001');
      await ins('M3-TXN-2', 'VNP-14000002');
      const dup = await rejection(ins('M3-TXN-DUP', 'VNP-14000001'));
      expect([dup.code, dup.constraint]).toEqual(['23505', 'top_ups_gateway_transaction_no_key']);
      const def = await one(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'top_ups_gateway_transaction_no_key'`,
      );
      expect(String(def['indexdef'])).toContain('WHERE (gateway_transaction_no IS NOT NULL)');
    });

    it('refunded_by phải là users.id có thật (FK)', async () => {
      const e = await rejection(
        q(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                                idempotency_key, expires_at, status, refunded_at, refunded_by)
           VALUES ('M3-FK', $1, 50000, 50000, 'm3-fk', now() + interval '15 minutes', 'refunded', now(), 999999)`,
          [accountId],
        ),
      );
      expect(e.code).toBe('23503');
    });

    it('e_invoices: last_error_kind cần last_attempt_at; giá trị ngoài enum bị từ chối; lỗi hợp lệ ghi được', async () => {
      const noAttempt = await rejection(
        q(
          `UPDATE e_invoices SET status = 'failed', last_error_kind = 'transient' WHERE top_up_id = $1`,
          [creditedId],
        ),
      );
      expect(noAttempt.constraint).toBe('e_invoices_last_error_check');
      const badKind = await rejection(
        q(
          `UPDATE e_invoices SET last_error_kind = 'other', last_attempt_at = now() WHERE top_up_id = $1`,
          [creditedId],
        ),
      );
      expect(badKind.code).toBe('22P02');
      const ok = await one(
        `UPDATE e_invoices SET status = 'failed', attempt_count = 1, last_error_kind = 'data',
                last_error_message = 'MST sai', last_attempt_at = now()
          WHERE top_up_id = $1 RETURNING last_error_kind::text`,
        [creditedId],
      );
      expect(ok['last_error_kind']).toBe('data');
    });

    it('credit_accounts: closed ⇔ closed_at; closure_refunded_at không trước closed_at', async () => {
      const closedNoAt = await rejection(
        q(`UPDATE credit_accounts SET status = 'closed' WHERE id = $1`, [accountId]),
      );
      expect(closedNoAt.constraint).toBe('credit_accounts_closed_check');
      const atNotClosed = await rejection(
        q(`UPDATE credit_accounts SET closed_at = now() WHERE id = $1`, [accountId]),
      );
      expect(atNotClosed.constraint).toBe('credit_accounts_closed_check');
      const refundBefore = await rejection(
        q(
          `UPDATE credit_accounts SET status = 'closed', closed_at = '2026-10-23T10:00:00Z',
                  closure_refunded_at = '2026-10-23T09:00:00Z' WHERE id = $1`,
          [accountId],
        ),
      );
      expect(refundBefore.constraint).toBe('credit_accounts_closure_refunded_check');
      const ok = await one(
        `UPDATE credit_accounts SET status = 'closed', closed_at = '2026-10-23T10:00:00Z',
                closure_refunded_at = '2026-10-23T11:00:00Z' WHERE id = $1 RETURNING status::text`,
        [accountId],
      );
      expect(ok['status']).toBe('closed');
    });
  });

  describe('tiền kiểm: dữ liệu cũ vi phạm ràng buộc mới → 0003 dừng, không áp gì', () => {
    // Client riêng: lỗi giữa BEGIN … COMMIT để kết nối ở trạng thái aborted cho tới ROLLBACK.
    let client: Client;
    const BASE = `INSERT INTO users (email, full_name, role) VALUES ('m3.pre@test', 'Pre', 'driver');
       INSERT INTO drivers (user_id, consent_version, consent_given_at)
         SELECT id, 'v1', now() FROM users WHERE email = 'm3.pre@test';`;
    const ACCOUNT = `INSERT INTO credit_accounts (driver_id) SELECT id FROM users WHERE email = 'm3.pre@test';`;
    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL as string });
      await client.connect();
    });
    afterAll(async () => {
      await client?.end();
    });

    it.each([
      [
        'top-up gateway_reference NULL',
        `${ACCOUNT} INSERT INTO top_ups (credit_account_id, amount_vnd, amount_paid_vnd, idempotency_key)
           SELECT id, 50000, 50000, 'm3-pre' FROM credit_accounts;`,
        /^0003: 1 top_ups có gateway_reference NULL/,
      ],
      [
        'top-up refunded (không có refunded_at / refunded_by)',
        `${ACCOUNT} INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                                         status, idempotency_key)
           SELECT 'PRE-R', id, 50000, 50000, 'refunded', 'm3-pre' FROM credit_accounts;`,
        /^0003: 1 top_ups status = refunded/,
      ],
      [
        'top-up có giảm giá điểm (points_redeemed không suy ra được)',
        `${ACCOUNT} INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_discount_vnd,
                                         amount_paid_vnd, idempotency_key)
           SELECT 'PRE-P', id, 50000, 5000, 45000, 'm3-pre' FROM credit_accounts;`,
        /^0003: 1 top_ups có points_discount_vnd <> 0/,
      ],
      [
        'ví closed (không có closed_at)',
        `INSERT INTO credit_accounts (driver_id, status) SELECT id, 'closed' FROM users WHERE email = 'm3.pre@test';`,
        /^0003: 1 credit_accounts status = closed/,
      ],
    ])('%s: migrate() ném lỗi; _migrations và schema giữ ở 0002', async (_label, data, message) => {
      await buildAt0002((sql) => client.query(sql));
      await client.query(`${BASE} ${data}`);
      const err = await rejection(migrate(client));
      expect(err.message).toMatch(message);
      await client.query('ROLLBACK');
      const names = (await client.query('SELECT name FROM _migrations ORDER BY name')).rows.map(
        (r: { name: string }) => r.name,
      );
      expect(names).toEqual(BEFORE_0003);
      const col = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'top_ups' AND column_name = 'expires_at'`,
      );
      expect(col.rows).toHaveLength(0);
      const labels = await client.query(
        `SELECT unnest(enum_range(NULL::loyalty_transaction_type))::text AS v`,
      );
      expect(labels.rows.map((r: { v: string }) => r.v)).not.toContain('restore');
    });
  });
});
