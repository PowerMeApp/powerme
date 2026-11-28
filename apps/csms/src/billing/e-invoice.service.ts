/**
 * EInvoiceService — hoá đơn điện tử cho top-up `credited` (T32 Phần 7; SD-2c, STM-7, decisions D5).
 *
 * T32 Phần 9b: `adjustForRefund(c, refundId)` tạo điều chỉnh giảm trong tx2 của refund `done`
 * (gửi điều chỉnh là việc của `InvoiceAdjustmentService`, `kickAdjust` sau commit). Phần ghi kết quả
 * STM-7 dùng chung với điều chỉnh nằm ở `e-invoice-rows.ts`.
 *
 * Ba việc:
 *   1. `requestForTopUp(c, topUpId)`: tạo dòng `e_invoices` `requested` **trong transaction cộng tiền**
 *      của bên gọi (Khang chốt 17/11, thay "sau commit" của SD-2b): sập giữa commit và việc sau
 *      commit thì hoá đơn vẫn nằm trong DB và vòng quét bắt lại (D7: DB là nguồn sự thật). Không tự
 *      BEGIN/COMMIT. `ON CONFLICT (top_up_id) DO NOTHING`: một hoá đơn mỗi top-up.
 *   2. Việc nền `e-invoice-issue` (`BackgroundWork`, lease D7): tx1 giữ chỗ một dòng `requested` /
 *      `failed` đến hạn → gọi nhà cung cấp NGOÀI transaction (timeout 10 s) → tx2 `lockLeased`
 *      (`null` = mất lease, bỏ kết quả) → STM-7 → ghi một câu UPDATE. Dòng `failed` qua `RETRY_DUE`
 *      (#6) ở tx2 rồi mới áp kết quả (tx1 là `claimDue` dùng chung, không đổi trạng thái).
 *   3. `adminRetry(invoiceId, adminId)`: `needs_review → requested` (#7), không reset bộ đếm. Route
 *      ở Phần 10.
 *
 * Số tiền: `amount_vnd` = `top_ups.amount_paid_vnd` (số thực thu, ĐÃ GỒM VAT; phần giảm bằng điểm
 * không lên hoá đơn, BR-P04); thuế suất theo thời điểm thu tiền (`completed_at`, `vatRateAt`), lưu
 * `vat_rate` (0025). Lượt gọi nhà cung cấp gửi đúng số đã lưu trên dòng, không tính lại.
 *
 * Top-up luôn giữ `credited` dù hoá đơn ra sao (D5). Gửi hoá đơn cho tài xế (STM-7 #2 "/ send
 * invoice to Driver"): chưa có kênh, không làm. Báo Admin = log error `e_invoice_needs_review` + màn
 * Billing Exceptions đọc bảng (Phần 10).
 *
 * Hết lượt giữ chỗ (T32 Phần 8c, D7): dòng bị giữ chỗ quá `UNFINISHED_CLAIM_LIMIT` lần liên tiếp mà
 * không ra kết quả (sập, lỗi lặp ở tx2) → `needs_review` qua STM-7 #3→#5 (`onClaimsExhausted`);
 * Admin retry đặt `unfinished_claims = 0`.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { BackgroundWork, BackgroundWorkRunner } from './background-work.js';
import { BACKGROUND_WORK_CONFIG, BackgroundWorkConfig } from './background-work.config.js';
import { EInvoiceNotFound } from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import { LeasedRow, lockLeased, runLeasedBatch } from './due-rows.js';
import {
  callProvider,
  E_INVOICE_DESCRIPTION,
  E_INVOICE_PROVIDER,
  E_INVOICE_PROVIDER_TIMEOUT,
  EINVOICE_PROVIDER_TIMEOUT_MS,
  EInvoiceProviderAdapter,
  EInvoiceResult,
} from './e-invoice-provider.js';
import {
  adminRetryIssueRow,
  applyIssueOutcome,
  E_INVOICE_ISSUE_WORK,
  exhaustIssueRow,
  INVOICE_ADJUSTMENT_ISSUE_WORK,
  IssueLog,
} from './e-invoice-rows.js';
import { EInvoiceStateMachine, EInvoiceStatus } from './e-invoice-state-machine.js';
import { splitVat, vatRateAt } from './e-invoice.js';

// Hằng chuyển sang e-invoice-rows.ts (T32 Phần 9b); export lại để nơi đang import từ đây giữ nguyên.
export { E_INVOICE_ISSUE_WORK, LAST_ERROR_MESSAGE_MAX } from './e-invoice-rows.js';

/** Kết quả `adminRetry`. */
export interface AdminRetryResult {
  eInvoiceId: number;
  status: EInvoiceStatus;
  attemptCount: number;
}

