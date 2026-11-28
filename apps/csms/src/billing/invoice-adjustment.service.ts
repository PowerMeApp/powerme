/**
 * InvoiceAdjustmentService — gửi hoá đơn điều chỉnh giảm khi hoàn tiền (T32 Phần 9b; SD-2e, STM-7,
 * decisions D5 / D7).
 *
 * Dòng `invoice_adjustments` được `EInvoiceService.adjustForRefund` tạo trong tx2 của refund `done`.
 * Service này lo phần còn lại:
 *   1. Việc nền `invoice-adjustment-issue` (`BackgroundWork`, lease D7), cùng mẫu `e-invoice-issue`:
 *      tx1 giữ chỗ một dòng `requested` / `failed` đến hạn → kiểm trước khi gửi → gọi nhà cung cấp
 *      NGOÀI transaction (timeout 10 s) → tx2 `lockLeased` (`null` = mất lease, bỏ kết quả) → STM-7
 *      (hàm dùng chung `e-invoice-rows.ts`) → ghi.
 *   2. `adminRetryAdjustment(adjustmentId, adminId)`: `needs_review → requested` (#7). Route ở 10b.
 *
 * Kiểm trước khi gửi (`checkAdjustmentSendable`, không gọi nhà cung cấp nếu lỗi; lỗi tính là một
 * lượt như lỗi của nhà cung cấp):
 *   - tổng điều chỉnh vượt hoá đơn gốc → `data` `adjustment_exceeds_original` → `needs_review`;
 *   - hoá đơn gốc chưa `issued` → `transient` `original_not_issued` → theo lịch retry, hết lượt →
 *     `needs_review` (Khang chốt 25/11: phát hành gốc rồi điều chỉnh, không huỷ gốc; Admin xử lý hoá
 *     đơn gốc trước rồi retry điều chỉnh).
 *
 * Thuế: `vatRate` của hoá đơn gốc, `vatAmountVnd = adjustmentVat(amount_vnd, vat_rate)`, tính lúc gửi
 * (không thêm cột). Gửi điều chỉnh cho tài xế (MSG25): chưa có kênh, không làm.
 *
 * Vì sao là service riêng (không nằm trong `EInvoiceService`): mỗi `BackgroundWork` có một `name`;
 * `EInvoiceService` đã là `e-invoice-issue`.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { BackgroundWork, BackgroundWorkRunner } from './background-work.js';
import { BACKGROUND_WORK_CONFIG, BackgroundWorkConfig } from './background-work.config.js';
import { InvoiceAdjustmentNotFound } from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import { LeasedRow, lockLeased, runLeasedBatch } from './due-rows.js';
import {
  callAdjustProvider,
  E_INVOICE_PROVIDER,
  E_INVOICE_PROVIDER_TIMEOUT,
  EINVOICE_PROVIDER_TIMEOUT_MS,
  EInvoiceProviderAdapter,
} from './e-invoice-provider.js';
import {
  adminRetryIssueRow,
  applyIssueOutcome,
  exhaustIssueRow,
  INVOICE_ADJUSTMENT_ISSUE_WORK,
  IssueLog,
  IssueOutcome,
} from './e-invoice-rows.js';
import type { EInvoiceStatus } from './e-invoice-state-machine.js';
import { adjustmentVat, checkAdjustmentSendable } from './e-invoice.js';

/** Kết quả `adminRetryAdjustment`. */
export interface AdjustmentRetryResult {
  invoiceAdjustmentId: number;
  status: EInvoiceStatus;
  attemptCount: number;
}

type SendRow = {
  id: string;
  e_invoice_id: string;
  adjustment_no: number;
  reason: string;
  amount_vnd: string;
  original_status: EInvoiceStatus;
  original_invoice_no: string | null;
  original_amount_vnd: string;
  vat_rate: number;
  refunded_at: Date;
  other_abs_vnd: string;
};

type LockedAdjustment = {
  id: string;
  e_invoice_id: string;
  status: EInvoiceStatus;
  attempt_count: number;
  unfinished_claims?: number;
};

@Injectable()
export class InvoiceAdjustmentService implements BackgroundWork, OnModuleInit {
  readonly name = INVOICE_ADJUSTMENT_ISSUE_WORK;
  private readonly logger = new Logger(InvoiceAdjustmentService.name);
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

  /** Chạy sớm việc gửi điều chỉnh (gọi SAU commit). Không có runner → bỏ qua. */
  kickAdjust(): void {
    this.runner?.kick(this.name);
  }

  /**
   * Vòng quét (D7): `status IN ('requested','failed') AND next_attempt_at <= now()` trên
   * `invoice_adjustments`, giữ chỗ từng dòng bằng `runLeasedBatch` rồi `issue`.
   */
  async runDue(limit: number, signal: AbortSignal): Promise<number> {
    if (!this.workConfig) throw new Error('invoice_adjustment_issue_missing_config');
    return runLeasedBatch(
      this.db.$client,
      {
        table: 'invoice_adjustments',
        statuses: ['requested', 'failed'],
        leaseMs: this.workConfig.leaseMs,
        limit,
        onExhausted: (locked, c) => this.onClaimsExhausted(c, locked as LockedAdjustment),
      },
      (row) => this.issue(row, signal),
      signal,
      this.logger,
    );
  }

