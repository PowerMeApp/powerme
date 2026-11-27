/**
 * Operator charge point monitoring (FE-03, UC-OPS-02, screens 17 and 18; OPERATOR-DASHBOARD-PLAN
 * D19–D25, D36) behind RolesGuard `operator_staff`:
 *   GET /api/operator/v1/charge-points?site_id=&lifecycle=&online=&charge_point_q=&site_q=&page=&page_size=
 *       FE-07 (screen 18, station page), two separate searches, case- and accent-insensitive:
 *       `charge_point_q` in the charge point code / serial or its exact id; `site_q` in the
 *       station code / name or its exact id. Both given → both must match.
 *       → { items: ChargePoint[], total, page, page_size }            (contract §2.4, §3.3)
 *   GET /api/operator/v1/charge-points/{id} → ChargePointDetail (FE-05, screen 20): the row above
 *       plus firmware / rated power / capabilities, open faults (same DTO as screen 21) and the
 *       20 latest remote commands; another Operator's or an unknown id → 404
 *   GET /api/operator/v1/summary → OperatorSummary
 * Everything is scoped to the token's Operator as RolesGuard read it from the DB (BR-P16).
 *
 * Status rules (same thresholds as the Driver API, `loadChargePolicy`):
 *   - Offline (D20): the charge point is not online, never sent a message, or is silent longer than
 *     the offline threshold (900 s). It overrides every connector status.
 *   - Status quality (D22, BR-P39): `stale` when silent longer than 2 × heartbeat, or the status
 *     was reported before the last reconnect, or has no time; else `fresh`. Same CASE as the
 *     `base` CTE of sessions/station-search.ts.
 *   - The list shows the 9 raw OCPP statuses (D21); the summary groups connectors like the driver
 *     app (BR-P38).
 */
