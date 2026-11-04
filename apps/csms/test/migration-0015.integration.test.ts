/**
 * Test tích hợp migration 0015 (T32, WP5): bảng `refunds` (STM-10), cột trạng thái/lịch quét cho
 * `invoice_adjustments`, `e_invoices.next_attempt_at`, các index quét DB (WF-02 decisions D1, D5,
 * D7, D8) và B5 của ERD Alignment (bỏ `top_ups.refunded_by`).
 *
 * Vì sao tồn tại: 0015 thêm bảng có nhiều CHECK (refund chỉ ghi một lần, Admin hay hệ thống tạo,
 * `done` phải có mã hoàn của VNPay), đổi `invoice_adjustments.issued_at` thành nullable, backfill
 * `e_invoices.next_attempt_at` cho hoá đơn còn chờ và bỏ một cột của 0003. Mỗi thứ có thể hỏng âm
 * thầm trên DB đã có dữ liệu billing.
 *
 * Phần 1 dựng DB ở trạng thái ngay trước 0015 (mọi file `drizzle/` có tên nhỏ hơn `0015`, gồm
 * 0010–0012 và 0014 của BE-16, 0013 của BE-07) với ví, top-up và hoá đơn ở các trạng thái `requested` / `issued` /
 * `failed`, gọi helper `migrate` (cùng logic scripts/migrate.mjs) rồi kiểm backfill. Phần 2 kiểm
 * ràng buộc trên chính DB đó (mỗi ràng buộc: ca hợp lệ và ca bị từ chối). Phần 3 kiểm tiền kiểm:
 * `invoice_adjustments` đã có hàng, hoặc đã có top-up `refunded`, thì 0015 dừng, không áp gì.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createDb, Db } from '../src/db/db.module.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0015 = '0015_billing-refunds-wf02';
const BEFORE_0015 = listMigrations().filter((n) => n < '0015');

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

/** DROP SCHEMA rồi dựng DB ở trạng thái ngay trước 0015 (có `_migrations` ghi các file đó). */
async function buildBefore0015(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const name of BEFORE_0015) {
    await query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
  }
  await query(
    `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
     INSERT INTO _migrations (name) VALUES ${BEFORE_0015.map((n) => `('${n}')`).join(', ')};`,
  );
}

