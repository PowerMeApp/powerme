/**
 * Test tích hợp việc nền xuất hoá đơn `e-invoice-issue` và Admin retry (T32 Phần 7; SD-2c, STM-7,
 * decisions D5 / D7) trên Postgres thật, nhà cung cấp giả tiêm vào (không dùng biến môi trường).
 *
 * Vì sao tồn tại: hoá đơn là việc gọi ra ngoài chạy nền theo lease. Hỏng âm thầm có thể là: gọi nhà
 * cung cấp hai lần cho một hoá đơn (hai worker, hoặc mất lease mà vẫn ghi), cấp hai số hoá đơn cho
 * một khoản thu, retry sai lịch / quá 4 lượt, lỗi bị từ chối vẫn tự thử lại, Admin retry reset bộ
 * đếm, gửi thuế suất tính lại lúc gọi (vắt qua 31/12) thay vì thuế suất đã chốt lúc thu tiền, hoặc
 * hoá đơn hỏng kéo theo top-up.
 *
 * Phần cuối dựng `BillingModule` thật bằng Nest với `BILLING_WORKER_ENABLED=false`: việc nền vẫn
 * được đăng ký (kick không ném) và `TopUpService` được tiêm `EInvoiceService`.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { EInvoiceNotFound } from '../src/billing/billing-errors.js';
import {
  EInvoiceInput,
  EInvoiceProviderAdapter,
  EInvoiceResult,
} from '../src/billing/e-invoice-provider.js';
import { E_INVOICE_ISSUE_WORK, EInvoiceService } from '../src/billing/e-invoice.service.js';
import { InvalidTransition } from '../src/billing/invalid-transition.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { ConfigModule } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};

type Step = (input: EInvoiceInput, signal: AbortSignal) => Promise<EInvoiceResult>;

/** Nhà cung cấp idempotent theo khoá: cùng khoá → cùng số. */
const ISSUED: Step = async (i) => ({ kind: 'issued', invoiceNo: `INV-${i.idempotencyKey}` });
const TRANSIENT: Step = async () => ({ kind: 'transient', message: 'provider 503' });
const DATA: Step = async () => ({ kind: 'data', message: 'MST người bán sai' });
const HANG: Step = () => new Promise(() => undefined);

