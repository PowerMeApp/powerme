/**
 * Admin transaction list (UC-ADM-10, screen 35, BR-P46; T108b; contract §4.1) behind RolesGuard `admin`:
 *   GET /api/admin/v1/transactions?from=&to=[&operator_id=&site_id=&charge_point_id=&kind=&origin=]
 *       [&page=1..10000][&page_size=1..100]
 *   GET /api/admin/v1/transactions.csv?<same filters>   (no paging; ≤ 100 000 rows — K10)
 * One row = one stopped session (K7). Same sessions, period and buckets as `revenueReport()`: it
 * reuses `STOPPED_FROM_SQL`, `STOPPED_SQL`, `KIND_SQL`, `PERIOD_AT_SQL`, `UNSETTLED_REASON_SQL` and
 * `periodBoundsSql`, so without kind / site / charge point / origin filters `totals`,
 * `pending_reconciliation` and `unsettled` equal the revenue report for the same from, to, operator.
 * The page, `total` and every sum come from ONE statement (one snapshot): `t` aggregates the whole
 * filtered set, `p` is the page, `t LEFT JOIN p` keeps the totals when the page is past the end.
 */
import type { Db } from '../db/db.module.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';
import {
  bucket,
  ID,
  KIND_SQL,
  parsePeriod,
  PERIOD_AT_SQL,
  PERIOD_DAY_SQL,
  periodBoundsSql,
  safe,
  STOPPED_FROM_SQL,
  STOPPED_SQL,
  UNSETTLED_REASON_SQL,
  type RevenueBucket,
} from './revenue-report.js';

/** K10: a CSV export with more rows than this is 400 `export_too_large`, never a cut file. */
export const TRANSACTIONS_CSV_MAX_ROWS = 100_000;

export const TRANSACTION_KINDS = [
  'csms_billed',
  'unsettled',
  'pending_reconciliation',
  'unattributed',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];
/** DB enum `session_origin`. */
const ORIGINS: readonly string[] = ['app_qr', 'rfid', 'hmi_password', 'free_vend'];
const FILTER_KEYS = ['from', 'to', 'operator_id', 'site_id', 'charge_point_id', 'kind', 'origin'];

export interface TransactionFilter {
  from: string;
  to: string;
  operatorId: string | null;
  siteId: string | null;
  chargePointId: string | null;
  kind: TransactionKind | null;
  origin: string | null;
}
export type TransactionsQuery = TransactionFilter &
  ({ format: 'json'; page: number; pageSize: number } | { format: 'csv' });

/** Matches `rest` (path after /api/admin/v1); null if it is not a transactions route. */
export function matchTransactionsRoute(
  rest: string,
  query: URLSearchParams,
): TransactionsQuery | null {
  const m = /^\/transactions(\.csv)?$/.exec(rest);
  if (!m) return null;
  const csv = Boolean(m[1]);
  // The CSV has no paging: `page` / `page_size` there are unknown keys (contract §4.1).
  const allowed = csv ? FILTER_KEYS : [...FILTER_KEYS, 'page', 'page_size'];
  const keys = [...query.keys()];
  if (keys.some((k) => !allowed.includes(k)) || new Set(keys).size !== keys.length)
    throw new AuthError(400, 'invalid_input');
  const ids = ['operator_id', 'site_id', 'charge_point_id'].map((k) => query.get(k));
  const kind = query.get('kind');
  const origin = query.get('origin');
  if (
    ids.some((id) => id !== null && !ID.test(id)) ||
    (kind !== null && !(TRANSACTION_KINDS as readonly string[]).includes(kind)) ||
    (origin !== null && !ORIGINS.includes(origin))
  )
    throw new AuthError(400, 'invalid_input');
  const { from, to } = parsePeriod(query);
  const filter: TransactionFilter = {
    from,
    to,
    operatorId: ids[0]!,
    siteId: ids[1]!,
    chargePointId: ids[2]!,
    kind: kind as TransactionKind | null,
    origin,
  };
  if (csv) return { ...filter, format: 'csv' };
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (!(page >= 1 && page <= MAX_PAGE) || !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE))
    throw new AuthError(400, 'invalid_input');
  return { ...filter, format: 'json', page, pageSize };
}