type IssueRow = {
  id: string;
  top_up_id: string;
  amount_vnd: string;
  vat_rate: number;
  vat_amount_vnd: string;
  paid_at: Date;
};

type LockedInvoice = {
  id: string;
  top_up_id: string;
  status: EInvoiceStatus;
  attempt_count: number;
};

@Injectable()
export class EInvoiceService implements BackgroundWork, OnModuleInit {
  readonly name = E_INVOICE_ISSUE_WORK;
  private readonly stm = new EInvoiceStateMachine();
  private readonly logger = new Logger(EInvoiceService.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(E_INVOICE_PROVIDER) private readonly provider: EInvoiceProviderAdapter,
    @Optional() private readonly runner?: BackgroundWorkRunner,
    @Optional()
    @Inject(BACKGROUND_WORK_CONFIG)
    private readonly workConfig?: BackgroundWorkConfig,
    // Chỉ để test đặt timeout nhỏ; mặc định 10 s (D5).
    @Optional() @Inject(E_INVOICE_PROVIDER_TIMEOUT) timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? EINVOICE_PROVIDER_TIMEOUT_MS;
  }

  /** Luôn đăng ký, kể cả khi `BILLING_WORKER_ENABLED=false` (billing/CLAUDE.md). */
  onModuleInit(): void {
    this.runner?.register(this);
  }

  /**
   * SD-2b / STM-7 #1: tạo hoá đơn `requested` cho top-up vừa `credited`, trong transaction của bên
   * gọi (nhánh `credited` của `TopUpService.applyLockedResult`, sau `credit()` và bước điểm; bên gọi
   * đã khoá `top_ups`). Không tự BEGIN/COMMIT. Gọi lại cho cùng top-up → không thêm dòng.
   *
   * @throws Error('e_invoice_top_up_not_credited') nếu top-up chưa `credited` / thiếu `completed_at`
   *   (lỗi lập trình: chỉ gọi ngay sau `credit()`); lỗi DB làm rollback cả giao dịch như mọi lỗi DB.
   */
  async requestForTopUp(
    c: LedgerClient,
    topUpId: number,
  ): Promise<{ id: number; created: boolean }> {
    const top = (
      await c.query<{ amount_paid_vnd: string; completed_at: Date | null }>(
        `SELECT amount_paid_vnd, completed_at FROM top_ups WHERE id = $1 AND status = 'credited'`,
        [topUpId],
      )
    ).rows[0];
    if (!top || top.completed_at === null)
      throw new Error(`e_invoice_top_up_not_credited: ${topUpId}`);
    const amountVnd = Number(top.amount_paid_vnd);
    // Thuế suất theo thời điểm thu tiền (completed_at, cùng transaction), không theo lúc gọi nhà cung cấp.
    const vatRate = vatRateAt(top.completed_at);
    const inserted = (
      await c.query<{ id: string }>(
        `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_rate, vat_amount_vnd)
         VALUES ($1, $2::e_invoice_status, $3, $4, $5)
         ON CONFLICT (top_up_id) DO NOTHING
         RETURNING id`,
        [topUpId, this.stm.initial(), amountVnd, vatRate, splitVat(amountVnd, vatRate)],
      )
    ).rows[0];
    if (inserted) return { id: Number(inserted.id), created: true };
    const prev = (
      await c.query<{ id: string }>('SELECT id FROM e_invoices WHERE top_up_id = $1', [topUpId])
    ).rows[0]!;
    return { id: Number(prev.id), created: false };
  }

  /** Chạy sớm việc xuất hoá đơn (gọi SAU commit). Không có runner (test dựng tay) → bỏ qua. */
  kickIssue(): void {
    this.runner?.kick(this.name);
  }

