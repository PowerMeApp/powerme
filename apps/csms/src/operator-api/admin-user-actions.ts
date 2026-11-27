/**
 * FE-19 — screen 28 Users & Roles (UC-ADM-01, UC-ADM-02, BR-P05, BR-P16, F-13) behind RolesGuard
 * `admin`, as the OpenAPI describes (contract §3.8, until now "planned · Trí"):
 *   POST /api/admin/v1/users                 → 201 UserAccount (operator_staff or admin only)
 *   GET  /api/admin/v1/users/{id}            → UserAccount
 *   PATCH /api/admin/v1/users/{id}           → full name / phone
 *   PUT  /api/admin/v1/users/{id}/role       → one role per user (BR-P16)
 *   POST /api/admin/v1/users/{id}/lock       → active → suspended (F-13)
 *   POST /api/admin/v1/users/{id}/unlock     → suspended → active
 * Drivers sign up themselves (consent, BR-P05), so the Admin never creates one and cannot change a
 * driver's role. A lock or role change takes effect on the next request: RolesGuard, the dashboard
 * refresh and the Driver API all re-read the account from the DB. The lock / unlock note is written
 * to the log with the acting Admin (there is no audit table, as for WF-02 D10).
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';
import { normalizePhoneNumber } from '../driver/phone-number.js';
import { chargeTransaction } from '../sessions/charge-sql.js';
import { hashChargePointPassword } from '../stations/charge-point-credential.js';
import { AuthError } from '../users/auth.js';
import { presentUser, USER_COLUMNS, USER_FROM, type UserRow } from './admin-users.js';

const logger = new Logger('AdminUsers');
const ID_RE = /^[1-9][0-9]{0,18}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAFF_ROLES = ['manager', 'technician'];

export type UserAction =
  | { kind: 'create'; methods: readonly string[] }
  | { kind: 'user'; id: string; methods: readonly string[] }
  | { kind: 'role'; id: string; methods: readonly string[] }
  | { kind: 'lock' | 'unlock'; id: string; methods: readonly string[] };

/**
 * `rest` = path after /api/admin/v1. `GET /users` is the list (admin-users.ts), so it is not
 * matched here; every other method on /users is the create route (405 unless POST).
 */
export function matchUserAction(rest: string, method: string | undefined): UserAction | null {
  if (rest === '/users')
    return method === 'GET' ? null : { kind: 'create', methods: ['GET', 'POST'] };
  const m = /^\/users\/([^/]+)(?:\/(role|lock|unlock))?$/.exec(rest);
  if (!m) return null;
  if (!ID_RE.test(m[1]!)) throw new AuthError(404, 'not_found');
  const id = m[1]!;
  if (!m[2]) return { kind: 'user', id, methods: ['GET', 'PATCH'] };
  if (m[2] === 'role') return { kind: 'role', id, methods: ['PUT'] };
  return { kind: m[2] as 'lock' | 'unlock', id, methods: ['POST'] };
}

function invalid(): never {
  throw new AuthError(400, 'invalid_input');
}

function onlyKeys(body: Record<string, unknown>, allowed: string[], atLeastOne = false) {
  const keys = Object.keys(body);
  if (keys.some((k) => !allowed.includes(k)) || (atLeastOne && !keys.length)) invalid();
}

function text(v: unknown, min: number, max: number): string {
  if (typeof v !== 'string') return invalid();
  const t = v.trim();
  return [...t].length < min || [...t].length > max ? invalid() : t;
}

/** null clears the phone; otherwise BE-30 normalisation (E.164). */
function phone(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return invalid();
  return normalizePhoneNumber(v) ?? invalid();
}

/** Role fields of CreateStaffUserRequest / SetRoleRequest. */
function roleFields(body: Record<string, unknown>) {
  const role = body['role'];
  if (role === 'admin') {
    if (body['operator_id'] !== undefined || body['staff_role'] !== undefined) invalid();
    return { role, operatorId: null, staffRole: null } as const;
  }
  if (role !== 'operator_staff') return invalid();
  const operatorId = body['operator_id'];
  const staffRole = body['staff_role'];
  if (typeof operatorId !== 'string' || !ID_RE.test(operatorId)) invalid();
  if (typeof staffRole !== 'string' || !STAFF_ROLES.includes(staffRole)) invalid();
  return { role, operatorId, staffRole } as const;
}

async function readUser(client: Pick<PoolClient, 'query'>, id: string) {
  const row = (await client.query<UserRow>(`${USER_COLUMNS}${USER_FROM} WHERE u.id=$1`, [id]))
    .rows[0];
  if (!row) throw new AuthError(404, 'not_found');
  return presentUser(row);
}

/** Unique violations → the documented 409 codes. */
function uniqueError(error: unknown): never {
  const c = (error as { code?: string; constraint?: string }) ?? {};
  if (c.code === '23505' && c.constraint === 'users_email_key')
    throw new AuthError(409, 'email_taken');
  if (c.code === '23505' && c.constraint === 'users_phone_number_key')
    throw new AuthError(409, 'phone_taken');
  throw error;
}