describeDb('billing: việc nền e-invoice-issue + Admin retry (T32 Phần 7, SD-2c, STM-7)', () => {
  let db: Db;
  let seq = 0;
  /** Kịch bản theo lượt gọi; hết kịch bản → ISSUED. */
  let steps: Step[] = [];
  let calls: EInvoiceInput[] = [];
  const provider: EInvoiceProviderAdapter = {
    createInvoice: (input, signal) => {
      calls.push(input);
      return (steps.shift() ?? ISSUED)(input, signal);
    },
  };
  const kick = jest.fn();
  const runner = { register: jest.fn(), kick } as unknown as BackgroundWorkRunner;
  let service: EInvoiceService;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const run = (s: EInvoiceService = service) => s.runDue(20, new AbortController().signal);

  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  /**
   * Top-up `credited` (SQL) + hoá đơn tạo bằng `requestForTopUp` thật trong một transaction, như
   * nhánh `credited` của `applyLockedResult`. Trả id hoá đơn.
   */
  async function invoiceFor(
    amountPaidVnd = 100_000,
    completedAt: string | null = null,
  ): Promise<{ id: number; topUpId: number }> {
    seq += 1;
    const user = (
      await one(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`p7-${seq}@t32.test`],
      )
    )['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    const acc = (
      await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user])
    )['id'];
    const c = await db.$client.connect();
    try {
      await c.query('BEGIN');
      const topUpId = Number(
        (
          await c.query<{ id: string }>(
            `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
               status, gateway_transaction_no, idempotency_key, expires_at, created_at, completed_at)
             VALUES ($1, $2, $3, $3, 'credited', $4, $5,
               COALESCE($6::timestamptz, now()) + interval '10 minutes',
               COALESCE($6::timestamptz, now()) - interval '1 minute',
               COALESCE($6::timestamptz, now()))
             RETURNING id`,
            [`P7REF${seq}`, acc, amountPaidVnd, String(60_000_000 + seq), `p7-${seq}`, completedAt],
          )
        ).rows[0]!.id,
      );
      const inv = await service.requestForTopUp(c, topUpId);
      await c.query('COMMIT');
      return { id: inv.id, topUpId };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const row = (id: number) =>
    one(
      `SELECT status::text, invoice_no, attempt_count, last_error_kind::text, last_error_message,
              issued_at IS NOT NULL AS issued, last_attempt_at IS NOT NULL AS attempted,
              next_attempt_at IS NULL AS no_next, next_attempt_at <= now() AS due,
              round(extract(epoch FROM next_attempt_at - last_attempt_at))::int AS delay_s
       FROM e_invoices WHERE id=$1`,
      [id],
    );
  const makeDue = (id: number) =>
    q("UPDATE e_invoices SET next_attempt_at = now() - interval '1 second' WHERE id=$1", [id]);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    service = new EInvoiceService(db, provider, runner, WORK);
  });
  beforeEach(async () => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Cô lập: hoá đơn còn chờ của ca trước không tới hạn trong ca sau.
    await q(
      `UPDATE e_invoices SET next_attempt_at = now() + interval '1 day'
       WHERE status IN ('requested', 'failed')`,
    );
    steps = [];
    calls = [];
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
  describe('một lượt gọi nhà cung cấp', () => {
    it('thành công → issued: invoice_no, issued_at, next_attempt_at NULL, attempt_count 1; gửi đúng số trên dòng, khoá = id; log e_invoice_issued', async () => {
      const inv = await invoiceFor(200_000, '2026-11-17T09:00:00+07:00');
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'issued',
        invoice_no: `INV-${inv.id}`,
        attempt_count: 1,
        last_error_kind: null,
        issued: true,
        attempted: true,
        no_next: true,
      });
      expect(calls).toEqual([
        {
          idempotencyKey: String(inv.id),
          description: 'Trả trước dịch vụ sạc xe điện',
          amountVnd: 200_000,
          vatRate: 8,
          vatAmountVnd: 14_815,
          paidAt: new Date('2026-11-17T09:00:00+07:00'),
        },
      ]);
      expect(logged(logSpy, 'e_invoice_issued')).toEqual([
        {
          event: 'e_invoice_issued',
          e_invoice_id: inv.id,
          top_up_id: inv.topUpId,
          attempt_count: 1,
          invoice_no: `INV-${inv.id}`,
        },
      ]);
      // Đã issued: không ai giữ chỗ / gọi lại.
      expect(await run()).toBe(0);
      expect(calls).toHaveLength(1);
    });

    it('transient ba lượt → failed, next_attempt_at +5 phút / +30 phút / +2 giờ (đồng hồ DB); lượt 4 → needs_review, next_attempt_at NULL, log error', async () => {
      const inv = await invoiceFor();
      steps = [TRANSIENT, TRANSIENT, TRANSIENT, TRANSIENT];
      for (const [n, delay] of [
        [1, 5 * 60],
        [2, 30 * 60],
        [3, 2 * 60 * 60],
      ] as const) {
        if (n > 1) await makeDue(inv.id);
        expect(await run()).toBe(1);
        expect(await row(inv.id)).toMatchObject({
          status: 'failed',
          attempt_count: n,
          last_error_kind: 'transient',
          last_error_message: 'provider 503',
          delay_s: delay,
          due: false,
        });
        // Chưa tới hạn: lượt quét ngay sau không lấy.
        expect(await run()).toBe(0);
      }
      expect(logged(warnSpy, 'e_invoice_attempt_failed')).toHaveLength(3);
      await makeDue(inv.id);
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'needs_review',
        attempt_count: 4,
        last_error_kind: 'transient',
        no_next: true,
      });
      expect(logged(errorSpy, 'e_invoice_needs_review')).toEqual([
        {
          event: 'e_invoice_needs_review',
          e_invoice_id: inv.id,
          top_up_id: inv.topUpId,
          attempt_count: 4,
          last_error_kind: 'transient',
          last_error_message: 'provider 503',
        },
      ]);
      expect(calls).toHaveLength(4);
      expect(new Set(calls.map((c) => c.idempotencyKey))).toEqual(new Set([String(inv.id)]));
      // needs_review: vòng quét không tự thử lại.
      expect(await run()).toBe(0);
    });

    it('bị từ chối (data) ngay lượt 1 → needs_review, không tự thử lại', async () => {
      const inv = await invoiceFor();
      steps = [DATA];
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'needs_review',
        attempt_count: 1,
        last_error_kind: 'data',
        last_error_message: 'MST người bán sai',
        no_next: true,
      });
      expect(logged(errorSpy, 'e_invoice_needs_review')).toHaveLength(1);
    });

    it('nhà cung cấp treo quá timeout → transient provider_timeout, failed', async () => {
      const short = new EInvoiceService(db, provider, runner, WORK, 50);
      const inv = await invoiceFor();
      steps = [HANG];
      expect(await run(short)).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'failed',
        attempt_count: 1,
        last_error_kind: 'transient',
        last_error_message: 'provider_timeout',
      });
    });

    it('thông điệp lỗi dài → cắt còn 500 ký tự', async () => {
      const inv = await invoiceFor();
      steps = [async () => ({ kind: 'data', message: 'x'.repeat(2000) })];
      await run();
      expect(String((await row(inv.id))['last_error_message'])).toHaveLength(500);
    });

    it('hoá đơn needs_review: top-up vẫn credited', async () => {
      const inv = await invoiceFor();
      steps = [DATA];
      await run();
      expect((await row(inv.id))['status']).toBe('needs_review');
      expect(
        (await one('SELECT status::text FROM top_ups WHERE id=$1', [inv.topUpId]))['status'],
      ).toBe('credited');
    });

    it('dòng tạo trước mốc 01/01/2027 (vat_rate 8), gọi nhà cung cấp khi đồng hồ đã sang 2027 → vẫn gửi vatRate 8 lấy từ dòng', async () => {
      const inv = await invoiceFor(100_000, '2026-12-31T23:00:00+07:00');
      expect(
        await one('SELECT vat_rate, vat_amount_vnd FROM e_invoices WHERE id=$1', [inv.id]),
      ).toEqual({ vat_rate: 8, vat_amount_vnd: '7407' });
      // Chỉ giả Date (pg và timer thật vẫn chạy).
      jest.useFakeTimers({
        now: new Date('2027-01-02T10:00:00+07:00'),
        doNotFake: [
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
        ],
      });
      expect(new Date().getFullYear()).toBe(2027);
      await makeDue(inv.id);
      expect(await run()).toBe(1);
      jest.useRealTimers();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ vatRate: 8, vatAmountVnd: 7_407, amountVnd: 100_000 });
      expect((await row(inv.id))['status']).toBe('issued');
    });

    it('đang shutdown (signal huỷ trong lúc gọi) → không ghi gì, dòng giữ requested chờ hết lease', async () => {
      const inv = await invoiceFor();
      const ctrl = new AbortController();
      steps = [
        async (i) => {
          ctrl.abort();
          return ISSUED(i, ctrl.signal);
        },
      ];
      expect(await service.runDue(20, ctrl.signal)).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'requested',
        attempt_count: 0,
        invoice_no: null,
        due: false,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('lease và chạy song song', () => {
    it('mất lease ở tx2 (runner khác đã lấy lại) → bỏ kết quả, log e_invoice_lease_lost; lượt sau gọi lại cùng khoá → một invoice_no', async () => {
      const inv = await invoiceFor();
      steps = [
        async (i) => {
          // Giả runner khác lấy lại dòng sau khi hết lease: token (next_attempt_at) đổi.
          await q("UPDATE e_invoices SET next_attempt_at = now() + interval '1 hour' WHERE id=$1", [
            inv.id,
          ]);
          return ISSUED(i, new AbortController().signal);
        },
      ];
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'requested',
        attempt_count: 0,
        invoice_no: null,
      });
      expect(logged(logSpy, 'e_invoice_lease_lost')).toEqual([
        { event: 'e_invoice_lease_lost', e_invoice_id: inv.id, kind: 'issued' },
      ]);
      await makeDue(inv.id);
      expect(await run()).toBe(1);
      expect(calls.map((c) => c.idempotencyKey)).toEqual([String(inv.id), String(inv.id)]);
      expect(await row(inv.id)).toMatchObject({
        status: 'issued',
        invoice_no: `INV-${inv.id}`,
        attempt_count: 1,
      });
      expect(
        await one('SELECT count(*)::int AS n FROM e_invoices WHERE invoice_no=$1', [
          `INV-${inv.id}`,
        ]),
      ).toEqual({ n: 1 });
    });

    it('hai worker song song trên hai pool → nhà cung cấp được gọi đúng một lần mỗi hoá đơn, tất cả issued', async () => {
      const ids = [(await invoiceFor()).id, (await invoiceFor()).id, (await invoiceFor()).id];
      for (const id of ids) await makeDue(id);
      const slow: Step = async (i) => {
        await new Promise((r) => setTimeout(r, 30));
        return ISSUED(i, new AbortController().signal);
      };
      steps = [slow, slow, slow, slow, slow, slow];
      const db2 = createDb(DATABASE_URL as string);
      try {
        const other = new EInvoiceService(db2, provider, runner, WORK);
        const [a, b] = await Promise.all([run(service), run(other)]);
        expect(a + b).toBe(3);
      } finally {
        await db2.$client.end();
      }
      expect(calls.map((c) => c.idempotencyKey).sort()).toEqual(ids.map(String).sort());
      for (const id of ids) expect((await row(id))['status']).toBe('issued');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('Admin retry (STM-7 #7, route ở Phần 10)', () => {
    /** Hoá đơn needs_review sau `attempts` lượt lỗi (fixture SQL thoả mọi CHECK). */
    async function needsReview(attempts: number): Promise<{ id: number; topUpId: number }> {
      const inv = await invoiceFor();
      await q(
        `UPDATE e_invoices SET status='needs_review', attempt_count=$2, last_error_kind='transient',
           last_error_message='provider 503', last_attempt_at=now(), next_attempt_at=NULL,
           updated_at=now() WHERE id=$1`,
        [inv.id, attempts],
      );
      return inv;
    }

    it('needs_review → requested, đến hạn ngay, GIỮ attempt_count; log admin_id; kick sau commit; lượt sau thành công → issued', async () => {
      const inv = await needsReview(4);
      expect(await service.adminRetry(inv.id, 777)).toEqual({
        eInvoiceId: inv.id,
        status: 'requested',
        attemptCount: 4,
      });
      expect(await row(inv.id)).toMatchObject({ status: 'requested', attempt_count: 4, due: true });
      expect(kick).toHaveBeenCalledWith(E_INVOICE_ISSUE_WORK);
      expect(logged(logSpy, 'e_invoice_admin_retry')).toEqual([
        {
          event: 'e_invoice_admin_retry',
          e_invoice_id: inv.id,
          top_up_id: inv.topUpId,
          admin_id: 777,
          attempt_count: 4,
        },
      ]);
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({ status: 'issued', attempt_count: 5 });
    });

    it('Admin retry rồi lỗi tạm thời khi bộ đếm đã ≥ 4 → lại needs_review (một lượt), attempt_count 5', async () => {
      const inv = await needsReview(4);
      await service.adminRetry(inv.id, 777);
      steps = [TRANSIENT];
      expect(await run()).toBe(1);
      expect(await row(inv.id)).toMatchObject({
        status: 'needs_review',
        attempt_count: 5,
        no_next: true,
      });
    });

    it.each([
      ['issued', ISSUED],
      ['failed', TRANSIENT],
    ] as const)('trên %s → InvalidTransition STM-7, không đổi gì', async (status, step) => {
      const inv = await invoiceFor();
      steps = [step];
      await run();
      const before = await row(inv.id);
      expect(before['status']).toBe(status);
      await expect(service.adminRetry(inv.id, 777)).rejects.toThrow(InvalidTransition);
      await expect(service.adminRetry(inv.id, 777)).rejects.toMatchObject({
        machine: 'STM-7',
        from: status,
        event: 'ADMIN_RETRY',
      });
      expect(await row(inv.id)).toEqual(before);
      expect(kick).not.toHaveBeenCalled();
    });

    it('trên requested → InvalidTransition', async () => {
      const inv = await invoiceFor();
      await expect(service.adminRetry(inv.id, 777)).rejects.toThrow(InvalidTransition);
    });

    it('hoá đơn không có → EInvoiceNotFound', async () => {
      await expect(service.adminRetry(999_999_999, 777)).rejects.toThrow(EInvoiceNotFound);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('BillingModule thật (Nest), BILLING_WORKER_ENABLED=false', () => {
    it('e-invoice-issue vẫn được đăng ký (kick không ném), TopUpService được tiêm EInvoiceService', async () => {
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
          const workRunner = app.get(BackgroundWorkRunner);
          expect(() => workRunner.kick(E_INVOICE_ISSUE_WORK)).not.toThrow();
          expect(() => workRunner.kick('khong-co')).toThrow('background_work_unknown');
          const eInv = app.get(EInvoiceService);
          expect(eInv).toBeInstanceOf(EInvoiceService);
          expect((app.get(TopUpService) as unknown as { eInvoices: unknown }).eInvoices).toBe(eInv);
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
