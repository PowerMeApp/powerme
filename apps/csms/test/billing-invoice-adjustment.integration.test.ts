/**
 * Test tích hợp hoá đơn điều chỉnh khi hoàn tiền (T32 Phần 9b; SD-2e, STM-7, decisions D1 / D5 / D7)
 * trên Postgres thật: VNPay giả tiêm qua `fetch`, nhà cung cấp hoá đơn giả.
 *
 * Vì sao tồn tại: hỏng ở đây là sổ thuế lệch tiền thật. Hỏng âm thầm có thể là: refund đã done mà
 * không có điều chỉnh (sập sau commit, thiếu service), điều chỉnh hai lần cho một refund, hai refund
 * cùng hoá đơn lấy trùng số, gửi điều chỉnh trước khi hoá đơn gốc có số, tổng điều chỉnh vượt hoá đơn
 * gốc, thuế điều chỉnh tính lại theo ngày hoàn thay vì thuế suất gốc.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { createHmac } from 'node:crypto';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { InvoiceAdjustmentNotFound } from '../src/billing/billing-errors.js';
import { BillingModule } from '../src/billing/billing.module.js';
import type {
  EInvoiceAdjustmentInput,
  EInvoiceAdjustmentResult,
  EInvoiceProviderAdapter,
} from '../src/billing/e-invoice-provider.js';
import { INVOICE_ADJUSTMENT_ISSUE_WORK } from '../src/billing/e-invoice-rows.js';
import { EInvoiceService } from '../src/billing/e-invoice.service.js';
import { InvalidTransition } from '../src/billing/invalid-transition.js';
import { InvoiceAdjustmentService } from '../src/billing/invoice-adjustment.service.js';
import { RefundService } from '../src/billing/refund.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
import type { VnpayApiConfig, VnpayConfig } from '../src/billing/vnpay.config.js';
import { ConfigModule } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const SECRET = 'TESTSECRETNOTREAL';
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: SECRET,
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const API: VnpayApiConfig = { apiUrl: 'https://vnpay.test/api', serverIp: '127.0.0.1' };
const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};

const RESPONSE_ORDER = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
];
const QUERY_ORDER = [...RESPONSE_ORDER, 'vnp_PromotionCode', 'vnp_PromotionAmount'];

type Req = Record<string, string>;
type VnpayStep = (req: Req) => Response | Promise<Response>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function sign(order: string[], r: Record<string, string>): Record<string, string> {
  const data = order.map((k) => r[k] ?? '').join('|');
  return {
    ...r,
    vnp_SecureHash: createHmac('sha512', SECRET).update(data, 'utf8').digest('hex'),
  };
}

let refundNoSeq = 0;
/** Response lệnh refund, mặc định RC 00 + TS 00. */
const refundOk =
  (over: Record<string, string> = {}): VnpayStep =>
  (req) => {
    refundNoSeq += 1;
    return json(
      sign(RESPONSE_ORDER, {
        vnp_ResponseId: 'R',
        vnp_Command: 'refund',
        vnp_ResponseCode: '00',
        vnp_Message: 'ok',
        vnp_TmnCode: req['vnp_TmnCode']!,
        vnp_TxnRef: req['vnp_TxnRef']!,
        vnp_Amount: req['vnp_Amount']!,
        vnp_BankCode: 'NCB',
        vnp_PayDate: '20261125100000',
        vnp_TransactionNo: String(90_000_000 + refundNoSeq),
        vnp_TransactionType: req['vnp_TransactionType']!,
        vnp_TransactionStatus: '00',
        vnp_OrderInfo: req['vnp_OrderInfo']!,
        ...over,
      }),
    );
  };
const HTTP_500: VnpayStep = () => json({}, 500);
const queryReply =
  (type: string, ts: string, transactionNo: string, amountVnd: number): VnpayStep =>
  (req) =>
    json(
      sign(QUERY_ORDER, {
        vnp_ResponseId: 'Q',
        vnp_Command: 'querydr',
        vnp_ResponseCode: '00',
        vnp_Message: 'ok',
        vnp_TmnCode: req['vnp_TmnCode']!,
        vnp_TxnRef: req['vnp_TxnRef']!,
        vnp_Amount: String(amountVnd * 100),
        vnp_BankCode: 'NCB',
        vnp_PayDate: '20261125100000',
        vnp_TransactionNo: transactionNo,
        vnp_TransactionType: type,
        vnp_TransactionStatus: ts,
        vnp_OrderInfo: 'x',
      }),
    );