import { FaultActionError, type FaultActions, type FaultActor } from '../console/fault-actions.js';
import type { Db } from '../db/db.module.js';
import type { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import {
  compareSeverity,
  guideFor,
  type FaultSeverity,
} from '../stations/faults/error-code-guide.js';
import { AuthError } from '../users/auth.js';
import type { Principal } from '../users/roles-guard.js';
import { toDto } from './operator-faults.js';

export interface MonitoringThresholds {
  /** BR-P39: 2 × heartbeat interval. */
  staleAfterMs: number;
  /** D20 / NFR-OCPP-07: silent longer than this → Offline. */
  offlineAfterMs: number;
}

const LIFECYCLES = [
  'registered',
  'awaiting_connection',
  'in_service',
  'disabled',
  'decommissioned',
] as const;
type Lifecycle = (typeof LIFECYCLES)[number];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
/** Longest `charge_point_q` / `site_q`, after trimming. */
const MAX_QUERY = 100;

export type MonitoringRoute =
  | {
      kind: 'charge-points';
      siteId: string | null;
      lifecycle: Lifecycle | null;
      online: boolean | null;
      /** Normalised search texts (see `searchText`); null = no search. */
      chargePointQ: string | null;
      siteQ: string | null;
      page: number;
      pageSize: number;
      /** FE-18 admin network list only: `operator_id` filter; null = every Operator. */
      operatorId?: string | null;
    }
  | { kind: 'detail'; id: string }
  | { kind: 'summary' };

/** Matches `rest` (path after /api/operator/v1); null if it is not a monitoring route. */
export function matchMonitoringRoute(rest: string, query: URLSearchParams): MonitoringRoute | null {
  const keys = [...query.keys()];
  if (rest === '/summary') {
    if (keys.length) throw new AuthError(400, 'invalid_input');
    return { kind: 'summary' };
  }
  const detail = /^\/charge-points\/([^/]+)$/.exec(rest);
  if (detail) {
    if (!/^[1-9][0-9]{0,18}$/.test(detail[1]!)) throw new AuthError(404, 'not_found');
    if (keys.length) throw new AuthError(400, 'invalid_input');
    return { kind: 'detail', id: detail[1]! };
  }
  if (rest !== '/charge-points') return null;
  return parseChargePointList(query, false);
}

/**
 * The list filters of screen 18; with `admin` (FE-18, screen 31) also `operator_id`. Unknown or
 * repeated keys → 400.
 */
export function parseChargePointList(
  query: URLSearchParams,
  admin: boolean,
): Extract<MonitoringRoute, { kind: 'charge-points' }> {
  const keys = [...query.keys()];
  const allowed = [
    'site_id',
    'lifecycle',
    'online',
    'charge_point_q',
    'site_q',
    'page',
    'page_size',
    ...(admin ? ['operator_id'] : []),
  ];
  if (keys.some((k) => !allowed.includes(k)) || new Set(keys).size !== keys.length)
    throw new AuthError(400, 'invalid_input');
  const operatorId = query.get('operator_id');
  const siteId = query.get('site_id');
  const lifecycle = query.get('lifecycle');
  const online = query.get('online');
  const cpQ = (query.get('charge_point_q') ?? '').trim();
  const siteQ = (query.get('site_q') ?? '').trim();
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (siteId !== null && !/^[1-9][0-9]{0,18}$/.test(siteId)) ||
    (operatorId !== null && !/^[1-9][0-9]{0,18}$/.test(operatorId)) ||
    (lifecycle !== null && !(LIFECYCLES as readonly string[]).includes(lifecycle)) ||
    (online !== null && online !== 'true' && online !== 'false') ||
    [cpQ, siteQ].some((t) => t.length > MAX_QUERY || /[\x00-\x1f\x7f]/.test(t)) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  return {
    kind: 'charge-points',
    siteId,
    lifecycle: lifecycle as Lifecycle | null,
    online: online === null ? null : online === 'true',
    chargePointQ: cpQ ? searchText(cpQ) : null,
    siteQ: siteQ ? searchText(siteQ) : null,
    page,
    pageSize,
    ...(admin ? { operatorId } : {}),
  };
}

/**
 * Same normalisation as the SQL function `powerme_search_text` (migration 0006, used by the
 * driver's station search): NFD, drop combining marks, đ → d, lower case.
 */
function searchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function intParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  return /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Lab data kept on staging (NFR-03 load test Operator); never counted or listed across Operators
 * (review #169). An Operator-scoped query never sees it anyway.
 */
export const TEST_OPERATOR_TAX_CODE = 'LOADTEST01';

/** `offline` for a charge point row aliased `cp` ($2 = offline threshold in ms). */
export const OFFLINE_SQL = `(NOT cp.is_online OR cp.last_message_at IS NULL
  OR cp.last_message_at < now()-($2::bigint*interval '1 millisecond'))`;

/**
 * The Operator's charge points after the list filters ($1 operator — null = every Operator but the
 * lab one (FE-18, Admin only), $2 offline ms, $3 lifecycle,
 * $4 site, $5 online, $6 one charge point id, $7 charge point search, $8 station search; both
 * normalised). `decommissioned` only when asked for (D24) or when one charge point is asked for by
 * id (screen 20). Each search matches a substring of the code / serial (charge point) or code /
 * name (station), or the exact id.
 */
const FILTERED_CTE = `WITH cps AS (
  SELECT cp.*,st.site_code,st.site_name,op.id AS operator_id,op.legal_name AS operator_name,
    ${OFFLINE_SQL} AS offline
  FROM charge_points cp JOIN sites st ON st.id=cp.site_id JOIN operators op ON op.id=st.operator_id
  WHERE ($1::bigint IS NULL AND op.tax_code<>'${TEST_OPERATOR_TAX_CODE}' OR st.operator_id=$1)
    AND (($3::text IS NULL AND ($6::bigint IS NOT NULL OR cp.lifecycle<>'decommissioned'))
      OR cp.lifecycle::text=$3)
    AND ($4::bigint IS NULL OR st.id=$4)
    AND ($6::bigint IS NULL OR cp.id=$6)
    AND ($7::text IS NULL OR cp.id::text=$7
      OR strpos(powerme_search_text(concat_ws(' ',cp.serial_number,cp.display_code)),$7)>0)
    AND ($8::text IS NULL OR st.id::text=$8
      OR strpos(powerme_search_text(concat_ws(' ',st.site_code,st.site_name)),$8)>0)
), filtered AS (
  SELECT * FROM cps WHERE $5::boolean IS NULL OR offline = NOT $5
)`;

export async function runMonitoringRoute(
  route: MonitoringRoute,
  principal: Principal,
  db: Db,
  thresholds: MonitoringThresholds,
  registry?: ConnectionRegistry,
  faults?: FaultActions,
): Promise<unknown> {
  const operatorId = principal.operatorId!;
  if (route.kind === 'summary') return summary(db, operatorId, thresholds);
  if (route.kind === 'charge-points') {
    const page = await chargePoints(db, operatorId, route, thresholds, registry);
    return { ...page, items: page.items.map(({ extra: _extra, admin: _admin, ...cp }) => cp) };
  }
  return detail(db, principal, route.id, thresholds, registry, faults);
}

const DETAIL_PAGE = {
  siteId: null,
  lifecycle: null,
  online: null,
  chargePointQ: null,
  siteQ: null,
  page: 1,
  pageSize: 1,
} as const;

/** Screen 20 (FE-05): one charge point of the Operator, its open faults and latest commands. */
async function detail(
  db: Db,
  principal: Principal,
  id: string,
  thresholds: MonitoringThresholds,
  registry?: ConnectionRegistry,
  faults?: FaultActions,
) {
  const operatorId = principal.operatorId!;
  const page = await chargePoints(
    db,
    operatorId,
    { kind: 'charge-points', ...DETAIL_PAGE },
    thresholds,
    registry,
    id,
  );
  const cp = page.items[0];
  if (!cp) throw new AuthError(404, 'not_found');
  if (!faults) throw new FaultActionError(503, 'faults_unavailable', 'FaultService chưa được nạp');
  const actor: FaultActor = { userId: Number(principal.userId), operatorId: Number(operatorId) };
  const [open, commands] = await Promise.all([
    faults.list('open', 50, actor, 0, Number(id)),
    db.$client.query<{
      id: string;
      action: string;
      connector_no: number | null;
      status: string;
      requested_at: Date;
      sent_at: Date | null;
      responded_at: Date | null;
      error: string | null;
    }>(
      `SELECT id::text,action,connector_no,status,requested_at,sent_at,responded_at,error
       FROM remote_commands WHERE charge_point_id=$1 ORDER BY requested_at DESC,id DESC LIMIT 20`,
      [id],
    ),
  ]);
  const { extra, admin: _admin, ...base } = cp;
  return {
    ...base,
    ...extra,
    open_faults: open.map((f) => toDto(f, faults)),
    recent_commands: commands.rows.map((c) => ({
      id: c.id,
      charge_point_id: id,
      action: c.action,
      connector_no: c.connector_no,
      status: c.status,
      requested_at: c.requested_at.toISOString(),
      sent_at: c.sent_at?.toISOString() ?? null,
      responded_at: c.responded_at?.toISOString() ?? null,
      error: c.error,
    })),
  };
}

/**
 * One page of charge points. `operatorId` scopes to one Operator (screens 18 / 20, and the Operator
 * filter of screen 31); null = every Operator (screen 31). Rows carry `operator` and the open
 * faults' codes in `admin` for the network list.
 */
export async function chargePoints(
  db: Db,
  operatorId: string | null,
  route: Extract<MonitoringRoute, { kind: 'charge-points' }>,
  { staleAfterMs, offlineAfterMs }: MonitoringThresholds,
  registry?: ConnectionRegistry,
  chargePointId: string | null = null,
) {
  const filters = [
    operatorId,
    offlineAfterMs,
    route.lifecycle,
    route.siteId,
    route.online,
    chargePointId,
    route.chargePointQ,
    route.siteQ,
  ];
  const { rows } = await db.$client.query<{
    total: number;
    id: string;
    serial_number: string;
    display_code: string | null;
    model: string | null;
    lifecycle: Lifecycle;
    is_online: boolean;
    last_message_at: Date | null;
    site_id: string;
    site_code: string;
    site_name: string;
    operator_id: string;
    operator_name: string;
    open_fault_codes: (string | null)[];
    connectors: Record<string, unknown>[];
    firmware_version: string | null;
    rated_power_kw: number | null;
    reports_soc: boolean;
    supports_reservation: boolean;
  }>(
    `${FILTERED_CTE}
     SELECT count(*) OVER()::int AS total,f.id::text,f.serial_number,f.display_code,f.model,
       f.lifecycle,f.is_online,f.last_message_at,f.site_id::text,f.site_code,f.site_name,
       f.operator_id::text,f.operator_name,
       coalesce((SELECT jsonb_agg(fe.error_code) FROM fault_events fe
         WHERE fe.charge_point_id=f.id AND fe.status<>'resolved'),'[]'::jsonb) AS open_fault_codes,
       f.firmware_version,f.rated_power_kw::float8,f.reports_soc,f.supports_reservation,
       coalesce((SELECT jsonb_agg(jsonb_build_object(
         'connector_id',c.id::text,'connector_no',c.connector_no,'connector_type',c.connector_type,
         'max_power_kw',c.max_power_kw::float8,'status',c.status,'status_updated_at',c.status_changed_at,
         'status_quality',CASE WHEN f.offline THEN 'offline'
           WHEN c.status_changed_at IS NULL OR f.last_message_at>now() OR c.status_changed_at>now()
             OR f.last_message_at < now()-($9::bigint*interval '1 millisecond')
             OR c.status_changed_at < f.online_changed_at THEN 'stale' ELSE 'fresh' END,
         'error_code',CASE WHEN c.status='Faulted' THEN (SELECT e.error_code FROM connector_status_events e
           WHERE e.connector_id=c.id ORDER BY e.id DESC LIMIT 1) END,
         'active_session_id',(SELECT s.id::text FROM sessions s WHERE s.connector_id=c.id
           AND s.received_stopped_at IS NULL AND s.status IN ('pending','active','paused','stopping')
           ORDER BY s.id DESC LIMIT 1)
       ) ORDER BY c.connector_no) FROM connectors c WHERE c.charge_point_id=f.id),'[]'::jsonb) AS connectors
     FROM filtered f ORDER BY f.site_code,f.serial_number LIMIT $10 OFFSET $11`,
    [...filters, staleAfterMs, route.pageSize, (route.page - 1) * route.pageSize],
  );
  // A page past the end has no rows to carry count(*) OVER(), so count separately only then.
  const total =
    rows[0]?.total ??
    (route.page > 1
      ? (
          await db.$client.query<{ n: number }>(
            `${FILTERED_CTE} SELECT count(*)::int AS n FROM filtered`,
            filters,
          )
        ).rows[0]!.n
      : 0);
  return {
    items: rows.map((r) => ({
      id: r.id,
      serial_number: r.serial_number,
      display_code: r.display_code,
      model: r.model,
      lifecycle: r.lifecycle,
      connected: registry?.get(r.serial_number) !== undefined,
      is_online: r.is_online,
      last_message_at: r.last_message_at?.toISOString() ?? null,
      site: { id: r.site_id, site_code: r.site_code, site_name: r.site_name },
      connectors: r.connectors.map((c) => ({
        ...c,
        status_updated_at: c['status_updated_at']
          ? new Date(c['status_updated_at'] as string).toISOString()
          : null,
      })),
      /** Detail-only fields (screen 20); the list leaves them out (contract `ChargePoint`). */
      extra: {
        firmware_version: r.firmware_version,
        rated_power_kw: r.rated_power_kw,
        reports_soc: r.reports_soc,
        supports_reservation: r.supports_reservation,
      },
      /** Network list only (FE-18): the Operator and the open faults by severity. */
      admin: {
        operator: { id: r.operator_id, legal_name: r.operator_name },
        open_faults: openFaults(r.open_fault_codes),
      },
    })),
    total,
    page: route.page,
    page_size: route.pageSize,
  };
}

async function summary(db: Db, operatorId: string, { offlineAfterMs }: MonitoringThresholds) {
  const [cp] = (
    await db.$client.query<{
      total: number;
      offline: number;
      by_lifecycle: Record<string, number> | null;
      available: number;
      in_use: number;
      freeing_soon: number;
      unavailable: number;
      conn_offline: number;
    }>(
      `WITH cps AS (
         SELECT cp.id,cp.lifecycle,${OFFLINE_SQL} AS offline
         FROM charge_points cp JOIN sites st ON st.id=cp.site_id
         WHERE st.operator_id=$1 AND cp.lifecycle<>'decommissioned'
       ), lc AS (SELECT lifecycle,count(*)::int AS n FROM cps GROUP BY lifecycle),
       grouped AS (
         SELECT CASE WHEN cps.offline THEN 'offline' WHEN c.status='Available' THEN 'available'
           WHEN c.status IN ('Preparing','Charging','SuspendedEV','SuspendedEVSE') THEN 'in_use'
           WHEN c.status='Finishing' THEN 'freeing_soon' ELSE 'unavailable' END AS g
         FROM cps JOIN connectors c ON c.charge_point_id=cps.id
       )
       SELECT (SELECT count(*)::int FROM cps) AS total,
         (SELECT count(*)::int FROM cps WHERE offline) AS offline,
         (SELECT jsonb_object_agg(lifecycle,n) FROM lc) AS by_lifecycle,
         count(*) FILTER (WHERE g='available')::int AS available,
         count(*) FILTER (WHERE g='in_use')::int AS in_use,
         count(*) FILTER (WHERE g='freeing_soon')::int AS freeing_soon,
         count(*) FILTER (WHERE g='unavailable')::int AS unavailable,
         count(*) FILTER (WHERE g='offline')::int AS conn_offline
       FROM grouped`,
      [operatorId, offlineAfterMs],
    )
  ).rows;
  const faults = (
    await db.$client.query<{ error_code: string | null }>(
      `SELECT f.error_code FROM fault_events f JOIN charge_points cp ON cp.id=f.charge_point_id
       JOIN sites st ON st.id=cp.site_id WHERE st.operator_id=$1 AND f.status<>'resolved'`,
      [operatorId],
    )
  ).rows;
  const open_faults = { total: faults.length, critical: 0, major: 0, minor: 0, none: 0 };
  for (const f of faults) open_faults[guideFor(f.error_code).severity] += 1;
  const [queues] = (
    await db.$client.query<{ review: number; unattributed: number; uncertain: number }>(
      `SELECT
         (SELECT count(*)::int FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
            JOIN sites st ON st.id=cp.site_id
          WHERE st.operator_id=$1 AND s.status='review') AS review,
         -- Same queue as UnattributedSessionService.listPending (BE-24): stopped, not yet decided.
         (SELECT count(*)::int FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
            JOIN sites st ON st.id=cp.site_id
          WHERE st.operator_id=$1 AND s.payment_mode='unattributed' AND s.received_stopped_at IS NOT NULL
            AND s.status IN ('closed','review','reconciled')
            AND NOT EXISTS (SELECT 1 FROM session_status_history h WHERE h.session_id=s.id
              AND h.event IN ('UNATTRIBUTED_ASSIGNED','UNATTRIBUTED_CLOSED'))) AS unattributed,
         -- T72: a driver start whose outcome is unknown and is not yet settled by the Operator.
         (SELECT count(*)::int FROM driver_charge_intents i JOIN connectors c ON c.id=i.connector_id
            JOIN charge_points cp ON cp.id=c.charge_point_id JOIN sites st ON st.id=cp.site_id
          WHERE st.operator_id=$1 AND i.state='unknown' AND i.session_id IS NULL
            AND i.connector_released_at IS NULL) AS uncertain`,
      [operatorId],
    )
  ).rows;
  return {
    charge_points: {
      total: cp!.total,
      online: cp!.total - cp!.offline,
      offline: cp!.offline,
      by_lifecycle: cp!.by_lifecycle ?? {},
    },
    connectors: {
      available: cp!.available,
      in_use: cp!.in_use,
      freeing_soon: cp!.freeing_soon,
      unavailable: cp!.unavailable,
      offline: cp!.conn_offline,
    },
    open_faults,
    sessions_to_review: queues!.review,
    unattributed_sessions: queues!.unattributed,
    uncertain_starts: queues!.uncertain,
  };
}

/** Open faults of one charge point: total and the most severe (null when none). */
function openFaults(codes: (string | null)[]) {
  let top: FaultSeverity | null = null;
  for (const code of codes) {
    const severity = guideFor(code).severity;
    if (top === null || compareSeverity(severity, top) < 0) top = severity;
  }
  return { total: codes.length, top_severity: top };
}
