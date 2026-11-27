/**
 * FE-18 — `GET /api/admin/v1/operators` (contract §3.8, OpenAPI `listOperators`, UC-ADM-02 /
 * UC-ADM-07) behind RolesGuard `admin`: the Operators of the platform, for the Operator filter of
 * screen 31 and staff assignment on screen 28. `status` (active|suspended|closed), `page`,
 * `page_size` (1–100, default 50); ordered by legal name. The lab Operator (NFR-03) is left out.
 */
import type { Db } from '../db/db.module.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';
import { TEST_OPERATOR_TAX_CODE } from './operator-monitoring.js';

const STATUSES = ['active', 'suspended', 'closed'];

export interface OperatorsRoute {
  status: string | null;
  page: number;
  pageSize: number;
}

/** Matches `rest` (path after /api/admin/v1) and checks the query; null if it is another route. */
export function matchOperatorsRoute(rest: string, query: URLSearchParams): OperatorsRoute | null {
  if (rest !== '/operators') return null;
  const keys = [...query.keys()];
  const status = query.get('status');
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    keys.some((k) => !['status', 'page', 'page_size'].includes(k)) ||
    new Set(keys).size !== keys.length ||
    (status !== null && !STATUSES.includes(status)) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  return { status, page, pageSize };
}

export async function listOperators(db: Db, r: OperatorsRoute) {
  const params = [r.status, TEST_OPERATOR_TAX_CODE];
  const where = ` FROM operators WHERE ($1::text IS NULL OR status::text=$1) AND tax_code<>$2`;
  const [count, rows] = await Promise.all([
    db.$client.query<{ n: string }>('SELECT count(*)::text AS n' + where, params),
    db.$client.query(
      'SELECT id::text AS id,tax_code,legal_name,status::text AS status' +
        where +
        ' ORDER BY legal_name,id LIMIT $3 OFFSET $4',
      [...params, r.pageSize, (r.page - 1) * r.pageSize],
    ),
  ]);
  return { items: rows.rows, total: Number(count.rows[0]!.n), page: r.page, page_size: r.pageSize };
}
