/**
 * Revenue report (T108, Khang; screens 25 and 35 — FE-07, Nghĩa) — types only, snake_case as on the
 * wire. Source: contract §4 (BR-P46) and `RevenueReport` in docs/api/operator-admin-api.openapi.yaml.
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

/** One group. Only groups with sessions are returned; empty days are filled by the dashboard. */
export interface RevenueRow extends RevenueBucket {
  /** Id of the group, or the day YYYY-MM-DD. */
  key: string;
  operator_id?: string | null;
  operator_name?: string | null;
  site_id?: string | null;
  site_name?: string | null;
  charge_point_id?: string | null;
  serial_number?: string | null;
  day?: string | null;
}

/**
 * Sessions reconciled but not debited (a promotion applies, RFID card waiting for T115); not in
 * revenue. ASSUMED shape until T108 lands: `by_reason` maps a reason code to a session count —
 * to be confirmed with Khang.
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
  operator_id?: string | null;
  currency: 'VND';
  rows: RevenueRow[];
  totals: RevenueBucket;
  /** csms_billed sessions stopped in the period but not yet reconciled: not in revenue yet. */
  pending_reconciliation: { session_count: number };
  unsettled?: RevenueUnsettled;
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
