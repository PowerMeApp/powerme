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