describeDb('migration 0015 — refunds và lịch quét billing (nâng cấp DB đã có 0000…0014)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};

  let accountId: number;
  let adminId: number;
  let driverId: number;
  let issuedInvoiceId: number;
  let seq = 0;

  /** Top-up credited mới cho mỗi ca (tránh đụng UNIQUE giữa các test). */
  const newTopUp = async (): Promise<number> => {
    seq += 1;
    const ref = `M13-TU-${seq}`;
    return Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                                status, idempotency_key, expires_at, completed_at)
           VALUES ($1, $2, 200000, 200000, 'credited', $1, now() + interval '15 minutes', now())
           RETURNING id`,
          [ref, accountId],
        )
      )['id'],
    );
  };

  /** INSERT một dòng với cột mặc định + `cols` ghi đè (giá trị null = ghi NULL). */
  const insertRow = (table: string, cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return one(
      `INSERT INTO ${table} (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(cols),
    );
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  describe('đường nâng cấp (DB ngay trước 0015, có hoá đơn requested / issued / failed)', () => {
    const invoiceIds: Record<'requested' | 'issued' | 'failed', number> = {
      requested: 0,
      issued: 0,
      failed: 0,
    };

    beforeAll(async () => {
      await buildBefore0015((sql) => db.$client.query(sql));
      driverId = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m13.driver@test', 'Tai Xe', 'driver')
             RETURNING id`,
          )
        )['id'],
      );
      adminId = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m13.admin@test', 'Admin', 'admin')
             RETURNING id`,
          )
        )['id'],
      );
      // ISA từ 0011: mọi user admin có một dòng admins (0011 chỉ backfill user có lúc chạy 0011).
      await q(`INSERT INTO admins (user_id) VALUES ($1)`, [adminId]);
      await q(
        `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
        [driverId],
      );
      accountId = Number(
        (
          await one(
            `INSERT INTO credit_accounts (driver_id, status, balance_vnd) VALUES ($1, 'active', 600000)
             RETURNING id`,
            [driverId],
          )
        )['id'],
      );
      invoiceIds.requested = Number(
        (
          await one(
            `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_amount_vnd)
             VALUES ($1, 'requested', 200000, 18182) RETURNING id`,
            [await newTopUp()],
          )
        )['id'],
      );
      invoiceIds.issued = Number(
        (
          await one(
            `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_amount_vnd, invoice_no,
                                     issued_at, attempt_count)
             VALUES ($1, 'issued', 200000, 18182, 'M13-INV-1', now(), 1) RETURNING id`,
            [await newTopUp()],
          )
        )['id'],
      );
      invoiceIds.failed = Number(
        (
          await one(
            `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_amount_vnd, attempt_count,
                                     last_error_kind, last_error_message, last_attempt_at)
             VALUES ($1, 'failed', 200000, 18182, 1, 'transient', 'timeout', now()) RETURNING id`,
            [await newTopUp()],
          )
        )['id'],
      );
      issuedInvoiceId = invoiceIds.issued;
    });

    it('migrate() áp 0015 rồi các migration sau; _migrations khớp thư mục drizzle/; chạy lại không áp gì', async () => {
      const applied = await migrate(db.$client);
      expect(applied[0]).toBe(M0015);
      expect(applied).toEqual(listMigrations().slice(BEFORE_0015.length));
      expect(await migrate(db.$client)).toEqual([]);
      const names = (await q('SELECT name FROM _migrations ORDER BY name')).map((r) => r['name']);
      expect(names).toEqual(listMigrations());
    });

    it('e_invoices.next_attempt_at: hoá đơn requested / failed được backfill, hoá đơn issued để NULL; dữ liệu cũ còn nguyên', async () => {
      const rows = await q(
        `SELECT id, status::text, attempt_count, last_error_kind::text, next_attempt_at,
                next_attempt_at <= now() AS due
           FROM e_invoices ORDER BY id`,
      );
      const byId = new Map(rows.map((r) => [Number(r['id']), r]));
      expect(byId.get(invoiceIds.requested)?.['due']).toBe(true);
      expect(byId.get(invoiceIds.failed)?.['due']).toBe(true);
      expect(byId.get(invoiceIds.failed)?.['last_error_kind']).toBe('transient');
      expect(byId.get(invoiceIds.failed)?.['attempt_count']).toBe(1);
      expect(byId.get(invoiceIds.issued)?.['next_attempt_at']).toBeNull();
      expect(byId.get(invoiceIds.issued)?.['status']).toBe('issued');
    });

    it('enum mới: refund_kind, refund_status đúng thứ tự', async () => {
      const vals = async (t: string) =>
        (
          await q(
            `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              WHERE t.typname = $1 ORDER BY e.enumsortorder`,
            [t],
          )
        ).map((r) => r['enumlabel']);
      expect(await vals('refund_kind')).toEqual(['top_up', 'late_payment', 'account_closure']);
      expect(await vals('refund_status')).toEqual(['requested', 'done', 'failed']);
    });

    it('cột: kiểu, nullable, default; invoice_adjustments.issued_at thành nullable và bỏ DEFAULT', async () => {
      const rows = await q(
        `SELECT table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable || ' ' ||
                coalesce(column_default, '-') AS c
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'refunds')
              OR (table_name = 'invoice_adjustments' AND column_name IN ('refund_id', 'status',
                  'attempt_count', 'last_error_kind', 'last_error_message', 'last_attempt_at',
                  'next_attempt_at', 'provider_adjustment_no', 'issued_at', 'created_at',
                  'updated_at'))
              OR (table_name = 'e_invoices' AND column_name = 'next_attempt_at'))
          ORDER BY 1`,
      );
      expect(rows.map((r) => r['c'])).toEqual([
        'e_invoices.next_attempt_at timestamptz YES now()',
        'invoice_adjustments.attempt_count int4 NO 0',
        'invoice_adjustments.created_at timestamptz NO now()',
        'invoice_adjustments.issued_at timestamptz YES -',
        'invoice_adjustments.last_attempt_at timestamptz YES -',
        'invoice_adjustments.last_error_kind e_invoice_error_kind YES -',
        'invoice_adjustments.last_error_message text YES -',
        'invoice_adjustments.next_attempt_at timestamptz YES now()',
        'invoice_adjustments.provider_adjustment_no varchar YES -',
        'invoice_adjustments.refund_id int8 YES -',
        "invoice_adjustments.status e_invoice_status NO 'requested'::e_invoice_status",
        'invoice_adjustments.updated_at timestamptz NO now()',
        'refunds.amount_vnd int8 NO -',
        'refunds.attempt_count int4 NO 0',
        'refunds.completed_at timestamptz YES -',
        'refunds.created_at timestamptz NO now()',
        'refunds.gateway_refund_no varchar YES -',
        'refunds.id int8 NO -',
        'refunds.kind refund_kind NO -',
        'refunds.last_attempt_at timestamptz YES -',
        'refunds.last_error_kind e_invoice_error_kind YES -',
        'refunds.last_error_message text YES -',
        'refunds.next_attempt_at timestamptz YES now()',
        'refunds.requested_by int8 YES -',
        "refunds.status refund_status NO 'requested'::refund_status",
        'refunds.top_up_id int8 NO -',
        'refunds.updated_at timestamptz NO now()',
      ]);
      // C1 (quy ước 0014): mã của cổng / nhà cung cấp là varchar(20) như gateway_transaction_no,
      // invoice_no; văn bản tự do giữ text.
      const lengths = await q(
        `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' ||
                coalesce(character_maximum_length::text, '-') AS c
           FROM information_schema.columns
          WHERE (table_name = 'refunds' AND column_name IN ('gateway_refund_no', 'last_error_message'))
             OR (table_name = 'invoice_adjustments'
                 AND column_name IN ('provider_adjustment_no', 'reason', 'last_error_message'))
          ORDER BY 1`,
      );
      expect(lengths.map((r) => r['c'])).toEqual([
        'invoice_adjustments.last_error_message text -',
        'invoice_adjustments.provider_adjustment_no character varying 20',
        'invoice_adjustments.reason text -',
        'refunds.gateway_refund_no character varying 20',
        'refunds.last_error_message text -',
      ]);
    });

    it('index quét DB (D7), index cho mọi FK của refunds (A5 của 0011)', async () => {
      const defs = new Map(
        (
          await q(
            `SELECT indexname, indexdef FROM pg_indexes
              WHERE tablename IN ('refunds', 'e_invoices', 'invoice_adjustments', 'top_ups')`,
          )
        ).map((r) => [String(r['indexname']), String(r['indexdef'])]),
      );
      expect(defs.get('refunds_status_next_attempt_at_idx')).toContain('(status, next_attempt_at)');
      expect(defs.get('refunds_top_up_id_idx')).toContain('(top_up_id)');
      expect(defs.get('refunds_requested_by_idx')).toContain('(requested_by)');
      expect(defs.get('e_invoices_status_next_attempt_at_idx')).toContain(
        '(status, next_attempt_at)',
      );
      expect(defs.get('invoice_adjustments_status_next_attempt_at_idx')).toContain(
        '(status, next_attempt_at)',
      );
      expect(defs.get('top_ups_status_expires_at_idx')).toContain('(status, expires_at)');
      const once = defs.get('refunds_one_per_top_up_and_kind') ?? '';
      expect(once).toContain('UNIQUE INDEX');
      expect(once).toContain('(top_up_id, kind)');
      expect(once).toMatch(
        /WHERE \(kind = ANY \(ARRAY\['top_up'::refund_kind, 'late_payment'::refund_kind\]\)\)/,
      );
    });

    it('FK mới: requested_by → admins(user_id); giữ NO ACTION (không nằm trong danh sách C3 của 0012)', async () => {
      const rows = await q(
        `SELECT conname, confrelid::regclass::text AS target, confdeltype AS d FROM pg_constraint
          WHERE contype = 'f' AND conrelid IN ('refunds'::regclass, 'invoice_adjustments'::regclass)
            AND conname IN ('refunds_top_up_id_fkey', 'refunds_requested_by_fkey',
                            'invoice_adjustments_refund_id_fkey')
          ORDER BY conname`,
      );
      expect(rows).toEqual([
        { conname: 'invoice_adjustments_refund_id_fkey', target: 'refunds', d: 'a' },
        { conname: 'refunds_requested_by_fkey', target: 'admins', d: 'a' },
        { conname: 'refunds_top_up_id_fkey', target: 'top_ups', d: 'a' },
      ]);
    });

    it('B5: top_ups.refunded_by và hai CHECK của nó đã bỏ; refunded ⇔ refunded_at giữ nguyên', async () => {
      const col = await q(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'top_ups' AND column_name = 'refunded_by'`,
      );
      expect(col).toHaveLength(0);
      const checks = (
        await q(
          `SELECT conname FROM pg_constraint
            WHERE conrelid = 'top_ups'::regclass AND conname LIKE 'top_ups_refunded%'
            ORDER BY conname`,
        )
      ).map((r) => r['conname']);
      expect(checks).toEqual(['top_ups_refunded_check']);
      const c = await one(
        `SELECT col_description('top_ups'::regclass, a.attnum) AS c FROM pg_attribute a
          WHERE a.attrelid = 'top_ups'::regclass AND a.attname = 'refunded_at'`,
      );
      expect(String(c['c'])).toContain('refunds.requested_by');
    });

    it('COMMENT closure_refunded_at nói theo refund account_closure (D1), không còn "Admin hoàn"', async () => {
      const c = await one(
        `SELECT col_description('credit_accounts'::regclass, a.attnum) AS c FROM pg_attribute a
          WHERE a.attrelid = 'credit_accounts'::regclass AND a.attname = 'closure_refunded_at'`,
      );
      expect(String(c['c'])).toContain('account_closure');
    });
  });

  describe('ràng buộc refunds (STM-10, D1)', () => {
    const refund = (cols: Record<string, unknown>) =>
      insertRow('refunds', { kind: 'top_up', amount_vnd: 50000, requested_by: adminId, ...cols });

    it('refund top_up do Admin tạo: mặc định requested, attempt 0, next_attempt_at đến hạn ngay', async () => {
      const r = await refund({ top_up_id: await newTopUp() });
      expect(r['status']).toBe('requested');
      expect(r['attempt_count']).toBe(0);
      expect(r['next_attempt_at']).not.toBeNull();
      expect(r['completed_at']).toBeNull();
    });

    it('amount_vnd > 0, attempt_count >= 0', async () => {
      const topUpId = await newTopUp();
      expect((await rejection(refund({ top_up_id: topUpId, amount_vnd: 0 }))).constraint).toBe(
        'refunds_amount_check',
      );
      expect((await rejection(refund({ top_up_id: topUpId, attempt_count: -1 }))).constraint).toBe(
        'refunds_attempt_count_check',
      );
    });

    it('mỗi top-up tối đa một refund top_up và một late_payment; account_closure được nhiều dòng', async () => {
      const topUpId = await newTopUp();
      await refund({ top_up_id: topUpId });
      const dup = await rejection(refund({ top_up_id: topUpId }));
      expect(dup.code).toBe('23505');
      expect(dup.constraint).toBe('refunds_one_per_top_up_and_kind');
      await refund({ top_up_id: topUpId, kind: 'late_payment' });
      expect(
        (await rejection(refund({ top_up_id: topUpId, kind: 'late_payment' }))).constraint,
      ).toBe('refunds_one_per_top_up_and_kind');
      const closure = { top_up_id: topUpId, kind: 'account_closure', requested_by: null };
      await refund(closure);
      await refund(closure);
      const n = await one(`SELECT count(*)::int AS n FROM refunds WHERE top_up_id = $1`, [topUpId]);
      expect(n['n']).toBe(4);
    });

    it('requested_by bắt buộc trừ account_closure (hệ thống tạo, SD-2f)', async () => {
      const topUpId = await newTopUp();
      for (const kind of ['top_up', 'late_payment']) {
        const e = await rejection(refund({ top_up_id: topUpId, kind, requested_by: null }));
        expect(e.constraint).toBe('refunds_requested_by_check');
      }
      const ok = await refund({ top_up_id: topUpId, kind: 'account_closure', requested_by: null });
      expect(ok['requested_by']).toBeNull();
    });

    it('done ⇔ completed_at; done phải có gateway_refund_no; gateway_refund_no UNIQUE', async () => {
      const noCompleted = await rejection(
        refund({ top_up_id: await newTopUp(), status: 'done', gateway_refund_no: 'M13-RF-0' }),
      );
      expect(noCompleted.constraint).toBe('refunds_completed_check');
      const completedWhileRequested = await rejection(
        refund({ top_up_id: await newTopUp(), completed_at: new Date() }),
      );
      expect(completedWhileRequested.constraint).toBe('refunds_completed_check');
      const noRefundNo = await rejection(
        refund({ top_up_id: await newTopUp(), status: 'done', completed_at: new Date() }),
      );
      expect(noRefundNo.constraint).toBe('refunds_gateway_refund_no_check');
      const done = {
        status: 'done',
        completed_at: new Date(),
        gateway_refund_no: 'M13-RF-1',
      };
      const ok = await refund({ top_up_id: await newTopUp(), ...done });
      expect(ok['status']).toBe('done');
      const dup = await rejection(refund({ top_up_id: await newTopUp(), ...done }));
      expect(dup.constraint).toBe('refunds_gateway_refund_no_key');
      const tooLong = await rejection(
        refund({ top_up_id: await newTopUp(), ...done, gateway_refund_no: 'X'.repeat(21) }),
      );
      expect(tooLong.code).toBe('22001');
    });

    it('last_error_kind cần last_attempt_at; giá trị ngoài enum bị từ chối', async () => {
      const e = await rejection(
        refund({ top_up_id: await newTopUp(), last_error_kind: 'transient' }),
      );
      expect(e.constraint).toBe('refunds_last_error_check');
      const bad = await rejection(
        refund({
          top_up_id: await newTopUp(),
          last_error_kind: 'other',
          last_attempt_at: new Date(),
        }),
      );
      expect(bad.code).toBe('22P02');
      const ok = await refund({
        top_up_id: await newTopUp(),
        attempt_count: 1,
        last_error_kind: 'transient',
        last_error_message: 'VNPay timeout',
        last_attempt_at: new Date(),
      });
      expect(ok['last_error_kind']).toBe('transient');
    });

    it('requested phải có next_attempt_at (worker D7 mới thấy); failed được để NULL', async () => {
      const e = await rejection(refund({ top_up_id: await newTopUp(), next_attempt_at: null }));
      expect(e.constraint).toBe('refunds_next_attempt_check');
      const failed = await refund({
        top_up_id: await newTopUp(),
        status: 'failed',
        next_attempt_at: null,
      });
      expect(failed['status']).toBe('failed');
    });

    it('enum kind / status: giá trị ngoài danh sách bị từ chối', async () => {
      const topUpId = await newTopUp();
      expect((await rejection(refund({ top_up_id: topUpId, kind: 'other' }))).code).toBe('22P02');
      expect((await rejection(refund({ top_up_id: topUpId, status: 'cancelled' }))).code).toBe(
        '22P02',
      );
    });

    it('FK: top_up_id phải tồn tại; requested_by phải là Admin (có trong admins), tài xế bị từ chối', async () => {
      const noTopUp = await rejection(refund({ top_up_id: 999999999 }));
      expect([noTopUp.code, noTopUp.constraint]).toEqual(['23503', 'refunds_top_up_id_fkey']);
      const noUser = await rejection(
        refund({ top_up_id: await newTopUp(), requested_by: 999999999 }),
      );
      expect([noUser.code, noUser.constraint]).toEqual(['23503', 'refunds_requested_by_fkey']);
      const driver = await rejection(
        refund({ top_up_id: await newTopUp(), requested_by: driverId }),
      );
      expect([driver.code, driver.constraint]).toEqual(['23503', 'refunds_requested_by_fkey']);
    });
  });

  describe('top_ups sau B5', () => {
    it('hoàn top-up: refunded + refunded_at là đủ (Admin nằm ở refunds); thiếu refunded_at bị từ chối', async () => {
      const topUpId = await newTopUp();
      const missing = await rejection(
        q(`UPDATE top_ups SET status = 'refunded' WHERE id = $1`, [topUpId]),
      );
      expect(missing.constraint).toBe('top_ups_refunded_check');
      const r = await one(
        `UPDATE top_ups SET status = 'refunded', refunded_at = now() WHERE id = $1
         RETURNING status::text`,
        [topUpId],
      );
      expect(r['status']).toBe('refunded');
    });
  });

  describe('ràng buộc invoice_adjustments (STM-7, D5)', () => {
    let adjNo = 0;
    const adjustment = (cols: Record<string, unknown>) => {
      adjNo += 1;
      return insertRow('invoice_adjustments', {
        e_invoice_id: issuedInvoiceId,
        adjustment_no: adjNo,
        reason: 'Hoàn top-up',
        amount_vnd: -50000,
        ...cols,
      });
    };
    const newRefund = async (): Promise<number> =>
      Number(
        (
          await insertRow('refunds', {
            top_up_id: await newTopUp(),
            kind: 'top_up',
            amount_vnd: 50000,
            requested_by: adminId,
          })
        )['id'],
      );

    it('mặc định requested, issued_at NULL, next_attempt_at đến hạn ngay', async () => {
      const a = await adjustment({ refund_id: await newRefund() });
      expect(a['status']).toBe('requested');
      expect(a['issued_at']).toBeNull();
      expect(a['attempt_count']).toBe(0);
      expect(a['next_attempt_at']).not.toBeNull();
    });

    it('issued phải có issued_at và provider_adjustment_no; provider_adjustment_no UNIQUE', async () => {
      const noNo = await rejection(adjustment({ status: 'issued', issued_at: new Date() }));
      expect(noNo.constraint).toBe('invoice_adjustments_issued_check');
      const noAt = await rejection(
        adjustment({ status: 'issued', provider_adjustment_no: 'M13-ADJ-0' }),
      );
      expect(noAt.constraint).toBe('invoice_adjustments_issued_check');
      const issued = {
        status: 'issued',
        issued_at: new Date(),
        provider_adjustment_no: 'M13-ADJ-1',
      };
      expect((await adjustment(issued))['status']).toBe('issued');
      expect((await rejection(adjustment(issued))).constraint).toBe(
        'invoice_adjustments_provider_adjustment_no_key',
      );
    });

    it('refund_id: một refund tối đa một điều chỉnh; phải là refund có thật', async () => {
      const refundId = await newRefund();
      await adjustment({ refund_id: refundId });
      const dup = await rejection(adjustment({ refund_id: refundId }));
      expect([dup.code, dup.constraint]).toEqual(['23505', 'invoice_adjustments_refund_id_key']);
      const fk = await rejection(adjustment({ refund_id: 999999999 }));
      expect([fk.code, fk.constraint]).toEqual(['23503', 'invoice_adjustments_refund_id_fkey']);
    });

    it('last_error_kind cần last_attempt_at; attempt_count >= 0', async () => {
      const e = await rejection(adjustment({ status: 'failed', last_error_kind: 'data' }));
      expect(e.constraint).toBe('invoice_adjustments_last_error_check');
      const neg = await rejection(adjustment({ attempt_count: -1 }));
      expect(neg.constraint).toBe('invoice_adjustments_attempt_count_check');
      const ok = await adjustment({
        status: 'needs_review',
        attempt_count: 4,
        last_error_kind: 'data',
        last_error_message: 'MST sai',
        last_attempt_at: new Date(),
        next_attempt_at: null,
      });
      expect(ok['status']).toBe('needs_review');
    });

    it('requested / failed phải có next_attempt_at', async () => {
      for (const status of ['requested', 'failed']) {
        const e = await rejection(adjustment({ status, next_attempt_at: null }));
        expect(e.constraint).toBe('invoice_adjustments_next_attempt_check');
      }
    });
  });

  describe('ràng buộc e_invoices.next_attempt_at (D7)', () => {
    const invoice = async (cols: Record<string, unknown>) =>
      insertRow('e_invoices', {
        top_up_id: await newTopUp(),
        amount_vnd: 200000,
        vat_amount_vnd: 18182,
        ...cols,
      });

    it('hoá đơn mới mặc định đến hạn ngay; requested / failed không được để NULL; issued được', async () => {
      expect((await invoice({}))['next_attempt_at']).not.toBeNull();
      for (const status of ['requested', 'failed']) {
        const e = await rejection(invoice({ status, next_attempt_at: null }));
        expect(e.constraint).toBe('e_invoices_next_attempt_check');
      }
      const issued = await invoice({
        status: 'issued',
        invoice_no: 'M13-INV-2',
        issued_at: new Date(),
        next_attempt_at: null,
      });
      expect(issued['next_attempt_at']).toBeNull();
    });
  });

  describe('DB sạch', () => {
    it('resetAndMigrate áp đủ chuỗi migration, có 0015 và bảng refunds', async () => {
      const applied = await resetAndMigrate(db.$client);
      expect(applied).toEqual(listMigrations());
      expect(applied).toContain(M0015);
      expect((await one(`SELECT to_regclass('public.refunds')::text AS t`))['t']).toBe('refunds');
    });
  });

  describe('tiền kiểm: dữ liệu cũ không suy ra được giá trị mới → 0015 dừng, không áp gì', () => {
    // Client riêng: lỗi giữa BEGIN … COMMIT để kết nối ở trạng thái aborted cho tới ROLLBACK.
    let client: Client;
    const BASE = `INSERT INTO users (email, full_name, role) VALUES ('m13.pre@test', 'Pre', 'driver');
       INSERT INTO users (email, full_name, role) VALUES ('m13.pre.admin@test', 'Admin', 'admin');
       INSERT INTO admins (user_id) SELECT id FROM users WHERE email = 'm13.pre.admin@test';
       INSERT INTO drivers (user_id, consent_version, consent_given_at)
         SELECT id, 'v1', now() FROM users WHERE email = 'm13.pre@test';
       INSERT INTO credit_accounts (driver_id) SELECT id FROM users WHERE email = 'm13.pre@test';`;
    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL as string });
      await client.connect();
    });
    afterAll(async () => {
      await client?.end();
    });

    it.each([
      [
        'invoice_adjustments đã có hàng',
        `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                              status, idempotency_key, expires_at)
           SELECT 'M13-PRE', id, 50000, 50000, 'credited', 'm13-pre', now() + interval '15 minutes'
             FROM credit_accounts;
         INSERT INTO e_invoices (top_up_id, amount_vnd, vat_amount_vnd)
           SELECT id, 50000, 4545 FROM top_ups;
         INSERT INTO invoice_adjustments (e_invoice_id, adjustment_no, reason, amount_vnd)
           SELECT id, 1, 'cũ', -1000 FROM e_invoices;`,
        /^0015: 1 invoice_adjustments/,
      ],
      [
        'top-up đã refunded (B5 sẽ làm mất refunded_by)',
        `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
                              status, idempotency_key, expires_at, refunded_at, refunded_by)
           SELECT 'M13-PRE-R', a.id, 50000, 50000, 'refunded', 'm13-pre-r',
                  now() + interval '15 minutes', now(), u.id
             FROM credit_accounts a, users u WHERE u.email = 'm13.pre.admin@test';`,
        /^0015: 1 top_ups đã refunded/,
      ],
    ])(
      '%s: migrate() ném lỗi; _migrations và schema giữ ở trạng thái trước 0015',
      async (_label, data, message) => {
        await buildBefore0015((sql) => client.query(sql));
        await client.query(`${BASE} ${data}`);
        const err = await rejection(migrate(client));
        expect(err.message).toMatch(message);
        await client.query('ROLLBACK');
        const names = (await client.query('SELECT name FROM _migrations ORDER BY name')).rows.map(
          (r: { name: string }) => r.name,
        );
        expect(names).toEqual(BEFORE_0015);
        const t = await client.query(`SELECT to_regclass('public.refunds') AS t`);
        expect(t.rows[0].t).toBeNull();
        const cols = await client.query(
          `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
            WHERE (table_name = 'e_invoices' AND column_name = 'next_attempt_at')
               OR (table_name = 'top_ups' AND column_name = 'refunded_by')`,
        );
        expect(cols.rows.map((r: { c: string }) => r.c)).toEqual(['top_ups.refunded_by']);
      },
    );
  });
});