export interface TransactionRow {
  session_id: string;
  transaction_no: number;
  kind: TransactionKind;
  session_status: string;
  payment_mode: string;
  origin: string;
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
  period_at: string;
  period_day: string;
  energy_wh: number | null;
  amount_vnd: number | null;
  unsettled_reason: string | null;
  driver_id: string | null;
  promotion_code: string | null;
  delivered_offline: boolean;
}

/** What the page and the CSV share: rows plus the sums of the whole filtered set. */
export interface TransactionResult {
  from: string;
  to: string;
  currency: 'VND';
  total: number;
  items: TransactionRow[];
  totals: RevenueBucket;
  pending_reconciliation: { session_count: number };
  unsettled: { session_count: number; by_reason: Record<string, number> };
  generated_at: string;
}
export type TransactionPage = TransactionResult & { page: number; page_size: number };
/** `all_energy_wh` = Σ `energy_wh` of every row of the file, any kind, nulls skipped (TOTAL line). */
export type TransactionExport = TransactionResult & { all_energy_wh: number };

export async function listTransactions(
  db: Db,
  f: TransactionFilter,
  page: number,
  pageSize: number,
): Promise<TransactionPage> {
  const { all_energy_wh: _, ...r } = await queryTransactions(db, f, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
    cap: null,
  });
  return { ...r, page, page_size: pageSize };
}

/** Every row, or 400 `export_too_large` when the filtered set is larger than `maxRows`. */
export async function exportTransactions(
  db: Db,
  f: TransactionFilter,
  maxRows = TRANSACTIONS_CSV_MAX_ROWS,
): Promise<TransactionExport> {
  const r = await queryTransactions(db, f, { limit: null, offset: 0, cap: maxRows });
  if (r.total > maxRows) throw new AuthError(400, 'export_too_large');
  return r;
}

interface Row {
  total: number;
  csms_billed_session_count: number;
  csms_billed_energy_wh: string;
  csms_billed_revenue_vnd: string;
  unattributed_session_count: number;
  unattributed_energy_wh: string;
  pending_count: number;
  unsettled_count: number;
  unsettled_by_reason: Record<string, number>;
  all_energy_wh: string;
  generated_at: Date;
  // Page columns: all null on the single row of an empty page.
  session_id: string | null;
  transaction_no: number;
  kind: TransactionKind;
  session_status: string;
  payment_mode: string;
  origin: string;
  operator_id: string;
  operator_name: string;
  site_id: string;
  site_code: string;
  site_name: string;
  charge_point_id: string;
  serial_number: string;
  connector_no: number;
  started_at: Date;
  stopped_at: Date | null;
  period_at: Date;
  period_day: string;
  energy_wh: string | null;
  debit_vnd: string | null;
  reason: string;
  driver_id: string | null;
  promotion_code: string | null;
  delivered_offline: boolean;
}

/**
 * `cap`: when the filtered set has more rows than this, `p` returns nothing (a one-time filter,
 * so the rows are not read) and the caller answers `export_too_large`. null = no cap.
 */
