/**
 * Revenue report (T108, Khang; screens 25 and 35 — FE-07, Nghĩa) — types only, snake_case as on the
 * wire. Source: apps/csms/src/operator-api/revenue-report.ts (#197), contract §4 (BR-P46) and
 * `RevenueReport` in docs/api/operator-admin-api.openapi.yaml.
 */

/** Operator: charge_point | site | day. Admin adds operator. */
export type RevenueGroupBy = 'operator' | 'site' | 'charge_point' | 'day';

/** Counts for one group or for the whole period. Unattributed sessions carry no money (BR-P46). */
export interface RevenueBucket {
  csms_billed_session_count: number;
  csms_billed_energy_wh: number;
  /** Σ session_debit of `csms_billed` + `reconciled` sessions, each session once. */
  csms_billed_revenue_vnd: number;
  unattributed_session_count: number;
  unattributed_energy_wh: number;
}

/**
 * One group. Only groups with sessions are returned; empty days are filled by the dashboard.
 * Every group field is present; those that do not belong to the grouping are null (by charge
 * point, the operator and site fields are filled too).
 */
export interface RevenueRow extends RevenueBucket {
  /** Id of the group, or the day YYYY-MM-DD. */
  key: string;
  operator_id: string | null;
  operator_name: string | null;
  site_id: string | null;
  site_name: string | null;
  charge_point_id: string | null;
  serial_number: string | null;
  day: string | null;
}

/**
 * csms_billed sessions reconciled in the period but without a session debit (promotion not applied
 * yet — K6, RFID card not billed — T115, settlement on hold); not in revenue. `by_reason`: reason
 * code → session count; the code is `charge_settlement_jobs.reason` of a pending job
 * (`promotion_unsupported`, `late_start_operator_review`, `missing_meter`, `invalid_energy`,
 * `policy_unconfigured`…), `ineligible` without a job, `posted_without_debit` for a ledger mismatch.
 */
export interface RevenueUnsettled {
  session_count: number;
  by_reason: Record<string, number>;
}

export interface RevenueReport {
  /** Period, both days included, Asia/Ho_Chi_Minh. */
  from: string;
  to: string;
  group_by: RevenueGroupBy;
  /** Operator route: the caller's Operator; admin route: the filter, null without one. */
  operator_id: string | null;
  currency: 'VND';
  rows: RevenueRow[];
  totals: RevenueBucket;
  /** csms_billed sessions stopped in the period but not yet reconciled: not in revenue yet. */
  pending_reconciliation: { session_count: number };
  unsettled: RevenueUnsettled;
  /** Query time; older periods can still change after a late reconciliation (K3). */
  generated_at: string;
}

export interface RevenueQuery {
  from: string;
  to: string;
  group_by: RevenueGroupBy;
  /** Operator only. */
  site_id?: string;
  /** Admin only. */
  operator_id?: string;
}

/**
 * Admin transaction list (T108b, Khang; screen 35 — UC-ADM-10). Source:
 * apps/csms/src/operator-api/admin-transactions.ts, contract §4.1. One row = one stopped session.
 */
export type TransactionKind =
  'csms_billed' | 'unsettled' | 'pending_reconciliation' | 'unattributed';
/** DB enum `session_origin`. */
export type TransactionOrigin = 'app_qr' | 'rfid' | 'hmi_password' | 'free_vend';

export interface TransactionRow {
  session_id: string;
  /** OCPP transactionId. */
  transaction_no: number;
  kind: TransactionKind;
  session_status: string;
  payment_mode: string;
  origin: TransactionOrigin;
  operator_id: string;
  operator_name: string;
  site_id: string;
  site_code: string;
  site_name: string;
  charge_point_id: string;
  serial_number: string;
  connector_no: number;
  started_at: string;
  stopped_at: string | null;
  /** The moment that puts the session in the period (K3); `period_day` is its day, UTC+7. */
  period_at: string;
  period_day: string;
  /** null = the meter reading is missing, not 0 Wh. */
  energy_wh: number | null;
  /** Only for `csms_billed`: |session_debit|. */
  amount_vnd: number | null;
  /** Only for `unsettled`: same codes as `RevenueUnsettled.by_reason`. */
  unsettled_reason: string | null;
  driver_id: string | null;
  promotion_code: string | null;
  /** Sent by the charge point after it reconnected. */
  delivered_offline: boolean;
}

export interface TransactionPage {
  from: string;
  to: string;
  currency: 'VND';
  /** Rows of the whole filtered set; `items` is one page of them. */
  total: number;
  items: TransactionRow[];
  /** Sums of the whole filtered set (not only this page). */
  totals: RevenueBucket;
  pending_reconciliation: { session_count: number };
  unsettled: RevenueUnsettled;
  generated_at: string;
  page: number;
  page_size: number;
}

export interface TransactionQuery {
  from: string;
  to: string;
  operator_id?: string;
  site_id?: string;
  charge_point_id?: string;
  kind?: TransactionKind;
  origin?: TransactionOrigin;
}
