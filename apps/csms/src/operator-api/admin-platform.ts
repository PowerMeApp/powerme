/**
 * Admin platform overview (FE-14, UC-ADM-07, screen 27; OPERATOR-DASHBOARD-PLAN D33, D36) behind
 * RolesGuard `admin`:
 *   GET /api/admin/v1/summary → AdminSummary (no query)
 * Counts over the whole platform (the Admin has no Operator scope): user accounts by role,
 * charge points by lifecycle and online, RFID cards by status, and the open billing exceptions
 * in the terms of docs/UC-ADM-08-BILLING-EXCEPTIONS.md (read-only SQL, no code in billing/, D35).
 */
import type { Db } from '../db/db.module.js';
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
  return {
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