  /**
   * SD-2e / D5 (T32 Phần 9b): tạo điều chỉnh giảm `requested` cho refund vừa `done`, trong
   * transaction Admin ghi nhận hoàn (`RefundService.confirmDone`, hoàn thủ công D1), giống `requestForTopUp`
   * trong transaction cộng tiền: sập sau commit không làm mất điều chỉnh. Không tự BEGIN/COMMIT.
   *
   * - `late_payment` → `skipped` (khoản trễ không có hoá đơn gốc, D5);
   * - không có hoá đơn gốc (dữ liệu cũ / ghi ngoài API) → `skipped: 'no_original'`, bên gọi log warn;
   * - có → khoá hoá đơn gốc `FOR UPDATE` (hai refund cùng hoá đơn done đồng thời: refund sau chờ, câu
   *   `MAX` chạy sau khi có khoá nên thấy dòng đã commit → số kế tiếp, không vướng UNIQUE), rồi INSERT
   *   `amount_vnd = −refunds.amount_vnd`, `adjustment_no = max + 1`. `ON CONFLICT (refund_id) DO
   *   NOTHING`: một điều chỉnh mỗi refund.
   *
   * Thứ tự khoá (billing/CLAUDE.md): bên gọi đã khoá [`top_ups` | `credit_accounts`] → `refunds`;
   * ở đây khoá `e_invoices` sau cùng. Không kiểm trần / trạng thái hoá đơn gốc ở đây (kiểm lúc gửi):
   * refund Admin đã ghi nhận không bao giờ rollback vì hoá đơn.
   *
   * @throws Error('invoice_adjustment_refund_not_done') chỉ cho lỗi lập trình (refund chưa `done`);
   *   mọi ca dữ liệu trả `skipped`, không ném (ném làm refund không chuyển được sang done).
   */
  async adjustForRefund(
    c: LedgerClient,
    refundId: number,
  ): Promise<
    | { id: number; created: boolean }
    | { skipped: 'late_payment' | 'no_original' | 'refund_not_found' }
  > {
    const refund = (
      await c.query<{ kind: string; amount_vnd: string; status: string; top_up_id: string }>(
        'SELECT kind, amount_vnd, status, top_up_id FROM refunds WHERE id = $1',
        [refundId],
      )
    ).rows[0];
    if (!refund) return { skipped: 'refund_not_found' };
    if (refund.status !== 'done')
      throw new Error(`invoice_adjustment_refund_not_done: ${refundId}`);
    if (refund.kind === 'late_payment') return { skipped: 'late_payment' };
    const original = (
      await c.query<{ id: string }>('SELECT id FROM e_invoices WHERE top_up_id = $1 FOR UPDATE', [
        refund.top_up_id,
      ])
    ).rows[0];
    if (!original) return { skipped: 'no_original' };
    const inserted = (
      await c.query<{ id: string }>(
        `INSERT INTO invoice_adjustments (e_invoice_id, adjustment_no, reason, amount_vnd, refund_id,
           status)
         SELECT $1, COALESCE(MAX(adjustment_no), 0) + 1, $2, $3, $4, $5::e_invoice_status
         FROM invoice_adjustments WHERE e_invoice_id = $1
         ON CONFLICT (refund_id) DO NOTHING
         RETURNING id`,
        [
          original.id,
          `Điều chỉnh giảm do hoàn tiền (refund ${refundId})`,
          -Number(refund.amount_vnd),
          refundId,
          this.stm.initial(),
        ],
      )
    ).rows[0];
    if (inserted) return { id: Number(inserted.id), created: true };
    const prev = (
      await c.query<{ id: string }>('SELECT id FROM invoice_adjustments WHERE refund_id = $1', [
        refundId,
      ])
    ).rows[0]!;
    return { id: Number(prev.id), created: false };
  }

  /**
   * Chạy sớm việc gửi điều chỉnh (gọi SAU commit; T32 Phần 9b). Worker là `InvoiceAdjustmentService`,
   * cùng BillingModule. Không có runner (test dựng tay) → bỏ qua.
   */
  kickAdjust(): void {
    this.runner?.kick(INVOICE_ADJUSTMENT_ISSUE_WORK);
  }

  /**
   * Vòng quét (D7): `status IN ('requested','failed') AND next_attempt_at <= now()`, giữ chỗ từng dòng
   * bằng `runLeasedBatch` rồi `issue`.
   */
  async runDue(limit: number, signal: AbortSignal): Promise<number> {
    if (!this.workConfig) throw new Error('e_invoice_issue_missing_config');
    return runLeasedBatch(
      this.db.$client,
      {
        table: 'e_invoices',
        statuses: ['requested', 'failed'],
        leaseMs: this.workConfig.leaseMs,
        limit,
        onExhausted: (locked, c) => this.onClaimsExhausted(c, locked as LockedInvoice),
      },
      (row) => this.issue(row, signal),
      signal,
      this.logger,
    );
  }

  /**
   * SD-2c `issue` cho MỘT dòng đã giữ chỗ (tx1 của `runLeasedBatch`): gọi nhà cung cấp ngoài
   * transaction → tx2 `lockLeased` → STM-7 → ghi.
   */
  async issue(row: LeasedRow, signal?: AbortSignal): Promise<void> {
    const inv = (
      await this.db.$client.query<IssueRow>(
        `SELECT e.id, e.top_up_id, e.amount_vnd, e.vat_rate, e.vat_amount_vnd,
                COALESCE(t.completed_at, e.created_at) AS paid_at
         FROM e_invoices e JOIN top_ups t ON t.id = e.top_up_id
         WHERE e.id = $1`,
        [row.id],
      )
    ).rows[0];
    if (!inv) return;
    // Gửi đúng số đã lưu trên dòng (thuế suất chốt lúc thu tiền), không tính lại lúc gọi.
    const result = await callProvider(
      this.provider,
      {
        idempotencyKey: inv.id,
        description: E_INVOICE_DESCRIPTION,
        amountVnd: Number(inv.amount_vnd),
        vatRate: Number(inv.vat_rate),
        vatAmountVnd: Number(inv.vat_amount_vnd),
        paidAt: inv.paid_at,
      },
      signal,
      this.timeoutMs,
    );
    // Đang shutdown: không ghi gì; hết lease dòng tự đến hạn lại, lượt sau gọi lại cùng khoá.
    if (signal?.aborted) return;

    const log = await this.transaction(async (c) => {
      const locked = await lockLeased<LockedInvoice>(c, 'e_invoices', row);
      if (!locked) {
        return {
          level: 'log',
          event: 'e_invoice_lease_lost',
          fields: { e_invoice_id: row.id, kind: result.kind },
        } as IssueLog;
      }
      return this.applyResult(c, locked, result);
    });
    this.logger[log.level](JSON.stringify({ event: log.event, ...log.fields }));
  }