async function requireOperator(client: PoolClient, operatorId: string | null) {
  if (operatorId === null) return;
  const r = await client.query('SELECT 1 FROM operators WHERE id=$1 FOR KEY SHARE', [operatorId]);
  if (!r.rowCount) throw new AuthError(404, 'operator_not_found');
}

/** Puts the user's role rows in line with `role` (BR-P16: exactly one role). */
async function setRoleRows(client: PoolClient, userId: string, f: ReturnType<typeof roleFields>) {
  await client.query('DELETE FROM admins WHERE user_id=$1', [userId]);
  await client.query('DELETE FROM operator_staff WHERE user_id=$1', [userId]);
  if (f.role === 'admin') await client.query('INSERT INTO admins(user_id) VALUES($1)', [userId]);
  else
    await client.query(
      'INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,$3)',
      [userId, f.operatorId, f.staffRole],
    );
}

export async function runUserAction(
  db: Db,
  adminId: string,
  action: UserAction,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  switch (action.kind) {
    case 'create':
      return { status: 201, body: await createUser(db, body!) };
    case 'user':
      return {
        status: 200,
        body:
          method === 'GET'
            ? await readUser(db.$client, action.id)
            : await patchUser(db, action.id, body!),
      };
    case 'role':
      return { status: 200, body: await setRole(db, adminId, action.id, body!) };
    default:
      return { status: 200, body: await setLock(db, adminId, action.id, action.kind, body!) };
  }
}

async function createUser(db: Db, body: Record<string, unknown>) {
  onlyKeys(body, [
    'email',
    'full_name',
    'phone_number',
    'role',
    'operator_id',
    'staff_role',
    'initial_password',
  ]);
  const email = text(body['email'], 3, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) invalid();
  const fullName = text(body['full_name'], 1, 100);
  const phoneNumber = body['phone_number'] === undefined ? null : phone(body['phone_number']);
  const f = roleFields(body);
  const password = body['initial_password'];
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) invalid();
  const hash = await hashChargePointPassword(password);
  try {
    return await chargeTransaction(db, async (client) => {
      await requireOperator(client, f.operatorId);
      const taken = await client.query('SELECT 1 FROM users WHERE lower(email)=$1 LIMIT 1', [
        email,
      ]);
      if (taken.rowCount) throw new AuthError(409, 'email_taken');
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO users(email,full_name,phone_number,role,password_hash)
           VALUES($1,$2,$3,$4,$5) RETURNING id::text AS id`,
          [email, fullName, phoneNumber, f.role, hash],
        )
      ).rows[0]!.id;
      await setRoleRows(client, id, f);
      return readUser(client, id);
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return uniqueError(error);
  }
}

async function patchUser(db: Db, id: string, body: Record<string, unknown>) {
  onlyKeys(body, ['full_name', 'phone_number'], true);
  const fullName = body['full_name'] === undefined ? undefined : text(body['full_name'], 1, 100);
  const phoneNumber = body['phone_number'] === undefined ? undefined : phone(body['phone_number']);
  try {
    return await chargeTransaction(db, async (client) => {
      await readUser(client, id);
      await client.query(
        `UPDATE users SET full_name=coalesce($2,full_name),
           phone_number=CASE WHEN $3::boolean THEN $4 ELSE phone_number END, updated_at=now()
         WHERE id=$1`,
        [id, fullName ?? null, phoneNumber !== undefined, phoneNumber ?? null],
      );
      return readUser(client, id);
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return uniqueError(error);
  }
}

async function setRole(db: Db, adminId: string, id: string, body: Record<string, unknown>) {
  onlyKeys(body, ['role', 'operator_id', 'staff_role']);
  const f = roleFields(body);
  return chargeTransaction(db, async (client) => {
    const current = await readUser(client, id);
    if (current.role === 'driver') throw new AuthError(409, 'role_change_not_allowed');
    if (id === adminId) throw new AuthError(409, 'cannot_change_own_role');
    await requireOperator(client, f.operatorId);
    await client.query('UPDATE users SET role=$2, updated_at=now() WHERE id=$1', [id, f.role]);
    await setRoleRows(client, id, f);
    logger.log(`role: user ${id} → ${f.role} by admin ${adminId}`);
    return readUser(client, id);
  });
}

async function setLock(
  db: Db,
  adminId: string,
  id: string,
  kind: 'lock' | 'unlock',
  body: Record<string, unknown>,
) {
  onlyKeys(body, ['note']);
  const note = text(body['note'], 1, 500);
  return chargeTransaction(db, async (client) => {
    const current = await readUser(client, id);
    if (kind === 'lock' && id === adminId) throw new AuthError(409, 'cannot_lock_self');
    const from = kind === 'lock' ? 'active' : 'suspended';
    if (current.account_status !== from) throw new AuthError(409, 'invalid_transition');
    await client.query(
      `UPDATE users SET account_status=$2::user_account_status, updated_at=now() WHERE id=$1`,
      [id, kind === 'lock' ? 'suspended' : 'active'],
    );
    logger.log(`${kind}: user ${id} by admin ${adminId}: ${JSON.stringify(note)}`);
    return readUser(client, id);
  });
}
