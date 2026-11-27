/**
 * Revenue report (F-16, UC-OPS-09, UC-ADM-10, BR-P46; T108a) behind RolesGuard:
 *   GET /api/operator/v1/revenue[.csv]?from=&to=&group_by=charge_point|site|day&site_id=
 *   GET /api/admin/v1/revenue[.csv]?from=&to=&group_by=operator|site|charge_point|day&operator_id=
 * JSON and CSV call the same `revenueReport()`; only the formatting differs (contract §4, K9).
 *
 * Which bucket a stopped session lands in (`KIND_SQL`, shared with T108b `transactions`):
 *   - `csms_billed`: csms_billed + reconciled + has its `session_debit` (one per session, unique
 *     index) → revenue = Σ |amount_vnd|. `adjustment` is not added (K2, T108 v1).
 *   - `unsettled`: csms_billed + reconciled without a debit (RFID card not billed yet — T115, held
 *     settlement job, promotion — K6). Not revenue; counted by settlement job reason.
 *   - `pending_reconciliation`: csms_billed, `closed` / `review`.
 *   - `unattributed`: no payer, free vend included (origin = free_vend); sessions and Wh only.
 *   Running, `orphaned` and `failed` sessions are in no bucket (K11).
 * Period (K3): `PERIOD_AT_SQL`, days in Asia/Ho_Chi_Minh, `[from 00:00, to + 1 day 00:00)` compared
 * as timestamptz so an index on the expression can serve it.
 */
import type { Db } from '../db/db.module.js';
import { AuthError } from '../users/auth.js';

/** K3: the stop time used for pricing (#120 / T134), else the charge point / CSMS stop time. */
export const PERIOD_AT_SQL = `(CASE WHEN s.status='reconciled'
  THEN COALESCE(s.priced_ended_at,s.cp_stopped_at,s.received_stopped_at)
  ELSE s.received_stopped_at END)`;

/** Bucket of a stopped session; `d` is the session's `session_debit` row (LEFT JOIN). */
export const KIND_SQL = `(CASE WHEN s.payment_mode='unattributed' THEN 'unattributed'
  WHEN s.status<>'reconciled' THEN 'pending_reconciliation'
  WHEN d.id IS NOT NULL THEN 'csms_billed' ELSE 'unsettled' END)`;

/** Statuses that can land in a bucket; everything else is running, orphaned or failed. */
export const STOPPED_SQL = `s.status IN ('closed','review','reconciled')`;

/** Why an `unsettled` session has no debit; `j` is its settlement job (session_id is the PK). */
export const UNSETTLED_REASON_SQL = `(CASE WHEN j.state='pending' THEN j.reason
  WHEN j.state='ineligible' AND j.reason='account_closed' THEN 'account_closed'
  WHEN j.state='posted' THEN 'posted_without_debit' ELSE 'ineligible' END)`;