type AdjStep = (
  input: EInvoiceAdjustmentInput,
  signal: AbortSignal,
) => Promise<EInvoiceAdjustmentResult>;
const ADJ_ISSUED: AdjStep = async (i) => ({
  kind: 'issued',
  adjustmentNo: `ADJ-${i.idempotencyKey}`,
});
const TRANSIENT: AdjStep = async () => ({ kind: 'transient', message: 'provider 503' });
const DATA: AdjStep = async () => ({ kind: 'data', message: 'không cho điều chỉnh' });
const HANG: AdjStep = () => new Promise(() => undefined);

/** Chỉ giả Date (pg và timer thật vẫn chạy). */
const FAKE_DATE_ONLY = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

describeDb('billing: hoá đơn điều chỉnh khi hoàn tiền (T32 Phần 9b, D5, STM-7)', () => {
  let db: Db;
  let seq = 0;
  let refundSteps: VnpayStep[] = [];
  let querySteps: VnpayStep[] = [];

  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Req;
    if (req['vnp_Command'] === 'refund') return (refundSteps.shift() ?? refundOk())(req);
    return (querySteps.shift() ?? HTTP_500)(req);
  }) as unknown as typeof fetch;

  let adjSteps: AdjStep[] = [];
  let adjCalls: EInvoiceAdjustmentInput[] = [];
  const provider: EInvoiceProviderAdapter = {
    createInvoice: jest.fn(),
    adjustInvoice: (input, signal) => {
      adjCalls.push(input);
      return (adjSteps.shift() ?? ADJ_ISSUED)(input, signal);
    },
  };

  const kick = jest.fn();
  const runner = { register: jest.fn(), kick } as unknown as BackgroundWorkRunner;
  let vnpay: VnpayAdapter;
  let eInvoices: EInvoiceService;
  let adjustments: InvoiceAdjustmentService;
  let refunds: RefundService;
  let admin: number;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const runRefunds = (s: RefundService = refunds) => s.runDue(20, new AbortController().signal);
  const runAdj = (s: InvoiceAdjustmentService = adjustments) =>
    s.runDue(20, new AbortController().signal);

  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  async function newDriver(): Promise<{ driver: number; account: number }> {
    seq += 1;
    const driver = Number(
      (
        await one(
          `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
          [`p9b-${seq}@t32.test`],
        )
      )['id'],
    );
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [driver],
    );
    const account = Number(
      (await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [driver]))[
        'id'
      ],
    );
    return { driver, account };
  }

  type Made = { id: number; txn: string; invoiceId: number | null };

  /**
   * Top-up đã trả (SQL, `refunded` như sau quyết định hoàn) + hoá đơn gốc ghi thẳng.
   * `invoice: null` = không có hoá đơn gốc (dữ liệu cũ / ghi ngoài API).
   */
  async function topUp(
    opts: {
      amount?: number;
      late?: number;
      invoice?: {
        status?: 'requested' | 'issued' | 'failed' | 'needs_review';
        amount?: number;
        vatRate?: number;
      } | null;
    } = {},
  ): Promise<Made> {
    const { amount = 100_000, late } = opts;
    const owner = await newDriver();
    seq += 1;
    const txn = String(71_000_000 + seq);
    const id = Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
             status, gateway_transaction_no, idempotency_key, expires_at, created_at, completed_at,
             refunded_at, late_gateway_ref, late_paid_at, late_amount_vnd)
           VALUES ($1, $2, $3, $3, 'refunded', $4, $5, now() + interval '15 minutes',
             now() - interval '1 hour', now() - interval '50 minutes', now(),
             $6, CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() - interval '40 minutes' END, $7)
           RETURNING id`,
          [
            `P9BREF${seq}`,
            owner.account,
            amount,
            txn,
            `p9b-key-${seq}`,
            late === undefined ? null : String(76_000_000 + seq),
            late ?? null,
          ],
        )
      )['id'],
    );
    if (opts.invoice === null) return { id, txn, invoiceId: null };
    const inv = opts.invoice ?? {};
    const status = inv.status ?? 'issued';
    const invAmount = inv.amount ?? amount;
    const vatRate = inv.vatRate ?? 8;
    const invoiceId = Number(
      (
        await one(
          `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_rate, vat_amount_vnd,
             next_attempt_at, last_error_kind, last_attempt_at)
           VALUES ($1, $2::e_invoice_status, $3::bigint, $4::smallint,
             round($3::bigint::numeric * $4::smallint / (100 + $4::smallint)),
             CASE WHEN $2 IN ('requested', 'failed') THEN now() + interval '1 day' END,
             CASE WHEN $2 IN ('failed', 'needs_review') THEN 'transient'::e_invoice_error_kind END,
             CASE WHEN $2 IN ('failed', 'needs_review') THEN now() END)
           RETURNING id`,
          // `issued` cần số hoá đơn = id: tạo `requested` rồi phát hành ngay bên dưới.
          [id, status === 'issued' ? 'requested' : status, invAmount, vatRate],
        )
      )['id'],
    );
    if (status === 'issued')
      await q(
        `UPDATE e_invoices SET status = 'issued', invoice_no = 'INV-' || id, issued_at = now(),
           next_attempt_at = NULL WHERE id=$1`,
        [invoiceId],
      );
    return { id, txn, invoiceId };
  }

  /** Refund `requested` ghi thẳng (đường tạo thật đã có test ở Phần 9a). */
  async function mkRefund(
    topUpId: number,
    kind: 'top_up' | 'late_payment' | 'account_closure' = 'top_up',
    amount = 100_000,
  ): Promise<number> {
    return Number(
      (
        await one(
          `INSERT INTO refunds (top_up_id, kind, amount_vnd, requested_by)
           VALUES ($1, $2::refund_kind, $3, $4) RETURNING id`,
          [topUpId, kind, amount, kind === 'account_closure' ? null : admin],
        )
      )['id'],
    );
  }

  /** Đặt refund `done` bằng SQL trong transaction `c` (như tx2 vừa ghi). */
  async function markDone(c: { query: Db['$client']['query'] }, refundId: number) {
    refundNoSeq += 1;
    await c.query(
      `UPDATE refunds SET status = 'done', completed_at = now(), gateway_refund_no = $2,
         next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
      [refundId, String(95_000_000 + refundNoSeq)],
    );
  }

  /** Refund đã done + điều chỉnh tạo bằng `adjustForRefund` thật trong một transaction. */
  async function doneWithAdjustment(
    topUpId: number,
    kind: 'top_up' | 'account_closure' = 'top_up',
    amount = 100_000,
  ): Promise<{ refundId: number; adjustmentId: number }> {
    const refundId = await mkRefund(topUpId, kind, amount);
    const c = await db.$client.connect();
    try {
      await c.query('BEGIN');
      await markDone(c, refundId);
      const r = await eInvoices.adjustForRefund(c, refundId);
      await c.query('COMMIT');
      if (!('id' in r)) throw new Error(`không tạo được điều chỉnh: ${JSON.stringify(r)}`);
      return { refundId, adjustmentId: r.id };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const adjOf = (refundId: number) =>
    q(
      `SELECT id::int, e_invoice_id::int, adjustment_no, reason, amount_vnd::int, refund_id::int,
              status::text
       FROM invoice_adjustments WHERE refund_id=$1`,
      [refundId],
    );
  const adjRow = (id: number) =>
    one(
      `SELECT status::text, provider_adjustment_no, attempt_count, unfinished_claims,
              last_error_kind::text, last_error_message,
              issued_at IS NOT NULL AS issued, next_attempt_at IS NULL AS no_next,
              next_attempt_at <= now() AS due,
              round(extract(epoch FROM next_attempt_at - last_attempt_at))::int AS delay_s
       FROM invoice_adjustments WHERE id=$1`,
      [id],
    );
  const refundStatus = async (id: number) =>
    (await one('SELECT status::text FROM refunds WHERE id=$1', [id]))['status'];
  const makeDue = (id: number) =>
    q("UPDATE invoice_adjustments SET next_attempt_at = now() - interval '1 second' WHERE id=$1", [
      id,
    ]);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    vnpay = new VnpayAdapter(VNPAY, API, fakeFetch);
    eInvoices = new EInvoiceService(db, provider, runner, WORK);
    adjustments = new InvoiceAdjustmentService(db, provider, runner, WORK);
    refunds = new RefundService(db, vnpay, runner, WORK, eInvoices);
    seq += 1;
    admin = Number(
      (
        await one(
          `INSERT INTO users (email, full_name, role) VALUES ($1, 'A', 'admin') RETURNING id`,
          [`p9b-admin-${seq}@t32.test`],
        )
      )['id'],
    );
    await q('INSERT INTO admins (user_id) VALUES ($1)', [admin]);
  });
  beforeEach(async () => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Cô lập: việc còn chờ của ca trước không tới hạn trong ca sau.
    await q(
      `UPDATE refunds SET next_attempt_at = now() + interval '1 day' WHERE status = 'requested'`,
    );
    await q(
      `UPDATE invoice_adjustments SET next_attempt_at = now() + interval '1 day'
       WHERE status IN ('requested', 'failed')`,
    );
    refundSteps = [];
    querySteps = [];
    adjSteps = [];
    adjCalls = [];
    kick.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('tạo điều chỉnh trong tx2 khi refund done', () => {
    it('top_up gửi thành công → đúng 1 dòng requested, amount = −refund, adjustment_no 1, kick sau commit', async () => {
      const t = await topUp();
      const refundId = await mkRefund(t.id);
      await runRefunds();
      expect(await refundStatus(refundId)).toBe('done');
      const rows = await adjOf(refundId);
      expect(rows).toEqual([
        {
          id: expect.any(Number),
          e_invoice_id: t.invoiceId,
          adjustment_no: 1,
          reason: `Điều chỉnh giảm do hoàn tiền (refund ${refundId})`,
          amount_vnd: -100_000,
          refund_id: refundId,
          status: 'requested',
        },
      ]);
      expect(kick).toHaveBeenCalledWith(INVOICE_ADJUSTMENT_ISSUE_WORK);
    });

    it('top_up done nhờ querydr → có dòng', async () => {
      const t = await topUp({ amount: 80_000 });
      const refundId = await mkRefund(t.id, 'top_up', 80_000);
      // Lượt sau lỗi tạm thời: chỉ truy vấn.
      await q(
        `UPDATE refunds SET attempt_count = 1, last_error_kind = 'transient',
           last_attempt_at = now(), next_attempt_at = now() - interval '1 second' WHERE id=$1`,
        [refundId],
      );
      querySteps = [queryReply('02', '00', t.txn, 80_000)];
      await runRefunds();
      expect(
        await one('SELECT status::text, confirmed_via_query FROM refunds WHERE id=$1', [refundId]),
      ).toEqual({ status: 'done', confirmed_via_query: true });
      expect(await adjOf(refundId)).toEqual([
        expect.objectContaining({ adjustment_no: 1, amount_vnd: -80_000, status: 'requested' }),
      ]);
    });

    it('late_payment → không có dòng (không có hoá đơn gốc cho khoản trễ)', async () => {
      const t = await topUp({ late: 30_000 });
      const refundId = await mkRefund(t.id, 'late_payment', 30_000);
      await runRefunds();
      expect(await refundStatus(refundId)).toBe('done');
      expect(await adjOf(refundId)).toEqual([]);
      expect(kick).not.toHaveBeenCalledWith(INVOICE_ADJUSTMENT_ISSUE_WORK);
    });

    it('account_closure → có dòng', async () => {
      const t = await topUp();
      const refundId = await mkRefund(t.id, 'account_closure', 40_000);
      await runRefunds();
      expect(await refundStatus(refundId)).toBe('done');
      expect(await adjOf(refundId)).toEqual([
        expect.objectContaining({ e_invoice_id: t.invoiceId, amount_vnd: -40_000 }),
      ]);
    });

    it('không có hoá đơn gốc → 0 dòng, refund vẫn done, warn invoice_adjustment_no_original', async () => {
      const t = await topUp({ invoice: null });
      const refundId = await mkRefund(t.id);
      await runRefunds();
      expect(await refundStatus(refundId)).toBe('done');
      expect(await adjOf(refundId)).toEqual([]);
      expect(logged(warnSpy, 'invoice_adjustment_no_original')).toEqual([
        expect.objectContaining({ refund_id: refundId, top_up_id: t.id }),
      ]);
    });

    it('refund bị từ chối (failed) hoặc còn requested → 0 dòng', async () => {
      const a = await topUp();
      const ra = await mkRefund(a.id);
      refundSteps = [refundOk({ vnp_ResponseCode: '95' })];
      await runRefunds();
      expect(await refundStatus(ra)).toBe('failed');
      expect(await adjOf(ra)).toEqual([]);

      const b = await topUp();
      const rb = await mkRefund(b.id);
      refundSteps = [HTTP_500];
      await runRefunds();
      expect(await refundStatus(rb)).toBe('requested');
      expect(await adjOf(rb)).toEqual([]);
    });

    it('tx2 rollback sau khi đã tạo điều chỉnh → 0 dòng, refund vẫn requested', async () => {
      const t = await topUp();
      const refundId = await mkRefund(t.id);
      const real = EInvoiceService.prototype.adjustForRefund.bind(eInvoices);
      jest.spyOn(eInvoices, 'adjustForRefund').mockImplementationOnce(async (c, id) => {
        await real(c, id);
        throw new Error('crash_before_tx2_commit');
      });
      await runRefunds();
      expect(await refundStatus(refundId)).toBe('requested');
      expect(await adjOf(refundId)).toEqual([]);
    });

    it('gọi lại adjustForRefund cho cùng refund → vẫn 1 dòng, created false', async () => {
      const t = await topUp();
      const { refundId, adjustmentId } = await doneWithAdjustment(t.id);
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        expect(await eInvoices.adjustForRefund(c, refundId)).toEqual({
          id: adjustmentId,
          created: false,
        });
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(await adjOf(refundId)).toHaveLength(1);
    });

    it('RefundService thiếu EInvoiceService → refund vẫn done, 0 dòng, log error invoice_adjustment_service_missing', async () => {
      const t = await topUp();
      const refundId = await mkRefund(t.id);
      const bare = new RefundService(db, vnpay, runner, WORK);
      await runRefunds(bare);
      expect(await refundStatus(refundId)).toBe('done');
      expect(await adjOf(refundId)).toEqual([]);
      expect(logged(errorSpy, 'invoice_adjustment_service_missing')).toEqual([
        expect.objectContaining({ refund_id: refundId, top_up_id: t.id, kind: 'top_up' }),
      ]);
    });

    it('RefundService thiếu EInvoiceService, refund late_payment → không log thiếu service', async () => {
      const t = await topUp({ late: 20_000 });
      await mkRefund(t.id, 'late_payment', 20_000);
      await runRefunds(new RefundService(db, vnpay, runner, WORK));
      expect(logged(errorSpy, 'invoice_adjustment_service_missing')).toEqual([]);
    });

    it('adjustForRefund: refund chưa done → ném (lỗi lập trình); ca dữ liệu → skipped, không ném', async () => {
      const noOriginal = await topUp({ invoice: null });
      const late = await topUp({ late: 10_000 });
      const pending = await mkRefund((await topUp()).id);
      const rNo = await mkRefund(noOriginal.id);
      const rLate = await mkRefund(late.id, 'late_payment', 10_000);
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        await expect(eInvoices.adjustForRefund(c, pending)).rejects.toThrow(
          'invoice_adjustment_refund_not_done',
        );
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await markDone(c, rNo);
        await markDone(c, rLate);
        expect(await eInvoices.adjustForRefund(c, rNo)).toEqual({ skipped: 'no_original' });
        expect(await eInvoices.adjustForRefund(c, rLate)).toEqual({ skipped: 'late_payment' });
        expect(await eInvoices.adjustForRefund(c, 987_654_321)).toEqual({
          skipped: 'refund_not_found',
        });
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(await adjOf(rNo)).toEqual([]);
      expect(await adjOf(rLate)).toEqual([]);
    });

    it('hai refund done đồng thời trên cùng hoá đơn (hai connection) → adjustment_no 1 và 2, không lỗi UNIQUE', async () => {
      const t = await topUp();
      const r1 = await mkRefund(t.id, 'top_up', 60_000);
      const r2 = await mkRefund(t.id, 'account_closure', 40_000);
      const a = await db.$client.connect();
      const b = await db.$client.connect();
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        await markDone(a, r1);
        await markDone(b, r2);
        await eInvoices.adjustForRefund(a, r1);
        let bDone = false;
        const pb = eInvoices.adjustForRefund(b, r2).then((r) => {
          bDone = true;
          return r;
        });
        // b phải chờ khoá e_invoices của a.
        await new Promise((r) => setTimeout(r, 200));
        expect(bDone).toBe(false);
        await a.query('COMMIT');
        await expect(pb).resolves.toMatchObject({ created: true });
        await b.query('COMMIT');
      } catch (e) {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        a.release();
        b.release();
      }
      expect((await adjOf(r1))[0]).toMatchObject({ adjustment_no: 1, amount_vnd: -60_000 });
      expect((await adjOf(r2))[0]).toMatchObject({ adjustment_no: 2, amount_vnd: -40_000 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('worker invoice-adjustment-issue', () => {
    it('gốc issued → issued, provider_adjustment_no; gửi số gốc, thuế suất gốc, thuế âm, thời điểm hoàn', async () => {
      const t = await topUp();
      const { refundId, adjustmentId } = await doneWithAdjustment(t.id);
      expect(await runAdj()).toBe(1);
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'issued',
        provider_adjustment_no: `ADJ-${adjustmentId}`,
        attempt_count: 1,
        issued: true,
        no_next: true,
      });
      const completed = (await one('SELECT completed_at FROM refunds WHERE id=$1', [refundId]))[
        'completed_at'
      ] as Date;
      expect(adjCalls).toEqual([
        {
          idempotencyKey: String(adjustmentId),
          originalInvoiceNo: `INV-${t.invoiceId}`,
          adjustmentNo: 1,
          reason: `Điều chỉnh giảm do hoàn tiền (refund ${refundId})`,
          amountVnd: -100_000,
          vatRate: 8,
          vatAmountVnd: -7_407,
          refundedAt: completed,
        },
      ]);
      expect(logged(logSpy, 'invoice_adjustment_issued')).toEqual([
        {
          event: 'invoice_adjustment_issued',
          invoice_adjustment_id: adjustmentId,
          e_invoice_id: t.invoiceId,
          attempt_count: 1,
          provider_adjustment_no: `ADJ-${adjustmentId}`,
        },
      ]);
    });

    it('đồng hồ đã sang 2027, hoá đơn gốc 8% → vẫn gửi vatRate 8; gốc 10% → 10', async () => {
      const t8 = await topUp({ invoice: { vatRate: 8 } });
      const t10 = await topUp({ invoice: { vatRate: 10 } });
      await doneWithAdjustment(t8.id);
      await doneWithAdjustment(t10.id);
      jest.useFakeTimers({
        now: new Date('2027-01-02T10:00:00+07:00'),
        doNotFake: [...FAKE_DATE_ONLY],
      });
      expect(new Date().getFullYear()).toBe(2027);
      expect(await runAdj()).toBe(2);
      jest.useRealTimers();
      const byNo = Object.fromEntries(adjCalls.map((c) => [c.originalInvoiceNo, c]));
      expect(byNo[`INV-${t8.invoiceId}`]).toMatchObject({ vatRate: 8, vatAmountVnd: -7_407 });
      expect(byNo[`INV-${t10.invoiceId}`]).toMatchObject({ vatRate: 10, vatAmountVnd: -9_091 });
    });

    it.each(['requested', 'failed', 'needs_review'] as const)(
      'gốc %s → failed original_not_issued, không gọi nhà cung cấp; hết lượt → needs_review',
      async (status) => {
        const t = await topUp({ invoice: { status } });
        const { adjustmentId } = await doneWithAdjustment(t.id);
        await runAdj();
        expect(await adjRow(adjustmentId)).toMatchObject({
          status: 'failed',
          attempt_count: 1,
          last_error_kind: 'transient',
          last_error_message: 'original_not_issued',
          delay_s: 300,
        });
        for (let i = 0; i < 3; i++) {
          await makeDue(adjustmentId);
          await runAdj();
        }
        expect(await adjRow(adjustmentId)).toMatchObject({
          status: 'needs_review',
          attempt_count: 4,
          last_error_message: 'original_not_issued',
          no_next: true,
        });
        expect(adjCalls).toEqual([]);
      },
    );

    it('gốc được phát hành sau → lượt kế gửi được', async () => {
      const t = await topUp({ invoice: { status: 'requested' } });
      const { adjustmentId } = await doneWithAdjustment(t.id);
      await runAdj();
      await q(
        `UPDATE e_invoices SET status = 'issued', invoice_no = 'INV-' || id, issued_at = now(),
           next_attempt_at = NULL WHERE id=$1`,
        [t.invoiceId],
      );
      await makeDue(adjustmentId);
      await runAdj();
      expect(await adjRow(adjustmentId)).toMatchObject({ status: 'issued', attempt_count: 2 });
      expect(adjCalls).toHaveLength(1);
    });

    it('vượt trần hoá đơn gốc → needs_review adjustment_exceeds_original, không gọi nhà cung cấp', async () => {
      const t = await topUp();
      const first = await doneWithAdjustment(t.id, 'top_up', 60_000);
      await q(
        `UPDATE invoice_adjustments SET next_attempt_at = now() + interval '1 day' WHERE id=$1`,
        [first.adjustmentId],
      );
      const second = await doneWithAdjustment(t.id, 'account_closure', 40_001);
      await runAdj();
      expect(await adjRow(second.adjustmentId)).toMatchObject({
        status: 'needs_review',
        attempt_count: 1,
        last_error_kind: 'data',
        last_error_message: 'adjustment_exceeds_original',
        no_next: true,
      });
      expect(adjCalls).toEqual([]);
      expect(logged(errorSpy, 'invoice_adjustment_needs_review')).toEqual([
        expect.objectContaining({
          invoice_adjustment_id: second.adjustmentId,
          last_error_kind: 'data',
        }),
      ]);
    });

    it('đúng bằng trần → gửi được', async () => {
      const t = await topUp();
      const first = await doneWithAdjustment(t.id, 'top_up', 60_000);
      const second = await doneWithAdjustment(t.id, 'account_closure', 40_000);
      expect(await runAdj()).toBe(2);
      expect((await adjRow(first.adjustmentId))['status']).toBe('issued');
      expect((await adjRow(second.adjustmentId))['status']).toBe('issued');
    });

    it('transient ba lượt → +5 phút / +30 phút / +2 giờ; lượt 4 → needs_review', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [TRANSIENT, TRANSIENT, TRANSIENT, TRANSIENT];
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        await runAdj();
        const r = await adjRow(adjustmentId);
        expect(r).toMatchObject({ status: 'failed', attempt_count: i + 1 });
        delays.push(Number(r['delay_s']));
        await makeDue(adjustmentId);
      }
      expect(delays).toEqual([300, 1800, 7200]);
      await runAdj();
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'needs_review',
        attempt_count: 4,
        last_error_message: 'provider 503',
        no_next: true,
      });
      expect(adjCalls).toHaveLength(4);
    });

    it('bị từ chối (data) → needs_review ngay', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [DATA];
      await runAdj();
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'needs_review',
        attempt_count: 1,
        last_error_kind: 'data',
        last_error_message: 'không cho điều chỉnh',
      });
    });

    it('nhà cung cấp treo quá timeout → transient provider_timeout', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [HANG];
      const short = new InvoiceAdjustmentService(db, provider, runner, WORK, 50);
      await runAdj(short);
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'failed',
        last_error_kind: 'transient',
        last_error_message: 'provider_timeout',
      });
    });

    it('thông điệp lỗi dài → cắt còn 500 ký tự', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [async () => ({ kind: 'data', message: 'x'.repeat(2000) })];
      await runAdj();
      expect(String((await adjRow(adjustmentId))['last_error_message'])).toHaveLength(500);
    });

    it('mất lease ở tx2 → bỏ kết quả, log invoice_adjustment_lease_lost; lượt sau gọi lại cùng khoá → cùng số', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [
        async (i) => {
          await q(
            "UPDATE invoice_adjustments SET next_attempt_at = now() + interval '1 hour' WHERE id=$1",
            [adjustmentId],
          );
          return ADJ_ISSUED(i, new AbortController().signal);
        },
      ];
      expect(await runAdj()).toBe(1);
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'requested',
        attempt_count: 0,
        provider_adjustment_no: null,
      });
      expect(logged(logSpy, 'invoice_adjustment_lease_lost')).toEqual([
        {
          event: 'invoice_adjustment_lease_lost',
          invoice_adjustment_id: adjustmentId,
          kind: 'issued',
        },
      ]);
      await makeDue(adjustmentId);
      expect(await runAdj()).toBe(1);
      expect(adjCalls.map((c) => c.idempotencyKey)).toEqual([
        String(adjustmentId),
        String(adjustmentId),
      ]);
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'issued',
        provider_adjustment_no: `ADJ-${adjustmentId}`,
        attempt_count: 1,
      });
    });

    it('hai worker song song trên hai pool → mỗi điều chỉnh gọi nhà cung cấp đúng một lần', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++)
        ids.push((await doneWithAdjustment((await topUp()).id)).adjustmentId);
      const slow: AdjStep = async (i) => {
        await new Promise((r) => setTimeout(r, 30));
        return ADJ_ISSUED(i, new AbortController().signal);
      };
      adjSteps = [slow, slow, slow, slow, slow, slow];
      const db2 = createDb(DATABASE_URL as string);
      try {
        const other = new InvoiceAdjustmentService(db2, provider, runner, WORK);
        const [a, b] = await Promise.all([runAdj(), runAdj(other)]);
        expect(a + b).toBe(3);
      } finally {
        await db2.$client.end();
      }
      expect(adjCalls.map((c) => c.idempotencyKey).sort()).toEqual(ids.map(String).sort());
      for (const id of ids) expect((await adjRow(id))['status']).toBe('issued');
    });

    it('tx2 ném 5 lần → lần giữ chỗ thứ 6 không gọi nhà cung cấp, onExhausted → needs_review, attempt_count 4', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      const spy = jest
        .spyOn(adjustments as unknown as { applyResult: () => Promise<unknown> }, 'applyResult')
        .mockRejectedValue(new Error('lỗi lặp ở tx2'));
      for (let i = 1; i <= 5; i++) {
        expect(await runAdj()).toBe(1);
        expect((await adjRow(adjustmentId))['unfinished_claims']).toBe(i);
        await makeDue(adjustmentId);
      }
      spy.mockRestore();
      expect(adjCalls).toHaveLength(5);
      expect(await runAdj()).toBe(1);
      expect(adjCalls).toHaveLength(5);
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'needs_review',
        attempt_count: 4,
        unfinished_claims: 6,
        last_error_kind: 'transient',
        last_error_message: 'unfinished_claims_exhausted',
        no_next: true,
      });
      expect(logged(errorSpy, 'invoice_adjustment_needs_review')).toEqual([
        {
          event: 'invoice_adjustment_needs_review',
          invoice_adjustment_id: adjustmentId,
          e_invoice_id: t.invoiceId,
          attempt_count: 4,
          reason: 'unfinished_claims_exhausted',
          unfinished_claims: 6,
        },
      ]);
      expect(logged(errorSpy, 'leased_row_exhausted').some((l) => l['no_handler'])).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('Admin retry điều chỉnh (route ở 10b)', () => {
    it('needs_review → requested, giữ attempt_count, bộ đếm về 0, đến hạn ngay; log admin_id; kick; lượt sau issued', async () => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      adjSteps = [DATA];
      await runAdj();
      await q('UPDATE invoice_adjustments SET unfinished_claims = 3 WHERE id=$1', [adjustmentId]);
      kick.mockClear();
      expect(await adjustments.adminRetryAdjustment(adjustmentId, admin)).toEqual({
        invoiceAdjustmentId: adjustmentId,
        status: 'requested',
        attemptCount: 1,
      });
      expect(await adjRow(adjustmentId)).toMatchObject({
        status: 'requested',
        attempt_count: 1,
        unfinished_claims: 0,
        due: true,
      });
      expect(kick).toHaveBeenCalledWith(INVOICE_ADJUSTMENT_ISSUE_WORK);
      expect(logged(logSpy, 'invoice_adjustment_admin_retry')).toEqual([
        expect.objectContaining({
          invoice_adjustment_id: adjustmentId,
          admin_id: admin,
          attempt_count: 1,
        }),
      ]);
      await runAdj();
      expect(await adjRow(adjustmentId)).toMatchObject({ status: 'issued', attempt_count: 2 });
    });

    it.each(['requested', 'issued'] as const)('trên %s → InvalidTransition', async (status) => {
      const t = await topUp();
      const { adjustmentId } = await doneWithAdjustment(t.id);
      if (status === 'issued') await runAdj();
      await expect(adjustments.adminRetryAdjustment(adjustmentId, admin)).rejects.toBeInstanceOf(
        InvalidTransition,
      );
    });

    it('không có điều chỉnh → InvoiceAdjustmentNotFound', async () => {
      await expect(adjustments.adminRetryAdjustment(987_654_321, admin)).rejects.toBeInstanceOf(
        InvoiceAdjustmentNotFound,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('BillingModule thật (Nest), BILLING_WORKER_ENABLED=false', () => {
    it('invoice-adjustment-issue được đăng ký; RefundService được tiêm EInvoiceService của Nest', async () => {
      const saved = process.env['BILLING_WORKER_ENABLED'];
      process.env['BILLING_WORKER_ENABLED'] = 'false';
      @Module({ imports: [ConfigModule, BillingModule] })
      class TestModule {}
      try {
        const app = await NestFactory.createApplicationContext(TestModule, {
          logger: ['error'],
          abortOnError: false,
        });
        try {
          expect(() =>
            app.get(BackgroundWorkRunner).kick(INVOICE_ADJUSTMENT_ISSUE_WORK),
          ).not.toThrow();
          expect(app.get(InvoiceAdjustmentService)).toBeInstanceOf(InvoiceAdjustmentService);
          const eInv = app.get(EInvoiceService);
          expect((app.get(RefundService) as unknown as { eInvoices: unknown }).eInvoices).toBe(
            eInv,
          );
        } finally {
          await app.close();
        }
      } finally {
        if (saved === undefined) delete process.env['BILLING_WORKER_ENABLED'];
        else process.env['BILLING_WORKER_ENABLED'] = saved;
      }
    });
  });
});
