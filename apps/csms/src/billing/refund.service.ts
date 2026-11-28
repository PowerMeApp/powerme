/**
 * RefundService — hoàn tiền thủ công (D-AC, SRS BR-P51; SD-2e v3.0, STM-10 v2.0, CD-2 v3.0, decisions D1).
 *
 * CSKH hoàn trên cổng merchant VNPay (ngoài PowerMe); Admin ghi nhận kết quả ở đây:
 * - `create`: refund `requested`, trong transaction quyết định hoàn của bên gọi (TopUpService, Phần 11);
 * - `confirmDone`: `requested → done` khi Admin nhập mã hoàn của cổng (UNIQUE), kích hoạt hoá đơn
 *   điều chỉnh cùng transaction (Phần 9b, D5);
 * - `markFailed`: `requested → failed` kèm lý do (cổng từ chối);
 * - `redo`: `failed → requested`.
 * PowerMe không gọi VNPay refund, không querydr refund, không retry tự động, không worker refund.
 *
 * Thứ tự khoá của `confirmDone` (billing/CLAUDE.md): [`top_ups` (`late_payment`) | `credit_accounts`
 * (`account_closure`)] → `refunds` → `e_invoices` gốc (`adjustForRefund`). Khoá bảng cha TRƯỚC
 * `refunds`: `refundLatePayment` giữ `top_ups` rồi INSERT `refunds`, đóng tài khoản giữ
 * `credit_accounts` rồi INSERT `refunds`; ngược thứ tự sẽ deadlock. Khoá `credit_accounts` cũng làm
 * tuần tự việc kiểm "refund closure cuối cùng".
 *
 * Chưa có bảng audit: mỗi hành động Admin ghi một log có cấu trúc kèm `admin_id`. MSG25 (báo tài xế
 * khi done) chưa có kênh, chưa làm.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { RefundNoUsed, RefundNotFound } from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import { EInvoiceService } from './e-invoice.service.js';
import { RefundStateMachine, RefundStatus } from './refund-state-machine.js';

export type RefundKind = 'top_up' | 'late_payment' | 'account_closure';

/** `refunds.gateway_refund_no` là varchar(20). */
export const GATEWAY_REFUND_NO_MAX = 20;
/** CHECK `refunds_failure_reason_length_check` (0032). */
export const FAILURE_REASON_MAX = 1000;

const GATEWAY_REFUND_NO = /^[A-Za-z0-9._/-]+$/;

/**
 * Mã hoàn Admin nhập: trim, 1–20 ký tự, chỉ chữ / số ASCII và `.` `_` `/` `-`. Lưu đúng như nhập
 * (không đổi hoa / thường). `null` = sai dạng. Định dạng thật của cổng chưa kiểm (D1 "Còn mở").
 */
export function parseGatewayRefundNo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length <= GATEWAY_REFUND_NO_MAX && GATEWAY_REFUND_NO.test(v) ? v : null;
}

/** Lý do thất bại: trim, 1–1000 ký tự. `null` = sai dạng. */
export function parseFailureReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= 1 && v.length <= FAILURE_REASON_MAX ? v : null;
}

export interface CreateRefundInput {
  topUpId: number;
  kind: RefundKind;
  amountVnd: number;
  /** `admins.user_id`; NULL chỉ cho `account_closure` (CHECK của 0015). */
  requestedBy: number | null;
}

export interface RefundConfirmed {
  refundId: number;
  status: 'done';
  gatewayRefundNo: string;
  completedAt: Date;
  /** true = refund đã `done` bằng đúng mã này từ trước: không ghi gì thêm. */
  alreadyDone: boolean;
}

export interface RefundMarkedFailed {
  refundId: number;
  status: 'failed';
  failureReason: string;
}

export interface RefundRedone {
  refundId: number;
  status: 'requested';
}

type RefundLog = {
  level: 'log' | 'warn' | 'error';
  event: string;
  fields: Record<string, unknown>;
};

