/**
 * FE-02 — `GET /api/operator/v1/sites` (contract §3.x, OpenAPI `listOperatorSites`, UC-OPS-01,
 * BR-P11) behind RolesGuard `operator_staff`: the Charging Stations of the caller's Operator, for
 * the station picker of screen 19 (Charge Point Onboarding). Operator scope from RolesGuard's DB
 * read, never from the request (BR-P16). Only `page` / `page_size` (1–100, default 50); ordered
 * by `site_code`. Returns `SitePage`.
 */
import type { Db } from '../db/db.module.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';

export interface SitesRoute {
  page: number;
  pageSize: number;
}

interface SiteRow {
  id: string;
  site_code: string;
  site_name: string;
  address: string | null;
  vinfast_only: boolean;
  latitude: string | null;
  longitude: string | null;
}

/** Matches `rest` (path after /api/operator/v1) and checks the query; null if it is another route. */
export function matchSitesRoute(rest: string, query: URLSearchParams): SitesRoute | null {
  if (rest !== '/sites') return null;
  const keys = [...query.keys()];
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    keys.some((k) => k !== 'page' && k !== 'page_size') ||
    new Set(keys).size !== keys.length ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  return { page, pageSize };
}

export async function listSites(db: Db, operatorId: string, r: SitesRoute) {
  const [count, rows] = await Promise.all([
    db.$client.query<{ n: string }>('SELECT count(*)::text AS n FROM sites WHERE operator_id=$1', [
      operatorId,
    ]),
    db.$client.query<SiteRow>(
      `SELECT id::text AS id,site_code,site_name,address,vinfast_only,
         latitude::text AS latitude,longitude::text AS longitude
       FROM sites WHERE operator_id=$1 ORDER BY site_code LIMIT $2 OFFSET $3`,
      [operatorId, r.pageSize, (r.page - 1) * r.pageSize],
    ),
  ]);
  return {
    items: rows.rows.map((s) => ({
      ...s,
      latitude: s.latitude === null ? null : Number(s.latitude),
      longitude: s.longitude === null ? null : Number(s.longitude),
    })),
    total: Number(count.rows[0]!.n),
    page: r.page,
    page_size: r.pageSize,
  };
}
