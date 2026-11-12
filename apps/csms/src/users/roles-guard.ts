/**
 * RolesGuard (Report 4 component 03 `users`; F-13, NFR-SEC-01, BR-P16; ADR-0018). Bad, missing or
 * expired token → 401; valid token of another role (a driver token too) → 403; then the DB is read
 * on every request, so locking a user or Operator, or moving staff, stops a live token at once.
 * The Operator a request is scoped to comes from the DB, never from the request.
 */
import type { IncomingMessage } from 'node:http';
import { jwtVerify, type JWTPayload } from 'jose';
import type { Db } from '../db/db.module.js';
import type { DriverApiConfig } from '../driver/driver-auth.js';
import {
  assertConfigured,
  AuthError,
  DASHBOARD_TOKEN_TTL_S,
  type DashboardAuthConfig,
  type DashboardRole,
  type StaffRole,
} from './auth.js';

export interface Principal {
  userId: string;
  role: DashboardRole;
  operatorId?: string;
  staffRole?: StaffRole;
}

const BEARER = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i;
const ID = /^[1-9][0-9]{0,18}$/;

async function verify(token: string, key: Uint8Array, iss: string, aud: string, maxAge: number) {
  return (
    await jwtVerify(token, key, {
      algorithms: ['HS256'],
      typ: 'JWT',
      issuer: iss,
      audience: aud,
      requiredClaims: ['sub', 'exp', 'iat', 'role'],
      maxTokenAge: maxAge,
      clockTolerance: 0,
    })
  ).payload;
}

export async function rolesGuard(
  req: IncomingMessage,
  surface: DashboardRole,
  db: Db,
  config: DashboardAuthConfig,
  driver?: DriverApiConfig,
): Promise<Principal> {
  const { secret, issuer, audience } = assertConfigured(config);
  const count = req.rawHeaders.filter(
    (h, i) => i % 2 === 0 && h.toLowerCase() === 'authorization',
  ).length;
  const header = req.headers.authorization;
  if (count !== 1 || !header || header.length > 8192 || !BEARER.test(header))
    throw new AuthError(401, 'unauthorized');
  const token = header.slice(7);

  let claims: JWTPayload;
  try {
    claims = await verify(token, secret, issuer, audience, DASHBOARD_TOKEN_TTL_S);
  } catch {
    // F-13: a token the Driver API would accept is a valid token of the wrong role → 403.
    const isDriver =
      driver?.secret && driver.issuer && driver.audience
        ? await verify(token, driver.secret, driver.issuer, driver.audience, 900).then(
            (p) => p['role'] === 'driver',
            () => false,
          )
        : false;
    throw new AuthError(isDriver ? 403 : 401, isDriver ? 'forbidden' : 'unauthorized');
  }
  const operatorClaim = claims['operator_id'];
  if (typeof claims.sub !== 'string' || !ID.test(claims.sub))
    throw new AuthError(401, 'unauthorized');
  if (claims['role'] !== surface) throw new AuthError(403, 'forbidden');

  const row = (
    await db.$client.query<{
      role: string;
      account_status: string;
      is_admin: boolean;
      operator_id: string | null;
      operator_status: string | null;
      staff_role: StaffRole | null;
    }>(
      `SELECT u.role,u.account_status,(a.user_id IS NOT NULL) AS is_admin,
         s.operator_id::text AS operator_id,o.status AS operator_status,s.staff_role
       FROM users u LEFT JOIN admins a ON a.user_id=u.id
       LEFT JOIN operator_staff s ON s.user_id=u.id LEFT JOIN operators o ON o.id=s.operator_id
       WHERE u.id=$1`,
      [claims.sub],
    )
  ).rows[0];
  if (!row) throw new AuthError(401, 'unauthorized');
  if (row.role !== surface) throw new AuthError(403, 'forbidden');
  if (row.account_status !== 'active') throw new AuthError(403, 'account_locked');
  if (surface === 'admin') {
    if (!row.is_admin) throw new AuthError(403, 'forbidden');
    return { userId: claims.sub, role: 'admin' };
  }
  // Staff moved to another Operator since login → log in again.
  if (row.operator_id === null || row.operator_id !== operatorClaim)
    throw new AuthError(401, 'unauthorized');
  if (row.operator_status !== 'active') throw new AuthError(403, 'operator_inactive');
  return {
    userId: claims.sub,
    role: 'operator_staff',
    operatorId: row.operator_id,
    staffRole: row.staff_role!,
  };
}