  /**
   * Một dòng đã giữ chỗ: đọc dòng + hoá đơn gốc + tổng điều chỉnh khác → kiểm → (gọi nhà cung cấp
   * ngoài transaction) → tx2 `lockLeased` → STM-7 → ghi.
   */
  async issue(row: LeasedRow, signal?: AbortSignal): Promise<void> {
    const adj = (
      await this.db.$client.query<SendRow>(
        `SELECT a.id, a.e_invoice_id, a.adjustment_no, a.reason, a.amount_vnd,
                e.status AS original_status, e.invoice_no AS original_invoice_no,
                e.amount_vnd AS original_amount_vnd, e.vat_rate,
                COALESCE(f.completed_at, a.created_at) AS refunded_at,
                (SELECT COALESCE(SUM(abs(o.amount_vnd)), 0) FROM invoice_adjustments o
                 WHERE o.e_invoice_id = a.e_invoice_id AND o.id <> a.id) AS other_abs_vnd
         FROM invoice_adjustments a
         JOIN e_invoices e ON e.id = a.e_invoice_id
         LEFT JOIN refunds f ON f.id = a.refund_id
         WHERE a.id = $1`,
        [row.id],
      )
    ).rows[0];
    if (!adj) return;

    const amountVnd = Number(adj.amount_vnd);
    const vatRate = Number(adj.vat_rate);
    const precheck = checkAdjustmentSendable({
      originalStatus: adj.original_status,
      originalAmountVnd: Number(adj.original_amount_vnd),
      otherAdjustmentsAbsVnd: Number(adj.other_abs_vnd),
      amountVnd,
    });
    let result: IssueOutcome;
    if (precheck) {
      result = precheck;
    } else {
      const r = await callAdjustProvider(
        this.provider,
        {
          idempotencyKey: adj.id,
          originalInvoiceNo: adj.original_invoice_no!,
          adjustmentNo: Number(adj.adjustment_no),
          reason: adj.reason,
          amountVnd,
          vatRate,
          vatAmountVnd: adjustmentVat(amountVnd, vatRate),
          refundedAt: adj.refunded_at,
        },
        signal,
        this.timeoutMs,
      );
      // Đang shutdown: không ghi gì; hết lease dòng tự đến hạn lại, lượt sau gọi lại cùng khoá.
      if (signal?.aborted) return;
      result = r.kind === 'issued' ? { kind: 'issued', no: r.adjustmentNo } : r;
    }

    const log = await this.transaction(async (c) => {
      const locked = await lockLeased<LockedAdjustment>(c, 'invoice_adjustments', row);
      if (!locked) {
        return {
          level: 'log',
          event: 'invoice_adjustment_lease_lost',
          fields: { invoice_adjustment_id: row.id, kind: result.kind },
        } as IssueLog;
      }
      return this.applyResult(c, locked, result);
    });
    this.log(log);
  }

  /**
   * Admin retry (STM-7 #7; route, phân quyền ở 10b): chỉ `needs_review` → `requested`, đến hạn ngay,
   * GIỮ `attempt_count`, `unfinished_claims = 0`. Chưa có bảng audit: `adminId` ghi vào log
   * `invoice_adjustment_admin_retry`. Điều chỉnh chờ hoá đơn gốc thì Admin xử lý hoá đơn gốc trước.
   *
   * @throws InvoiceAdjustmentNotFound — không có điều chỉnh (→ 404)
   * @throws InvalidTransition('STM-7', from, 'ADMIN_RETRY') — trạng thái khác `needs_review` (→ 409)
   */
  async adminRetryAdjustment(
    adjustmentId: number,
    adminId: number,
  ): Promise<AdjustmentRetryResult> {
    const out = await this.transaction(async (c) => {
      const adj = (
        await c.query<LockedAdjustment>(
          `SELECT id, e_invoice_id, status, attempt_count FROM invoice_adjustments
           WHERE id = $1 FOR UPDATE`,
          [adjustmentId],
        )
      ).rows[0];
      if (!adj) throw new InvoiceAdjustmentNotFound(adjustmentId);
      const to = await adminRetryIssueRow(c, 'invoice_adjustments', adj);
      return {
        invoiceAdjustmentId: adjustmentId,
        eInvoiceId: Number(adj.e_invoice_id),
        status: to,
        attemptCount: Number(adj.attempt_count),
      };
    });
    this.log({
      level: 'log',
      event: 'invoice_adjustment_admin_retry',
      fields: {
        invoice_adjustment_id: out.invoiceAdjustmentId,
        e_invoice_id: out.eInvoiceId,
        admin_id: adminId,
        attempt_count: out.attemptCount,
      },
    });
    try {
      this.kickAdjust();
    } catch (error) {
      // Đã commit: chạy sớm chỉ là tối ưu, vòng quét vẫn bắt dòng đến hạn.
      this.log({
        level: 'error',
        event: 'invoice_adjustment_admin_retry_kick_failed',
        fields: {
          invoice_adjustment_id: out.invoiceAdjustmentId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return {
      invoiceAdjustmentId: out.invoiceAdjustmentId,
      status: out.status,
      attemptCount: out.attemptCount,
    };
  }

  /** Hết lượt giữ chỗ (8c, D7): `needs_review` qua STM-7 có sẵn, không gọi nhà cung cấp; log sau commit. */
  private async onClaimsExhausted(
    c: LedgerClient,
    locked: LockedAdjustment,
  ): Promise<() => Promise<void>> {
    const log = await exhaustIssueRow(c, 'invoice_adjustments', {
      ...locked,
      parentId: Number(locked.e_invoice_id),
    });
    return async () => this.log(log);
  }

  /** tx2: áp kết quả một lượt lên dòng đã khoá theo lease (tách riêng để test giả lập lỗi ở tx2). */
  private applyResult(
    c: LedgerClient,
    locked: LockedAdjustment,
    result: IssueOutcome,
  ): Promise<IssueLog> {
    return applyIssueOutcome(
      c,
      'invoice_adjustments',
      { ...locked, parentId: Number(locked.e_invoice_id) },
      result,
    );
  }

  private log(l: IssueLog): void {
    this.logger[l.level](JSON.stringify({ event: l.event, ...l.fields }));
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
