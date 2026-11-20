/**
 * Admin platform overview (FE-14, UC-ADM-07, screen 27; OPERATOR-DASHBOARD-PLAN D33, D36) behind
 * RolesGuard `admin`:
 *   GET /api/admin/v1/summary → AdminSummary (no query)
 * Counts over the whole platform (the Admin has no Operator scope): user accounts by role,
 * charge points by lifecycle and online, RFID cards by status, and the open billing exceptions
 * in the terms of docs/UC-ADM-08-BILLING-EXCEPTIONS.md (read-only SQL, no code in billing/, D35).
 * Platform statistics (20/11): Operators and stations, and the charge point network — charge
 * points in service online / offline, connectors in the driver groups (same rule as the operator
 * summary, BR-P38) and open faults by severity, across every Operator (read-only, UC-ADM-07).
 */
import type { Db } from '../db/db.module.js';
import { guideFor } from '../stations/faults/error-code-guide.js';
import { AuthError } from '../users/auth.js';
import { OFFLINE_SQL, type MonitoringThresholds } from './operator-monitoring.js';

export type AdminRoute = { kind: 'summary' };

/** Matches `rest` (path after /api/admin/v1); null if it is not a platform route. */
export function matchAdminRoute(rest: string, query: URLSearchParams): AdminRoute | null {
  if (rest !== '/summary') return null;
  if ([...query.keys()].length) throw new AuthError(400, 'invalid_input');
  return { kind: 'summary' };
}

/** `offline` with the threshold as $1 (same rule as the operator API, D20). */
const OFFLINE = OFFLINE_SQL.replace('$2', '$1');

export async function runAdminSummary(db: Db, { offlineAfterMs }: MonitoringThresholds) {
  const [row] = (
    await db.$client.query<{
      driver: number;
      operator_staff: number;
      admin: number;
      suspended: number;
      by_lifecycle: Record<string, number> | null;
      online: number;
      active: number;
      blocked: number;
      unlinked: number;
      late_payments: number;
      invoices_needs_review: number;
      failed_refunds: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE role='driver') AS driver,
         (SELECT count(*)::int FROM users WHERE role='operator_staff') AS operator_staff,
         (SELECT count(*)::int FROM users WHERE role='admin') AS admin,
         (SELECT count(*)::int FROM users WHERE account_status='suspended') AS suspended,
         (SELECT jsonb_object_agg(lifecycle,n) FROM (
            SELECT lifecycle,count(*)::int AS n FROM charge_points GROUP BY lifecycle) l) AS by_lifecycle,
         (SELECT count(*)::int FROM charge_points cp WHERE NOT ${OFFLINE}) AS online,
         (SELECT count(*)::int FROM rfid_cards WHERE status='active') AS active,
         (SELECT count(*)::int FROM rfid_cards WHERE status='blocked') AS blocked,
         (SELECT count(*)::int FROM rfid_cards WHERE status='unlinked') AS unlinked,
         -- UC-ADM-08 tab 2: a late payment not yet refunded (on any status since T116).
         (SELECT count(*)::int FROM top_ups
            WHERE late_gateway_ref IS NOT NULL AND late_refunded_at IS NULL) AS late_payments,
         -- Tab 3: e-invoices after their automatic retries (BR-P44).
         (SELECT count(*)::int FROM e_invoices WHERE status='needs_review') AS invoices_needs_review,
         (SELECT count(*)::int FROM refunds WHERE status='failed') AS failed_refunds`,
      [offlineAfterMs],
    )
  ).rows;
  const [net] = (
    await db.$client.query<{
      operators: number;
      active_operators: number;
      sites: number;
      in_service_online: number;
      in_service_offline: number;
      available: number;
      in_use: number;
      freeing_soon: number;
      unavailable: number;
      conn_offline: number;
    }>(
      `WITH cps AS (
         SELECT cp.id,cp.lifecycle,${OFFLINE} AS offline FROM charge_points cp
         WHERE cp.lifecycle<>'decommissioned'
       ), grouped AS (
         SELECT CASE WHEN cps.offline THEN 'offline' WHEN c.status='Available' THEN 'available'
           WHEN c.status IN ('Preparing','Charging','SuspendedEV','SuspendedEVSE') THEN 'in_use'
           WHEN c.status='Finishing' THEN 'freeing_soon' ELSE 'unavailable' END AS g
         FROM cps JOIN connectors c ON c.charge_point_id=cps.id
       )
       SELECT
         (SELECT count(*)::int FROM operators) AS operators,
         (SELECT count(*)::int FROM operators WHERE status='active') AS active_operators,
         (SELECT count(*)::int FROM sites) AS sites,
         (SELECT count(*)::int FROM cps WHERE lifecycle='in_service' AND NOT offline) AS in_service_online,
         (SELECT count(*)::int FROM cps WHERE lifecycle='in_service' AND offline) AS in_service_offline,
         count(*) FILTER (WHERE g='available')::int AS available,
         count(*) FILTER (WHERE g='in_use')::int AS in_use,
         count(*) FILTER (WHERE g='freeing_soon')::int AS freeing_soon,
         count(*) FILTER (WHERE g='unavailable')::int AS unavailable,
         count(*) FILTER (WHERE g='offline')::int AS conn_offline
       FROM grouped`,
      [offlineAfterMs],
    )
  ).rows;
  const faults = (
    await db.$client.query<{ error_code: string | null }>(
      "SELECT error_code FROM fault_events WHERE status<>'resolved'",
    )
  ).rows;
  const open_faults = { total: faults.length, critical: 0, major: 0, minor: 0, none: 0 };
  for (const f of faults) open_faults[guideFor(f.error_code).severity] += 1;
  return {
    operators: { total: net!.operators, active: net!.active_operators },
    sites: net!.sites,
    network: {
      in_service_online: net!.in_service_online,
      in_service_offline: net!.in_service_offline,
      connectors: {
        available: net!.available,
        in_use: net!.in_use,
        freeing_soon: net!.freeing_soon,
        unavailable: net!.unavailable,
        offline: net!.conn_offline,
      },
      open_faults,
    },
    users: {
      driver: row!.driver,
      operator_staff: row!.operator_staff,
      admin: row!.admin,
      suspended: row!.suspended,
    },
    charge_points: { by_lifecycle: row!.by_lifecycle ?? {}, online: row!.online },
    rfid_cards: { active: row!.active, blocked: row!.blocked, unlinked: row!.unlinked },
    billing_exceptions: {
      late_payments: row!.late_payments,
      invoices_needs_review: row!.invoices_needs_review,
      failed_refunds: row!.failed_refunds,
    },
  };
}
