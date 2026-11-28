/**
 * BillingExceptionsQuery — màn Billing Exceptions của Admin, chỉ đọc (T32 Phần 10a; D1, D4, D10;
 * UC-ADM-08). Route: `GET /api/admin/v1/billing/exceptions` (`operator-api/admin-billing.ts`).
 *
 * Bốn mục, mỗi mục mới nhất trước, tối đa `limit` dòng, kèm `total` của cả mục. Bốn câu SELECT chạy
 * trong MỘT transaction `REPEATABLE READ READ ONLY` nên cùng một snapshot (một dòng không hiện ở hai
 * mục do đổi trạng thái giữa hai câu):
 * - `late_payments`: `late_gateway_ref IS NOT NULL` và chưa có dòng `refunds` `late_payment` của
 *   top-up (kể cả dòng đó `failed`), không lọc `status` (D4, STM-4 #8).
 * - `invoices_needs_review`: `e_invoices.status = 'needs_review'`.
 * - `top_up_exceptions`: `exception_kind IS NOT NULL AND exception_reviewed_at IS NULL`.
 * - `payment_conflicts`: `top_up_payment_conflicts.reviewed_at IS NULL` (partial index 0024).
 * Tên lỗi giữ đúng DB (`transient | data`, D10). Không có mục refund trong `list`: hoàn tiền làm thủ
 * công (D1, D-AC / SRS BR-P51), danh sách refund chờ CSKH là `listRefunds` (route
 * `GET /api/admin/v1/billing/refunds`).
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';

/** Mặc định số dòng mỗi mục. */
export const BILLING_EXCEPTIONS_LIMIT = 200;

export interface ExceptionDriver {
  driver_id: string;
  full_name: string;
  phone_number: string | null;
}

export interface Section<T> {
  total: number;
  items: T[];
}

export interface LatePaymentItem {
  top_up_id: string;
  gateway_reference: string;
  status: string;
  late_amount_vnd: number;
  late_gateway_ref: string;
  late_paid_at: string | null;
  driver: ExceptionDriver;
}

export interface InvoiceNeedsReviewItem {
  e_invoice_id: string;
  top_up_id: string;
  amount_vnd: number;
  attempt_count: number;
  last_error_kind: string | null;
  last_error_message: string | null;
  updated_at: string;
  driver: ExceptionDriver;
}

export interface TopUpExceptionItem {
  top_up_id: string;
  gateway_reference: string;
  status: string;
  exception_kind: string;
  amount_paid_vnd: number;
  completed_at: string | null;
  driver: ExceptionDriver;
}

export interface PaymentConflictItem {
  conflict_id: string;
  top_up_id: string;
  gateway_reference: string;
  gateway_transaction_no: string;
  amount_vnd: number;
  paid_at: string;
  source: string;
  reason: string;
  created_at: string;
  driver: ExceptionDriver;
}

/** Refund chờ CSKH (`requested` / `failed`): đủ để tìm giao dịch gốc trên cổng merchant VNPay. */
export interface RefundQueueItem {
  refund_id: string;
  kind: string;
  top_up_id: string;
  amount_vnd: number;
  status: string;
  /** Admin tạo yêu cầu; null = hệ thống (account_closure). */
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  /** Lý do lần thất bại gần nhất (còn giữ sau khi làm lại). */
  failure_reason: string | null;
  /** `vnp_TxnRef` của top-up gốc. */
  gateway_reference: string;
  /** Mã giao dịch VNPay cần hoàn: gốc (`top_up` / `account_closure`) hoặc của khoản trễ. */
  gateway_transaction_no: string | null;
  /** Lúc trả của giao dịch đó (`completed_at` / `late_paid_at`). */
  paid_at: string | null;
  driver: ExceptionDriver;
}

export type RefundQueueStatus = 'requested' | 'failed';

export interface RefundQueue {
  generated_at: string;
  limit: number;
  total: number;
  items: RefundQueueItem[];
}