type LockedRefund = {
  id: string;
  status: RefundStatus;
  kind: RefundKind;
  top_up_id: string;
  gateway_refund_no: string | null;
  completed_at: Date | null;
};

/** Phần cần sau commit của `confirmDone`. */
type ConfirmOutcome = {
  result: RefundConfirmed;
  kind: RefundKind;
  topUpId: number;
  after: RefundLog[];
  kickAdjust: boolean;
};

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string } | null;
  return e && e.code === '23505' ? (e.constraint ?? '') : null;
}

@Injectable()
export class RefundService {
  private readonly stm = new RefundStateMachine();
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    // Phần 9b. Tuỳ chọn để test dựng service không cần hoá đơn; BillingModule luôn tiêm (có test).
    // Thiếu mà refund `top_up` / `account_closure` done → log error `invoice_adjustment_service_missing`.
    @Optional() private readonly eInvoices?: EInvoiceService,
  ) {}

  /** STM-10 #1: tạo refund `requested` trong transaction quyết định hoàn của bên gọi. */
  async create(c: LedgerClient, input: CreateRefundInput): Promise<number> {
    const row = (
      await c.query<{ id: string }>(
        `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, requested_by)
         VALUES ($1, $2::refund_kind, $3, $4::refund_status, $5) RETURNING id`,
        [input.topUpId, input.kind, input.amountVnd, this.stm.initial(), input.requestedBy],
      )
    ).rows[0]!;
    return Number(row.id);
  }

  /**
   * STM-10 #2 (SD-2e phần 3): Admin nhập mã hoàn của cổng → `done`, `completed_at = now()`; cùng
   * transaction ghi `late_refunded_at` (late_payment) / `closure_refunded_at` (refund closure cuối
   * cùng) và tạo hoá đơn điều chỉnh (`top_up` / `account_closure`). Sau commit chỉ `kickAdjust`.
   *
   * Gọi lại với đúng mã trên refund đã `done` bằng mã đó → trả kết quả cũ (`alreadyDone`), không ghi.
   *
   * @throws RefundNotFound — không có refund
   * @throws RefundNoUsed — mã đã ghi cho refund khác
   * @throws InvalidTransition('STM-10', from, 'ADMIN_CONFIRMED') — `failed`, hoặc `done` bằng mã khác
   * @throws Error('refund_invalid_gateway_refund_no') — mã sai dạng (route phải kiểm trước)
   */
  async confirmDone(
    refundId: number,
    gatewayRefundNo: string,
    adminId: number,
  ): Promise<RefundConfirmed> {
    const refundNo = parseGatewayRefundNo(gatewayRefundNo);
    if (refundNo === null) throw new Error('refund_invalid_gateway_refund_no');
    let out: ConfirmOutcome;
    try {
      out = await this.transaction((c) => this.confirmLocked(c, refundId, refundNo));
    } catch (error) {
      // Hai refund khác nhau cùng mã ghi đồng thời: kiểm trước trong tx không thấy nhau.
      if (uniqueViolation(error) === 'refunds_gateway_refund_no_key')
        throw new RefundNoUsed(refundNo);
      throw error;
    }
    const base = {
      refund_id: refundId,
      top_up_id: out.topUpId,
      kind: out.kind,
      admin_id: adminId,
      gateway_refund_no: refundNo,
    };
    if (out.result.alreadyDone) {
      this.log('log', 'refund_confirm_repeated', base);
      return out.result;
    }
    this.log('log', 'refund_confirmed', base);
    for (const extra of out.after) this.log(extra.level, extra.event, extra.fields);
    if (out.kickAdjust) {
      try {
        this.eInvoices?.kickAdjust();
      } catch (error) {
        // Đã commit: chạy sớm chỉ là tối ưu, vòng quét vẫn bắt điều chỉnh đến hạn.
        this.log('error', 'invoice_adjustment_kick_failed', {
          refund_id: refundId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out.result;
  }

  /**
   * STM-10 #3: cổng từ chối → `failed`, ghi `failure_reason`. Tiền ở lại với yêu cầu hoàn, không
   * trả lại ví (STM-10 ghi chú).
   *
   * @throws RefundNotFound — không có refund
   * @throws InvalidTransition('STM-10', from, 'ADMIN_MARKED_FAILED') — không ở `requested`
   * @throws Error('refund_invalid_failure_reason') — lý do sai dạng (route phải kiểm trước)
   */
  async markFailed(refundId: number, reason: string, adminId: number): Promise<RefundMarkedFailed> {
    const failureReason = parseFailureReason(reason);
    if (failureReason === null) throw new Error('refund_invalid_failure_reason');
    const row = await this.transaction(async (c) => {
      const locked = await this.lockRefund(c, refundId);
      const step = this.stm.apply(locked.status, 'ADMIN_MARKED_FAILED');
      await c.query(
        `UPDATE refunds SET status = $2::refund_status, failure_reason = $3, updated_at = now()
         WHERE id = $1`,
        [refundId, step.to, failureReason],
      );
      return locked;
    });
    this.log('log', 'refund_marked_failed', {
      refund_id: refundId,
      top_up_id: Number(row.top_up_id),
      kind: row.kind,
      admin_id: adminId,
      reason: failureReason,
    });
    return { refundId, status: 'failed', failureReason };
  }

  /**
   * STM-10 #4: Admin làm lại → `requested`, chờ CSKH hoàn lại trên cổng. Giữ `failure_reason` của
   * lần thất bại trước (dấu vết cho CSKH; lần thất bại sau ghi đè).
   *
   * @throws RefundNotFound — không có refund
   * @throws InvalidTransition('STM-10', from, 'ADMIN_REDO') — không ở `failed`
   */
  async redo(refundId: number, adminId: number): Promise<RefundRedone> {
    const row = await this.transaction(async (c) => {
      const locked = await this.lockRefund(c, refundId);
      const step = this.stm.apply(locked.status, 'ADMIN_REDO');
      await c.query(
        `UPDATE refunds SET status = $2::refund_status, updated_at = now() WHERE id = $1`,
        [refundId, step.to],
      );
      return locked;
    });
    this.log('log', 'refund_redo', {
      refund_id: refundId,
      top_up_id: Number(row.top_up_id),
      kind: row.kind,
      admin_id: adminId,
    });
    return { refundId, status: 'requested' };
  }

  private async confirmLocked(
    c: PoolClient,
    refundId: number,
    refundNo: string,
  ): Promise<ConfirmOutcome> {
    // 1. Đọc không khoá: kind / top_up_id / tài khoản không đổi sau khi tạo.
    const head = (
      await c.query<{ kind: RefundKind; top_up_id: string; credit_account_id: string }>(
        `SELECT f.kind, f.top_up_id, t.credit_account_id
         FROM refunds f JOIN top_ups t ON t.id = f.top_up_id WHERE f.id = $1`,
        [refundId],
      )
    ).rows[0];
    if (!head) throw new RefundNotFound(refundId);
    // 2. Bảng cha trước `refunds` (thứ tự khoá ở đầu file).
    if (head.kind === 'late_payment')
      await c.query('SELECT 1 FROM top_ups WHERE id = $1 FOR UPDATE', [head.top_up_id]);
    else if (head.kind === 'account_closure')
      await c.query('SELECT 1 FROM credit_accounts WHERE id = $1 FOR UPDATE', [
        head.credit_account_id,
      ]);
    // 3. Khoá refund, kiểm trạng thái.
    const locked = await this.lockRefund(c, refundId);
    const topUpId = Number(locked.top_up_id);
    if (locked.status === 'done' && locked.gateway_refund_no === refundNo) {
      return {
        result: {
          refundId,
          status: 'done',
          gatewayRefundNo: refundNo,
          completedAt: locked.completed_at!,
          alreadyDone: true,
        },
        kind: locked.kind,
        topUpId,
        after: [],
        kickAdjust: false,
      };
    }
    const step = this.stm.apply(locked.status, 'ADMIN_CONFIRMED');
    // 4. Guard STM-10 "mã chưa ghi lần nào"; ca đua hai refund do UNIQUE bắt (confirmDone).
    const used = await c.query('SELECT 1 FROM refunds WHERE gateway_refund_no = $1 AND id <> $2', [
      refundNo,
      refundId,
    ]);
    if (used.rowCount) throw new RefundNoUsed(refundNo);
    // 5. Ghi done.
    const done = (
      await c.query<{ completed_at: Date }>(
        `UPDATE refunds SET status = $2::refund_status, gateway_refund_no = $3,
           completed_at = now(), updated_at = now()
         WHERE id = $1 RETURNING completed_at`,
        [refundId, step.to, refundNo],
      )
    ).rows[0]!;
    // 6. Mốc trên bảng cha.
    if (locked.kind === 'late_payment')
      await c.query(
        `UPDATE top_ups t SET late_refunded_at = f.completed_at, updated_at = now()
         FROM refunds f WHERE f.id = $1 AND t.id = f.top_up_id`,
        [refundId],
      );
    else if (locked.kind === 'account_closure')
      await c.query(
        `UPDATE credit_accounts a SET closure_refunded_at = now(), updated_at = now()
         WHERE a.id = $1 AND a.status = 'closed' AND a.closure_refunded_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM refunds f JOIN top_ups t ON t.id = f.top_up_id
             WHERE t.credit_account_id = a.id AND f.kind = 'account_closure'
               AND f.status <> 'done')`,
        [head.credit_account_id],
      );
    // 7. Hoá đơn điều chỉnh (khoá `e_invoices` gốc sau `refunds`).
    const adjustment = await this.requestAdjustment(c, refundId, locked.kind, topUpId);
    return {
      result: {
        refundId,
        status: 'done',
        gatewayRefundNo: refundNo,
        completedAt: done.completed_at,
        alreadyDone: false,
      },
      kind: locked.kind,
      topUpId,
      ...adjustment,
    };
  }

  private async lockRefund(c: PoolClient, refundId: number): Promise<LockedRefund> {
    const row = (
      await c.query<LockedRefund>(
        `SELECT id, status, kind, top_up_id, gateway_refund_no, completed_at
         FROM refunds WHERE id = $1 FOR UPDATE`,
        [refundId],
      )
    ).rows[0];
    if (!row) throw new RefundNotFound(refundId);
    return row;
  }

  /**
   * Phần 9b, trong transaction ghi `done`: điều chỉnh hoá đơn cho `top_up` / `account_closure`
   * (`late_payment` không có hoá đơn gốc, D5). `adjustForRefund` chỉ ném cho lỗi lập trình; ca dữ liệu
   * trả `skipped` nên refund luôn chuyển được sang `done`. Trả log phụ + cờ kick để ghi sau commit.
   */
  private async requestAdjustment(
    c: PoolClient,
    refundId: number,
    kind: RefundKind,
    topUpId: number,
  ): Promise<{ after: RefundLog[]; kickAdjust: boolean }> {
    if (kind !== 'top_up' && kind !== 'account_closure') return { after: [], kickAdjust: false };
    const fields = { refund_id: refundId, top_up_id: topUpId, kind };
    if (!this.eInvoices) {
      return {
        after: [{ level: 'error', event: 'invoice_adjustment_service_missing', fields }],
        kickAdjust: false,
      };
    }
    const adj = await this.eInvoices.adjustForRefund(c, refundId);
    if ('skipped' in adj) {
      return {
        after: [{ level: 'warn', event: `invoice_adjustment_${adj.skipped}`, fields }],
        kickAdjust: false,
      };
    }
    if (!adj.created) return { after: [], kickAdjust: false };
    return {
      after: [
        {
          level: 'log',
          event: 'invoice_adjustment_requested',
          fields: { ...fields, invoice_adjustment_id: adj.id },
        },
      ],
      kickAdjust: true,
    };
  }

  private log(level: 'log' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
    this.logger[level](JSON.stringify({ event, ...fields }));
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