async function queryTransactions(
  db: Db,
  f: TransactionFilter,
  o: { limit: number | null; offset: number; cap: number | null },
): Promise<TransactionExport> {
  const { rows } = await db.$client.query<Row>(
    `WITH k AS (
       SELECT s.id AS sid,s.id::text AS session_id,s.transaction_no,${KIND_SQL} AS kind,
         s.status::text AS session_status,s.payment_mode::text AS payment_mode,s.origin::text AS origin,
         o.id::text AS operator_id,o.legal_name AS operator_name,
         st.id::text AS site_id,st.site_code,st.site_name,
         cp.id::text AS charge_point_id,cp.serial_number,s.connector_no,
         s.received_started_at AS started_at,s.received_stopped_at AS stopped_at,
         ${PERIOD_AT_SQL} AS period_at,${PERIOD_DAY_SQL}::text AS period_day,
         s.energy_wh,abs(d.amount_vnd) AS debit_vnd,${UNSETTLED_REASON_SQL} AS reason,
         s.driver_id::text AS driver_id,pr.promotion_code,s.delivered_offline
       ${STOPPED_FROM_SQL}
       LEFT JOIN promotions pr ON pr.id=s.promotion_id
       WHERE ${STOPPED_SQL}
         AND ($3::bigint IS NULL OR st.operator_id=$3)
         AND ($4::bigint IS NULL OR st.id=$4)
         AND ($5::bigint IS NULL OR cp.id=$5)
         AND ($6::session_origin IS NULL OR s.origin=$6)
         AND ${periodBoundsSql('$1', '$2')}
     ),
     f AS (SELECT * FROM k WHERE $7::text IS NULL OR kind=$7),
     t AS (
       SELECT count(*)::int AS total,
         count(*) FILTER (WHERE kind='csms_billed')::int AS csms_billed_session_count,
         COALESCE(sum(energy_wh) FILTER (WHERE kind='csms_billed'),0)::text AS csms_billed_energy_wh,
         COALESCE(sum(debit_vnd) FILTER (WHERE kind='csms_billed'),0)::text AS csms_billed_revenue_vnd,
         count(*) FILTER (WHERE kind='unattributed')::int AS unattributed_session_count,
         COALESCE(sum(energy_wh) FILTER (WHERE kind='unattributed'),0)::text AS unattributed_energy_wh,
         count(*) FILTER (WHERE kind='pending_reconciliation')::int AS pending_count,
         count(*) FILTER (WHERE kind='unsettled')::int AS unsettled_count,
         (SELECT COALESCE(jsonb_object_agg(reason,n),'{}'::jsonb) FROM
           (SELECT reason,count(*)::int AS n FROM f WHERE kind='unsettled' GROUP BY reason) r)
           AS unsettled_by_reason,
         COALESCE(sum(energy_wh),0)::text AS all_energy_wh,
         now() AS generated_at
       FROM f
     ),
     p AS (
       SELECT * FROM f
       WHERE $10::int IS NULL OR (SELECT total FROM t) <= $10
       ORDER BY period_at DESC,sid DESC
       LIMIT $8::int OFFSET $9::int
     )
     SELECT t.*,p.* FROM t LEFT JOIN p ON true
     ORDER BY p.period_at DESC,p.sid DESC`,
    [
      f.from,
      f.to,
      f.operatorId,
      f.siteId,
      f.chargePointId,
      f.origin,
      f.kind,
      o.limit,
      o.offset,
      o.cap,
    ],
  );
  const head = rows[0]!;
  return {
    from: f.from,
    to: f.to,
    currency: 'VND',
    total: head.total,
    items: rows.filter((r) => r.session_id !== null).map(toRow),
    totals: bucket(head),
    pending_reconciliation: { session_count: head.pending_count },
    unsettled: { session_count: head.unsettled_count, by_reason: head.unsettled_by_reason },
    all_energy_wh: safe(head.all_energy_wh),
    generated_at: head.generated_at.toISOString(),
  };
}

function toRow(r: Row): TransactionRow {
  return {
    session_id: r.session_id!,
    transaction_no: r.transaction_no,
    kind: r.kind,
    session_status: r.session_status,
    payment_mode: r.payment_mode,
    origin: r.origin,
    operator_id: r.operator_id,
    operator_name: r.operator_name,
    site_id: r.site_id,
    site_code: r.site_code,
    site_name: r.site_name,
    charge_point_id: r.charge_point_id,
    serial_number: r.serial_number,
    connector_no: r.connector_no,
    started_at: r.started_at.toISOString(),
    stopped_at: r.stopped_at?.toISOString() ?? null,
    period_at: r.period_at.toISOString(),
    period_day: r.period_day,
    energy_wh: r.energy_wh === null ? null : safe(r.energy_wh),
    // A debit on a session that is not csms_billed (e.g. still in review) is not shown (§4.1).
    amount_vnd: r.kind === 'csms_billed' ? safe(r.debit_vnd!) : null,
    unsettled_reason: r.kind === 'unsettled' ? r.reason : null,
    driver_id: r.driver_id,
    promotion_code: r.promotion_code,
    delivered_offline: r.delivered_offline,
  };
}
