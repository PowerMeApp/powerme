/**
 * FE-18 — screen 31 Charge Point Network Monitor (UC-ADM-07) behind RolesGuard `admin`:
 *   GET /api/admin/v1/network/charge-points?operator_id=&online=&lifecycle=&site_id=
 *       &charge_point_q=&site_q=&page=&page_size=
 * Every Operator's charge points (lab data excluded, as on screen 27) with the same live fields as
 * screen 18 (connector statuses, Offline override, status quality), plus the Operator and the open
 * faults (total, most severe). Read-only. Uptime / utilisation (BR-P43) wait for the metrics API.
 */
import type { Db } from '../db/db.module.js';
import type { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import {
  chargePoints,
  parseChargePointList,
  type MonitoringRoute,
  type MonitoringThresholds,
} from './operator-monitoring.js';

export type NetworkRoute = Extract<MonitoringRoute, { kind: 'charge-points' }>;

/** Matches `rest` (path after /api/admin/v1) and checks the query; null if it is another route. */
export function matchNetworkRoute(rest: string, query: URLSearchParams): NetworkRoute | null {
  if (rest !== '/network/charge-points') return null;
  return parseChargePointList(query, true);
}

export async function listNetwork(
  db: Db,
  route: NetworkRoute,
  thresholds: MonitoringThresholds,
  registry?: ConnectionRegistry,
) {
  const page = await chargePoints(db, route.operatorId ?? null, route, thresholds, registry);
  return {
    ...page,
    items: page.items.map(({ extra: _extra, admin, ...cp }) => ({ ...cp, ...admin })),
  };
}
