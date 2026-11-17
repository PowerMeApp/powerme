/**
 * Operator charge point monitoring (FE-03, UC-OPS-02, screens 17 and 18; OPERATOR-DASHBOARD-PLAN
 * D19–D25, D36) behind RolesGuard `operator_staff`:
 *   GET /api/operator/v1/charge-points?site_id=&lifecycle=&online=&page=&page_size=
 *       → { items: ChargePoint[], total, page, page_size }            (contract §2.4, §3.3)
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
import type { Db } from '../db/db.module.js';
import type { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { guideFor } from '../stations/faults/error-code-guide.js';
import { AuthError } from '../users/auth.js';
import type { Principal } from '../users/roles-guard.js';

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

export type MonitoringRoute =
  | {
      kind: 'charge-points';
      siteId: string | null;
      lifecycle: Lifecycle | null;
      online: boolean | null;
      page: number;
      pageSize: number;
    }
  | { kind: 'summary' };

/** Matches `rest` (path after /api/operator/v1); null if it is not a monitoring route. */
export function matchMonitoringRoute(rest: string, query: URLSearchParams): MonitoringRoute | null {
  const keys = [...query.keys()];
  if (rest === '/summary') {
    if (keys.length) throw new AuthError(400, 'invalid_input');
    return { kind: 'summary' };
  }
  if (rest !== '/charge-points') return null;
  const allowed = ['site_id', 'lifecycle', 'online', 'page', 'page_size'];
  if (keys.some((k) => !allowed.includes(k)) || new Set(keys).size !== keys.length)
    throw new AuthError(400, 'invalid_input');
  const siteId = query.get('site_id');
  const lifecycle = query.get('lifecycle');
  const online = query.get('online');
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (siteId !== null && !/^[1-9][0-9]{0,18}$/.test(siteId)) ||
    (lifecycle !== null && !(LIFECYCLES as readonly string[]).includes(lifecycle)) ||
    (online !== null && online !== 'true' && online !== 'false') ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  return {
    kind: 'charge-points',
    siteId,
    lifecycle: lifecycle as Lifecycle | null,
    online: online === null ? null : online === 'true',
    page,
    pageSize,
  };
}

function intParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  return /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : NaN;
}

/** `offline` for a charge point row aliased `cp` ($2 = offline threshold in ms). */
const OFFLINE_SQL = `(NOT cp.is_online OR cp.last_message_at IS NULL
  OR cp.last_message_at < now()-($2::bigint*interval '1 millisecond'))`;

/**
 * The Operator's charge points after the list filters ($1 operator, $2 offline ms, $3 lifecycle,
 * $4 site, $5 online). `decommissioned` only when asked for (D24).
 */
const FILTERED_CTE = `WITH cps AS (
  SELECT cp.*,st.site_code,st.site_name,${OFFLINE_SQL} AS offline
  FROM charge_points cp JOIN sites st ON st.id=cp.site_id
  WHERE st.operator_id=$1
    AND (($3::text IS NULL AND cp.lifecycle<>'decommissioned') OR cp.lifecycle::text=$3)
    AND ($4::bigint IS NULL OR st.id=$4)
), filtered AS (
  SELECT * FROM cps WHERE $5::boolean IS NULL OR offline = NOT $5
)`;

export async function runMonitoringRoute(
  route: MonitoringRoute,
  principal: Principal,
  db: Db,
  thresholds: MonitoringThresholds,
  registry?: ConnectionRegistry,
): Promise<unknown> {
  const operatorId = principal.operatorId!;
  return route.kind === 'summary'
    ? summary(db, operatorId, thresholds)
    : chargePoints(db, operatorId, route, thresholds, registry);
}

async function chargePoints(
  db: Db,
  operatorId: string,
  route: Extract<MonitoringRoute, { kind: 'charge-points' }>,
  { staleAfterMs, offlineAfterMs }: MonitoringThresholds,
  registry?: ConnectionRegistry,
) {
  const filters = [operatorId, offlineAfterMs, route.lifecycle, route.siteId, route.online];
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
    connectors: Record<string, unknown>[];
  }>(
    `${FILTERED_CTE}
     SELECT count(*) OVER()::int AS total,f.id::text,f.serial_number,f.display_code,f.model,
       f.lifecycle,f.is_online,f.last_message_at,f.site_id::text,f.site_code,f.site_name,
       coalesce((SELECT jsonb_agg(jsonb_build_object(
         'connector_id',c.id::text,'connector_no',c.connector_no,'connector_type',c.connector_type,
         'max_power_kw',c.max_power_kw::float8,'status',c.status,'status_updated_at',c.status_changed_at,
         'status_quality',CASE WHEN f.offline THEN 'offline'
           WHEN c.status_changed_at IS NULL OR f.last_message_at>now() OR c.status_changed_at>now()
             OR f.last_message_at < now()-($6::bigint*interval '1 millisecond')
             OR c.status_changed_at < f.online_changed_at THEN 'stale' ELSE 'fresh' END,
         'error_code',CASE WHEN c.status='Faulted' THEN (SELECT e.error_code FROM connector_status_events e
           WHERE e.connector_id=c.id ORDER BY e.id DESC LIMIT 1) END,
         'active_session_id',(SELECT s.id::text FROM sessions s WHERE s.connector_id=c.id
           AND s.received_stopped_at IS NULL AND s.status IN ('pending','active','paused','stopping')
           ORDER BY s.id DESC LIMIT 1)
       ) ORDER BY c.connector_no) FROM connectors c WHERE c.charge_point_id=f.id),'[]'::jsonb) AS connectors
     FROM filtered f ORDER BY f.site_code,f.serial_number LIMIT $7 OFFSET $8`,
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
