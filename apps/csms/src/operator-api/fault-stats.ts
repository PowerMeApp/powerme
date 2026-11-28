/**
 * Fault statistics for the home pages (screens 17 and 27) behind RolesGuard:
 *   GET /api/operator/v1/faults/stats?from=&to=
 *   GET /api/admin/v1/faults/stats?from=&to=&operator_id=
 * FaultEvents raised in the period, per Vietnam day (Asia/Ho_Chi_Minh, as the revenue report) and
 * severity, by kind, how many of them are resolved and how fast, and the charge points with the most.
 * Severity is not stored: it comes from the error code (`guideFor`, as the fault list and
 * the admin summary). Kind follows the fault list DTO (`operator-faults.ts`). The operator route
 * takes the Operator from RolesGuard (BR-P16); the admin route leaves out lab stations.
 */
import type { Db } from '../db/db.module.js';
import { guideFor, OFFLINE_ERROR_CODE } from '../stations/faults/error-code-guide.js';
import { AuthError } from '../users/auth.js';
import { REAL_CP } from './admin-platform.js';
import { ID, parsePeriod } from './revenue-report.js';

export interface FaultStatsQuery {
  from: string;
  to: string;
  /** Operator route: from RolesGuard; admin route: the optional filter. */
  operatorId: string | null;
  /** Admin route: lab stations are left out (an Operator always sees its own). */
  realOnly: boolean;
}

/** Charge points listed in `top_charge_points`. */
export const TOP_CHARGE_POINTS = 5;

/** Matches `rest` (path after /api/{surface}/v1); null if it is not the fault stats route. */
export function matchFaultStatsRoute(
  surface: 'operator' | 'admin',
  rest: string,
  query: URLSearchParams,
): { from: string; to: string; operatorId: string | null } | null {
  if (rest !== '/faults/stats') return null;
  const allowed = surface === 'admin' ? ['from', 'to', 'operator_id'] : ['from', 'to'];
  const keys = [...query.keys()];
  if (keys.some((k) => !allowed.includes(k)) || new Set(keys).size !== keys.length)
    throw new AuthError(400, 'invalid_input');
  const id = query.get('operator_id');
  if (id !== null && !ID.test(id)) throw new AuthError(400, 'invalid_input');
  return { ...parsePeriod(query), operatorId: id };
}

type Severity = 'critical' | 'major' | 'minor' | 'none';
type Kind = 'faulted' | 'offline' | 'driver_report';
const emptySeverities = () => ({ critical: 0, major: 0, minor: 0, none: 0 });

const kindOf = (source: string, errorCode: string | null): Kind =>
  source === 'driver_report'
    ? 'driver_report'
    : errorCode === OFFLINE_ERROR_CODE
      ? 'offline'
      : 'faulted';

export async function faultStats(db: Db, q: FaultStatsQuery) {
  const params: unknown[] = [q.from, q.to];
  const scope: string[] = q.realOnly ? [REAL_CP] : [];
  if (q.operatorId !== null) {
    params.push(q.operatorId);
    scope.push(`st.operator_id=$${params.length}::bigint`);
  }
  /** Faults raised in [from 00:00, to + 1 day 00:00) Vietnam time, of charge points in scope. */
  const from = `FROM fault_events f
       JOIN charge_points cp ON cp.id=f.charge_point_id
       LEFT JOIN sites st ON st.id=cp.site_id
     WHERE f.raised_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND f.raised_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       ${scope.map((c) => `AND ${c}`).join(' ')}`;

  const groups = (
    await db.$client.query<{
      day: string;
      source: string;
      error_code: string | null;
      raised: number;
      resolved: number;
    }>(
      `SELECT to_char((f.raised_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'YYYY-MM-DD') AS day,
              f.source::text AS source, f.error_code,
              count(*)::int AS raised,
              count(*) FILTER (WHERE f.status='resolved')::int AS resolved
       ${from}
       GROUP BY 1,2,3`,
      params,
    )
  ).rows;

  const [mttr] = (
    await db.$client.query<{ s: number | null }>(
      `SELECT round(avg(extract(epoch FROM f.resolved_at - f.raised_at)))::int AS s
       ${from} AND f.status='resolved' AND f.resolved_at IS NOT NULL`,
      params,
    )
  ).rows;

  const top = (
    await db.$client.query<{
      charge_point_id: string;
      serial_number: string;
      station_name: string | null;
      count: number;
    }>(
      `SELECT cp.id::text AS charge_point_id, cp.serial_number, st.site_name AS station_name,
              count(*)::int AS count
       ${from}
       GROUP BY cp.id, cp.serial_number, st.site_name
       ORDER BY count DESC, cp.serial_number
       LIMIT ${TOP_CHARGE_POINTS}`,
      params,
    )
  ).rows;

  const bySeverity = emptySeverities();
  const byKind: Record<Kind, number> = { faulted: 0, offline: 0, driver_report: 0 };
  const days = new Map<string, Record<Severity, number>>();
  let raised = 0;
  let resolved = 0;
  for (const g of groups) {
    const severity = guideFor(g.error_code).severity;
    raised += g.raised;
    resolved += g.resolved;
    bySeverity[severity] += g.raised;
    byKind[kindOf(g.source, g.error_code)] += g.raised;
    const day = days.get(g.day) ?? emptySeverities();
    day[severity] += g.raised;
    days.set(g.day, day);
  }

  return {
    from: q.from,
    to: q.to,
    generated_at: new Date().toISOString(),
    totals: {
      raised,
      resolved,
      by_severity: bySeverity,
      by_kind: byKind,
      mean_time_to_resolve_s: mttr?.s ?? null,
    },
    /** Days with at least one fault, in order; the dashboard fills the others. */
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, s]) => ({
        day,
        ...s,
        total: s.critical + s.major + s.minor + s.none,
      })),
    top_charge_points: top,
  };
}
