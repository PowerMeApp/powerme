/**
 * Billing Exceptions (UC-ADM-08, screens 32 / 33, FE-09) — types only, snake_case as on the wire.
 * Source: Khang's PR #212 (T32 Phần 10a, WF-02 D10): apps/csms/src/billing/billing-exceptions.query.ts
 * and apps/csms/src/operator-api/admin-billing.ts. Manual refund routes (D-AC, BR-P51): Khang's #257
 * (OpenAPI 0.3.0 `RefundRequested`, `RefundQueue`, `RefundConfirmed`, `RefundFailed`, `RefundRedone`).
 */

export interface ExceptionDriver {
  driver_id: string;
  full_name: string;
  phone_number: string | null;
}

export interface BillingSection<T> {
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
  last_error_kind: 'transient' | 'data' | null;
  last_error_message: string | null;
  updated_at: string;
  driver: ExceptionDriver;
}

export type TopUpExceptionKind = 'unresolved_04' | 'unresolved_07' | 'loyalty_error';

export interface TopUpExceptionItem {
  top_up_id: string;
  gateway_reference: string;
  status: string;
  exception_kind: TopUpExceptionKind;
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

/** GET /api/admin/v1/billing/exceptions — no paging: each section ≤ `limit` rows, newest first. */
export interface BillingExceptions {
  generated_at: string;
  limit: number;
  late_payments: BillingSection<LatePaymentItem>;
  invoices_needs_review: BillingSection<InvoiceNeedsReviewItem>;
  top_up_exceptions: BillingSection<TopUpExceptionItem>;
  payment_conflicts: BillingSection<PaymentConflictItem>;
}

/** POST /billing/e-invoices/{id}/retry → 202 */
export interface InvoiceRetryResult {
  e_invoice_id: string;
  status: string;
  attempt_count: number;
}

/** POST /billing/top-ups/{id}/recheck → 200 */
export interface RecheckResult {
  top_up_id: string;
  result:
    | 'late_payment_recorded'
    | 'already_recorded'
    | 'conflicting_result'
    | 'not_paid'
    | 'still_unresolved';
  reason?: string;
  retry_after_minutes?: number;
  hint?: string;
}

export type RefundKind = 'top_up' | 'late_payment' | 'account_closure';
export type RefundQueueStatus = 'requested' | 'failed';

/** POST /billing/top-ups/{id}/refund and …/late-refund → 202 */
export interface RefundRequested {
  refund_id: string;
  status: 'requested';
  /** What customer service refunds in the VNPay merchant portal. */
  amount_vnd: number;
}

export interface RefundQueueItem {
  refund_id: string;
  kind: RefundKind;
  top_up_id: string;
  amount_vnd: number;
  status: RefundQueueStatus;
  /** Admin who asked; null = the system (account closure). */
  requested_by: string | null;
  created_at: string;
  updated_at: string;
  /** Reason of the last failure (kept after a redo). */
  failure_reason: string | null;
  /** `vnp_TxnRef` of the original top-up. */
  gateway_reference: string;
  /** VNPay transaction to refund (original, or the late payment's). */
  gateway_transaction_no: string | null;
  paid_at: string | null;
  driver: ExceptionDriver;
}

/** GET /billing/refunds — customer-service work list, oldest first, ≤ `limit` rows. */
export interface RefundQueue {
  generated_at: string;
  limit: number;
  total: number;
  items: RefundQueueItem[];
}

/** POST /billing/refunds/{id}/confirm → 200 */
export interface RefundConfirmed {
  refund_id: string;
  status: 'done';
  gateway_refund_no: string;
  completed_at: string;
  already_done: boolean;
}

/** POST /billing/refunds/{id}/fail → 200 */
export interface RefundFailed {
  refund_id: string;
  status: 'failed';
  failure_reason: string;
}

/** POST /billing/refunds/{id}/redo → 200 */
export interface RefundRedone {
  refund_id: string;
  status: 'requested';
}