/** Vietnam calendar day of `PERIOD_AT_SQL`. */
export const PERIOD_DAY_SQL = `(${PERIOD_AT_SQL} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Sessions with their charge point, site (inner: no site → no bucket), Operator, `session_debit`
 * (`d`) and settlement job (`j`). Shared by the revenue report and T108b `transactions`.
 */
export const STOPPED_FROM_SQL = `FROM sessions s
       JOIN charge_points cp ON cp.id=s.charge_point_id
       JOIN sites st ON st.id=cp.site_id
       JOIN operators o ON o.id=st.operator_id
       LEFT JOIN credit_transactions d ON d.session_id=s.id AND d.transaction_type='session_debit'
       LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id`;

/** [from 00:00, to + 1 day 00:00) Vietnam time, from two `date` parameters. */
export const periodBoundsSql = (from: string, to: string) =>
  `${PERIOD_AT_SQL} >= (${from}::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
   AND ${PERIOD_AT_SQL} < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`;

export type RevenueGroupBy = 'operator' | 'site' | 'charge_point' | 'day';

const ROW_FIELDS = [
  'operator_id',
  'operator_name',
  'site_id',
  'site_name',
  'charge_point_id',
  'serial_number',
  'day',
] as const;
type RowField = (typeof ROW_FIELDS)[number];

/** Fixed group definitions: columns of the CTE `k`, the key column and the row order. */
const GROUPS: Record<RevenueGroupBy, { cols: RowField[]; key: RowField; order: string }> = {
  operator: {
    cols: ['operator_id', 'operator_name'],
    key: 'operator_id',
    order: 'k.operator_name,k.operator_id',
  },
  site: {
    cols: ['operator_id', 'operator_name', 'site_id', 'site_name'],
    key: 'site_id',
    order: 'k.operator_name,k.site_name,k.site_id',
  },
  charge_point: {
    cols: [
      'operator_id',
      'operator_name',
      'site_id',
      'site_name',
      'charge_point_id',
      'serial_number',
    ],
    key: 'charge_point_id',
    order: 'k.operator_name,k.site_name,k.serial_number,k.charge_point_id',
  },
  day: { cols: ['day'], key: 'day', order: 'k.day' },
};
const OPERATOR_GROUPS: readonly RevenueGroupBy[] = ['charge_point', 'site', 'day'];
const ADMIN_GROUPS: readonly RevenueGroupBy[] = ['operator', 'site', 'charge_point', 'day'];
const MAX_DAYS = 366;
/** Contract `Id`: bigint as a decimal string. */
export const ID = /^[1-9][0-9]{0,18}$/;
const DAY = /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/;

export interface RevenueQuery {
  format: 'json' | 'csv';
  from: string;
  to: string;
  groupBy: RevenueGroupBy;
  /** Operator route only. */
  siteId: string | null;
  /** Admin route only; the operator route takes the Operator from RolesGuard. */
  operatorId: string | null;
}

/** Matches `rest` (path after /api/{surface}/v1); null if it is not a revenue route. */
export function matchRevenueRoute(
  surface: 'operator' | 'admin',
  rest: string,
  query: URLSearchParams,
): RevenueQuery | null {
  const m = /^\/revenue(\.csv)?$/.exec(rest);
  if (!m) return null;
  const filter = surface === 'operator' ? 'site_id' : 'operator_id';
  const keys = [...query.keys()];
  if (
    keys.some((k) => !['from', 'to', 'group_by', filter].includes(k)) ||
    new Set(keys).size !== keys.length
  )
    throw new AuthError(400, 'invalid_input');
  const groups = surface === 'operator' ? OPERATOR_GROUPS : ADMIN_GROUPS;
  const groupBy = query.get('group_by') ?? groups[0]!;
  const id = query.get(filter);
  if (!(groups as readonly string[]).includes(groupBy) || (id !== null && !ID.test(id)))
    throw new AuthError(400, 'invalid_input');
  const { from, to } = parsePeriod(query);
  return {
    format: m[1] ? 'csv' : 'json',
    from,
    to,
    groupBy: groupBy as RevenueGroupBy,
    siteId: surface === 'operator' ? id : null,
    operatorId: surface === 'admin' ? id : null,
  };
}

/**
 * `from` and `to`: real days, required → else 400 `invalid_input`; from > to or longer than 366
 * days (both ends counted) → 400 `invalid_period`. Shared with T108b `transactions`.
 */
export function parsePeriod(query: URLSearchParams): { from: string; to: string } {
  const from = query.get('from');
  const to = query.get('to');
  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs === null || toMs === null) throw new AuthError(400, 'invalid_input');
  if (fromMs > toMs || (toMs - fromMs) / 86_400_000 + 1 > MAX_DAYS)
    throw new AuthError(400, 'invalid_period');
  return { from: from!, to: to! };
}

/** A real calendar day `YYYY-MM-DD` → its UTC midnight in ms; null otherwise. */
function dayMs(raw: string | null): number | null {
  if (raw === null || !DAY.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d
    ? t
    : null;
}

export interface RevenueBucket {
  csms_billed_session_count: number;
  csms_billed_energy_wh: number;
  csms_billed_revenue_vnd: number;
  unattributed_session_count: number;
  unattributed_energy_wh: number;
}
export type RevenueRow = { key: string } & Record<RowField, string | null> & RevenueBucket;
export interface RevenueReport {
  from: string;
  to: string;
  group_by: RevenueGroupBy;
  operator_id: string | null;
  currency: 'VND';
  rows: RevenueRow[];
  totals: RevenueBucket;
  pending_reconciliation: { session_count: number };
  unsettled: { session_count: number; by_reason: Record<string, number> };
  generated_at: string;
}

export interface RevenueParams {
  from: string;
  to: string;
  groupBy: RevenueGroupBy;
  /** null = every Operator (admin without filter). */
  operatorId: string | null;
  siteId: string | null;
}

/**
 * One statement, so rows, totals, pending and unsettled come from one snapshot of the same
 * sessions: `GROUPING SETS ((group), ())` gives the group rows and the total row together.
 */
export async function revenueReport(db: Db, p: RevenueParams): Promise<RevenueReport> {
  const g = GROUPS[p.groupBy];
  const first = g.cols[0]!;
  const select = ROW_FIELDS.map((f) =>
    g.cols.includes(f) ? `${f}::text AS ${f}` : `NULL::text AS ${f}`,
  ).join(',');
  const { rows } = await db.$client.query<
    Record<RowField, string | null> & {
      is_total: number;
      csms_billed_session_count: number;
      csms_billed_energy_wh: string;
      csms_billed_revenue_vnd: string;
      unattributed_session_count: number;
      unattributed_energy_wh: string;
      pending_count: number;
      unsettled_count: number;
      unsettled_by_reason: Record<string, number>;
      generated_at: Date;
    }
  >(
    `WITH k AS (
       SELECT o.id AS operator_id,o.legal_name AS operator_name,st.id AS site_id,st.site_name,
         cp.id AS charge_point_id,cp.serial_number,
         ${PERIOD_DAY_SQL} AS day,
         ${KIND_SQL} AS kind,${UNSETTLED_REASON_SQL} AS reason,
         s.energy_wh,abs(d.amount_vnd) AS amount_vnd
       ${STOPPED_FROM_SQL}
       WHERE ${STOPPED_SQL}
         AND ($3::bigint IS NULL OR st.operator_id=$3)
         AND ($4::bigint IS NULL OR st.id=$4)
         AND ${periodBoundsSql('$1', '$2')}
     )
     SELECT GROUPING(${first}) AS is_total,${select},
       count(*) FILTER (WHERE kind='csms_billed')::int AS csms_billed_session_count,
       COALESCE(sum(energy_wh) FILTER (WHERE kind='csms_billed'),0)::text AS csms_billed_energy_wh,
       COALESCE(sum(amount_vnd) FILTER (WHERE kind='csms_billed'),0)::text AS csms_billed_revenue_vnd,
       count(*) FILTER (WHERE kind='unattributed')::int AS unattributed_session_count,
       COALESCE(sum(energy_wh) FILTER (WHERE kind='unattributed'),0)::text AS unattributed_energy_wh,
       count(*) FILTER (WHERE kind='pending_reconciliation')::int AS pending_count,
       count(*) FILTER (WHERE kind='unsettled')::int AS unsettled_count,
       (SELECT COALESCE(jsonb_object_agg(reason,n),'{}'::jsonb) FROM
         (SELECT reason,count(*)::int AS n FROM k WHERE kind='unsettled' GROUP BY reason) r)
         AS unsettled_by_reason,
       now() AS generated_at
     FROM k
     GROUP BY GROUPING SETS ((${g.cols.join(',')}),())
     HAVING GROUPING(${first})=1 OR count(*) FILTER (WHERE kind IN ('csms_billed','unattributed'))>0
     ORDER BY GROUPING(${first}),${g.order}`,
    [p.from, p.to, p.operatorId, p.siteId],
  );
  // The empty grouping set always yields the total row, even with no session in the period.
  const total = rows.pop()!;
  return {
    from: p.from,
    to: p.to,
    group_by: p.groupBy,
    operator_id: p.operatorId,
    currency: 'VND',
    rows: rows.map((r) => ({
      key: r[g.key]!,
      ...(Object.fromEntries(ROW_FIELDS.map((f) => [f, r[f]])) as Record<RowField, string | null>),
      ...bucket(r),
    })),
    totals: bucket(total),
    pending_reconciliation: { session_count: total.pending_count },
    unsettled: { session_count: total.unsettled_count, by_reason: total.unsettled_by_reason },
    generated_at: total.generated_at.toISOString(),
  };
}

export function bucket(r: {
  csms_billed_session_count: number;
  csms_billed_energy_wh: string;
  csms_billed_revenue_vnd: string;
  unattributed_session_count: number;
  unattributed_energy_wh: string;
}): RevenueBucket {
  return {
    csms_billed_session_count: r.csms_billed_session_count,
    csms_billed_energy_wh: safe(r.csms_billed_energy_wh),
    csms_billed_revenue_vnd: safe(r.csms_billed_revenue_vnd),
    unattributed_session_count: r.unattributed_session_count,
    unattributed_energy_wh: safe(r.unattributed_energy_wh),
  };
}

/** Contract: VND and Wh are JSON integers; a sum past 2^53 − 1 is a 500, never a rounded number. */
export function safe(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error('revenue_out_of_range');
  return n;
}