export interface BillingExceptions {
  generated_at: string;
  limit: number;
  late_payments: Section<LatePaymentItem>;
  invoices_needs_review: Section<InvoiceNeedsReviewItem>;
  top_up_exceptions: Section<TopUpExceptionItem>;
  payment_conflicts: Section<PaymentConflictItem>;
}

type Row = Record<string, unknown> & { total: number };

/** Cột tài xế + JOIN từ `top_ups t`. */
const DRIVER_COLS = `a.driver_id::text AS driver_id, u.full_name, u.phone_number`;
const DRIVER_JOIN = `JOIN credit_accounts a ON a.id = t.credit_account_id
  JOIN users u ON u.id = a.driver_id`;

const iso = (v: unknown) => (v === null ? null : (v as Date).toISOString());
const driver = (r: Row): ExceptionDriver => ({
  driver_id: r['driver_id'] as string,
  full_name: r['full_name'] as string,
  phone_number: (r['phone_number'] as string | null) ?? null,
});

/** Không phải provider Nest: operator-api dựng từ `Db` (như `revenueReport`). */
export class BillingExceptionsQuery {
  constructor(private readonly db: Db) {}

  async list(limit = BILLING_EXCEPTIONS_LIMIT): Promise<BillingExceptions> {
    return this.snapshot(async (c) => {
      const section = async <T>(sql: string, map: (r: Row) => T): Promise<Section<T>> => {
        const { rows } = await c.query<Row>(sql, [limit]);
        // `count(*) OVER()` tính trước LIMIT; mục rỗng thì total 0.
        return { total: rows[0]?.total ?? 0, items: rows.map(map) };
      };
      const generatedAt = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
      return {
        generated_at: generatedAt.toISOString(),
        limit,
        late_payments: await section(
          `SELECT t.id::text AS top_up_id, t.gateway_reference, t.status::text AS status,
             t.late_amount_vnd::text AS late_amount_vnd, t.late_gateway_ref, t.late_paid_at,
             ${DRIVER_COLS}, count(*) OVER()::int AS total
           FROM top_ups t ${DRIVER_JOIN}
           WHERE t.late_gateway_ref IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM refunds f
                             WHERE f.top_up_id = t.id AND f.kind = 'late_payment')
           ORDER BY t.late_paid_at DESC NULLS LAST, t.id DESC LIMIT $1`,
          (r) => ({
            top_up_id: r['top_up_id'] as string,
            gateway_reference: r['gateway_reference'] as string,
            status: r['status'] as string,
            late_amount_vnd: Number(r['late_amount_vnd']),
            late_gateway_ref: r['late_gateway_ref'] as string,
            late_paid_at: iso(r['late_paid_at']),
            driver: driver(r),
          }),
        ),
        invoices_needs_review: await section(
          `SELECT e.id::text AS e_invoice_id, e.top_up_id::text AS top_up_id,
             e.amount_vnd::text AS amount_vnd, e.attempt_count,
             e.last_error_kind::text AS last_error_kind, e.last_error_message, e.updated_at,
             ${DRIVER_COLS}, count(*) OVER()::int AS total
           FROM e_invoices e JOIN top_ups t ON t.id = e.top_up_id ${DRIVER_JOIN}
           WHERE e.status = 'needs_review'
           ORDER BY e.updated_at DESC, e.id DESC LIMIT $1`,
          (r) => ({
            e_invoice_id: r['e_invoice_id'] as string,
            top_up_id: r['top_up_id'] as string,
            amount_vnd: Number(r['amount_vnd']),
            attempt_count: r['attempt_count'] as number,
            last_error_kind: r['last_error_kind'] as string | null,
            last_error_message: r['last_error_message'] as string | null,
            updated_at: iso(r['updated_at'])!,
            driver: driver(r),
          }),
        ),
        top_up_exceptions: await section(
          `SELECT t.id::text AS top_up_id, t.gateway_reference, t.status::text AS status,
             t.exception_kind::text AS exception_kind, t.amount_paid_vnd::text AS amount_paid_vnd,
             t.completed_at, ${DRIVER_COLS}, count(*) OVER()::int AS total
           FROM top_ups t ${DRIVER_JOIN}
           WHERE t.exception_kind IS NOT NULL AND t.exception_reviewed_at IS NULL
           ORDER BY t.completed_at DESC NULLS LAST, t.id DESC LIMIT $1`,
          (r) => ({
            top_up_id: r['top_up_id'] as string,
            gateway_reference: r['gateway_reference'] as string,
            status: r['status'] as string,
            exception_kind: r['exception_kind'] as string,
            amount_paid_vnd: Number(r['amount_paid_vnd']),
            completed_at: iso(r['completed_at']),
            driver: driver(r),
          }),
        ),
        payment_conflicts: await section(
          `SELECT p.id::text AS conflict_id, p.top_up_id::text AS top_up_id, t.gateway_reference,
             p.gateway_transaction_no, p.amount_vnd::text AS amount_vnd, p.paid_at,
             p.source::text AS source, p.reason::text AS reason, p.created_at, ${DRIVER_COLS},
             count(*) OVER()::int AS total
           FROM top_up_payment_conflicts p JOIN top_ups t ON t.id = p.top_up_id ${DRIVER_JOIN}
           WHERE p.reviewed_at IS NULL
           ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
          (r) => ({
            conflict_id: r['conflict_id'] as string,
            top_up_id: r['top_up_id'] as string,
            gateway_reference: r['gateway_reference'] as string,
            gateway_transaction_no: r['gateway_transaction_no'] as string,
            amount_vnd: Number(r['amount_vnd']),
            paid_at: iso(r['paid_at'])!,
            source: r['source'] as string,
            reason: r['reason'] as string,
            created_at: iso(r['created_at'])!,
            driver: driver(r),
          }),
        ),
      };
    });
  }

  /**
   * Danh sách refund chờ CSKH (D1, BR-P51): `status IN (statuses)`, gồm `account_closure`. Cũ nhất
   * trước (CSKH hoàn trong 7 ngày làm việc), tối đa `limit` dòng, `total` là số dòng thật.
   */
  async listRefunds(
    statuses: readonly RefundQueueStatus[],
    limit = BILLING_EXCEPTIONS_LIMIT,
  ): Promise<RefundQueue> {
    return this.snapshot(async (c) => {
      const generatedAt = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
      const { rows } = await c.query<Row>(
        `SELECT f.id::text AS refund_id, f.kind::text AS kind, f.top_up_id::text AS top_up_id,
           f.amount_vnd::text AS amount_vnd, f.status::text AS status,
           f.requested_by::text AS requested_by, f.created_at, f.updated_at, f.failure_reason,
           t.gateway_reference,
           CASE WHEN f.kind = 'late_payment' THEN t.late_gateway_ref
                ELSE t.gateway_transaction_no END AS gateway_transaction_no,
           CASE WHEN f.kind = 'late_payment' THEN t.late_paid_at ELSE t.completed_at END AS paid_at,
           ${DRIVER_COLS}, count(*) OVER()::int AS total
         FROM refunds f JOIN top_ups t ON t.id = f.top_up_id ${DRIVER_JOIN}
         WHERE f.status = ANY($1::refund_status[])
         ORDER BY f.created_at, f.id LIMIT $2`,
        [statuses, limit],
      );
      return {
        generated_at: generatedAt.toISOString(),
        limit,
        total: rows[0]?.total ?? 0,
        items: rows.map((r) => ({
          refund_id: r['refund_id'] as string,
          kind: r['kind'] as string,
          top_up_id: r['top_up_id'] as string,
          amount_vnd: Number(r['amount_vnd']),
          status: r['status'] as string,
          requested_by: (r['requested_by'] as string | null) ?? null,
          created_at: iso(r['created_at'])!,
          updated_at: iso(r['updated_at'])!,
          failure_reason: (r['failure_reason'] as string | null) ?? null,
          gateway_reference: r['gateway_reference'] as string,
          gateway_transaction_no: (r['gateway_transaction_no'] as string | null) ?? null,
          paid_at: iso(r['paid_at']),
          driver: driver(r),
        })),
      };
    });
  }

  private async snapshot<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.$client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