  /**
   * Admin retry (STM-7 #7; route, phân quyền ở Phần 10): chỉ `needs_review` → `requested`, đến hạn
   * ngay, GIỮ `attempt_count` (một lượt; lỗi tạm thời khi bộ đếm đã ≥ RETRY_LIMIT → lại
   * `needs_review`). Repo chưa có bảng audit: `adminId` ghi vào log `e_invoice_admin_retry`.
   *
   * @throws EInvoiceNotFound — không có hoá đơn (→ 404)
   * @throws InvalidTransition('STM-7', from, 'ADMIN_RETRY') — trạng thái khác `needs_review` (→ 409)
   */
  async adminRetry(invoiceId: number, adminId: number): Promise<AdminRetryResult> {
    const out = await this.transaction(async (c) => {
      const inv = (
        await c.query<LockedInvoice>(
          'SELECT id, top_up_id, status, attempt_count FROM e_invoices WHERE id = $1 FOR UPDATE',
          [invoiceId],
        )
      ).rows[0];
      if (!inv) throw new EInvoiceNotFound(invoiceId);
      const to = await adminRetryIssueRow(c, 'e_invoices', inv);
      return {
        eInvoiceId: invoiceId,
        topUpId: Number(inv.top_up_id),
        status: to,
        attemptCount: Number(inv.attempt_count),
      };
    });
    this.logger.log(
      JSON.stringify({
        event: 'e_invoice_admin_retry',
        e_invoice_id: out.eInvoiceId,
        top_up_id: out.topUpId,
        admin_id: adminId,
        attempt_count: out.attemptCount,
      }),
    );
    try {
      this.kickIssue();
    } catch (error) {
      // Đã commit: chạy sớm chỉ là tối ưu, vòng quét vẫn bắt dòng đến hạn.
      this.logger.error(
        JSON.stringify({
          event: 'e_invoice_admin_retry_kick_failed',
          e_invoice_id: out.eInvoiceId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return { eInvoiceId: out.eInvoiceId, status: out.status, attemptCount: out.attemptCount };
  }

  /**
   * Hết lượt giữ chỗ (T32 Phần 8c, D7): chạy trong tx riêng của `runLeasedBatch`, dòng đã khoá bằng
   * lease, KHÔNG gọi nhà cung cấp. Chỉ dùng chuyển trạng thái có sẵn của STM-7: `failed` qua #6
   * trước, rồi `ATTEMPT_FAILED` → #3→#5 `needs_review`. Guard và `attempt_count` ghi vào dòng là
   * `max(attempt_count + 1, RETRY_LIMIT)` (Khang chốt 19/11): guard #5 "lượt thứ RETRY_LIMIT trở đi"
   * giữ đúng nghĩa, và Admin retry (#7) vẫn là "một lượt". Đổi lại `attempt_count` có thể lớn hơn
   * số lần gọi thật. Log sau commit.
   */
  private async onClaimsExhausted(
    c: LedgerClient,
    locked: LockedInvoice & { unfinished_claims?: number },
  ): Promise<() => Promise<void>> {
    const log = await exhaustIssueRow(c, 'e_invoices', {
      ...locked,
      parentId: Number(locked.top_up_id),
    });
    return async () => {
      this.logger[log.level](JSON.stringify({ event: log.event, ...log.fields }));
    };
  }

  /** tx2: áp kết quả một lượt gọi lên dòng đã khoá theo lease, ghi MỘT câu UPDATE. */
  private applyResult(
    c: LedgerClient,
    locked: LockedInvoice,
    result: EInvoiceResult,
  ): Promise<IssueLog> {
    return applyIssueOutcome(
      c,
      'e_invoices',
      { ...locked, parentId: Number(locked.top_up_id) },
      result.kind === 'issued' ? { kind: 'issued', no: result.invoiceNo } : result,
    );
  }

  private async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.$client.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
