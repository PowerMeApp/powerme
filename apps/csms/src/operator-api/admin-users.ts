/**
 * T161 — `GET /api/admin/v1/users` (contract §3.8, OpenAPI `listUsers`, UC-ADM-01 / UC-ADM-04)
 * behind RolesGuard `admin`: user accounts as `UserAccountPage`. Built now for the driver picker of
 * screen 30 (RFID Cards: `?role=driver&account_status=active&q=…`); the other routes of §3.8
 * (create, update, role, lock / unlock) stay planned (Trí).
 * Filters (all optional, each at most once, others → 400): `role`, `account_status`,
 * `operator_id` (staff of that Operator), `q` (2–100 characters: email or name contains it,
 * case-insensitive, `%` `_` `\` literal — or, added for T161, the phone number equals it after
 * BE-30 normalisation), `page`, `page_size` (1–100, default 50). Newest account first.
 */
import type { Db } from '../db/db.module.js';
import { normalizePhoneNumber } from '../driver/phone-number.js';
import { chargeTransaction } from '../sessions/charge-sql.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';

const KEYS = ['role', 'account_status', 'operator_id', 'q', 'page', 'page_size'];
const ROLES = ['driver', 'operator_staff', 'admin'];
const STATUSES = ['active', 'suspended', 'closed'];

export interface UserSearch {
  role: string | null;
  accountStatus: string | null;
  operatorId: string | null;
  q: string | null;
  page: number;
  pageSize: number;
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone_number: string | null;
  role: string;
  account_status: string;
  operator_id: string | null;
  legal_name: string | null;
  staff_role: string | null;
  created_at: Date;
}

/** Matches `rest` (path after /api/admin/v1) and checks the query; null if it is another route. */
export function matchUsersRoute(rest: string, query: URLSearchParams): UserSearch | null {
  if (rest !== '/users') return null;
  const keys = [...query.keys()];
  const role = query.get('role');
  const accountStatus = query.get('account_status');
  const operatorId = query.get('operator_id');
  const q = query.has('q') ? query.get('q')!.trim() : null;
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    keys.some((k) => !KEYS.includes(k)) ||
    new Set(keys).size !== keys.length ||
    (role !== null && !ROLES.includes(role)) ||
    (accountStatus !== null && !STATUSES.includes(accountStatus)) ||
    (operatorId !== null && !/^[1-9][0-9]{0,18}$/.test(operatorId)) ||
    (q !== null && ([...q].length < 2 || [...q].length > 100)) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  return { role, accountStatus, operatorId, q, page, pageSize };
}

export async function searchUsers(db: Db, s: UserSearch) {
  const params = [
    s.role,
    s.accountStatus,
    s.operatorId,
    s.q === null ? null : '%' + s.q.replace(/[\\%_]/g, '\\$&') + '%',
    s.q === null ? null : normalizePhoneNumber(s.q),
  ];
  const where = `${USER_FROM}
    WHERE ($1::text IS NULL OR u.role::text=$1)
      AND ($2::text IS NULL OR u.account_status::text=$2)
      AND ($3::bigint IS NULL OR os.operator_id=$3)
      AND ($4::text IS NULL OR u.full_name ILIKE $4 ESCAPE E'\\\\' OR u.email ILIKE $4 ESCAPE E'\\\\'
           OR ($5::text IS NOT NULL AND u.phone_number=$5))`;
  return chargeTransaction(db, async (client) => {
    // total and items from one snapshot, like the RFID list.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const total = Number(
      (await client.query<{ n: string }>('SELECT count(*)::text AS n' + where, params)).rows[0]!.n,
    );
    const rows = (
      await client.query<UserRow>(USER_COLUMNS + where + ' ORDER BY u.id DESC LIMIT $6 OFFSET $7', [
        ...params,
        s.pageSize,
        (s.page - 1) * s.pageSize,
      ])
    ).rows;
    return {
      items: rows.map(presentUser),
      total,
      page: s.page,
      page_size: s.pageSize,
    };
  });
}

/** Columns and joins of one `UserAccount` (OpenAPI), shared with the account actions (FE-19). */
export const USER_COLUMNS = `SELECT u.id::text AS id,u.email,u.full_name,u.phone_number,u.role::text AS role,
  u.account_status::text AS account_status,o.id::text AS operator_id,o.legal_name,
  os.staff_role::text AS staff_role,u.created_at`;
export const USER_FROM = ` FROM users u
  LEFT JOIN operator_staff os ON os.user_id=u.id LEFT JOIN operators o ON o.id=os.operator_id`;

export function presentUser(r: UserRow) {
  return {
    id: r.id,
    email: r.email,
    full_name: r.full_name,
    phone_number: r.phone_number,
    role: r.role,
    account_status: r.account_status,
    operator: r.operator_id ? { id: r.operator_id, legal_name: r.legal_name } : null,
    staff_role: r.staff_role,
    created_at: r.created_at.toISOString(),
  };
}
