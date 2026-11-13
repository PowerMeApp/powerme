/**
 * IAuth (Report 4 component 03 `users`, ADR-0018, F-13): one login for operator staff and admins.
 * HS256 token with its own key (`DASHBOARD_JWT_*`), 8 h, no refresh; claims `sub`, `role`, and for
 * staff `operator_id` / `staff_role`. Passwords: scrypt of ADR-0011. Never logs secrets.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Db } from '../db/db.module.js';
import {
  hashChargePointPassword as hashPassword,
  verifyChargePointPassword as verifyPassword,
} from '../stations/charge-point-credential.js';
import {
  ChargePointLoginLimiter,
  type ChargePointLoginLimits,
} from '../stations/charge-point-login-limiter.js';

export const DASHBOARD_TOKEN_TTL_S = 8 * 3600;
/** Same numbers as BR-P49 and BE-21: 5 / 60 s per email + IP, 20 per IP, locked 15 min. */
export const STAFF_LOGIN_LIMITS: ChargePointLoginLimits = {
  perSerial: { maxFailures: 5, windowMs: 60_000, lockMs: 15 * 60_000 },
  perIp: { maxFailures: 20, windowMs: 60_000, lockMs: 15 * 60_000 },
};

export type DashboardRole = 'operator_staff' | 'admin';
export type StaffRole = 'manager' | 'technician';
export interface DashboardAuthConfig {
  secret?: Uint8Array;
  issuer?: string;
  audience?: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterS?: number,
  ) {
    super(code);
  }
}

/** All three variables or none; the key is canonical base64 of at least 32 random bytes. */
export function loadDashboardAuthConfig(env: NodeJS.ProcessEnv): DashboardAuthConfig {
  const encoded = env['DASHBOARD_JWT_SECRET_BASE64'];
  const issuer = env['DASHBOARD_JWT_ISSUER'];
  const audience = env['DASHBOARD_JWT_AUDIENCE'];
  if (!encoded && !issuer && !audience) return {};
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !issuer?.trim() || !audience?.trim())
    throw new Error('Dashboard JWT requires DASHBOARD_JWT_SECRET_BASE64, _ISSUER and _AUDIENCE');
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length < 32 || secret.toString('base64') !== encoded)
    throw new Error('DASHBOARD_JWT_SECRET_BASE64 must be canonical base64 of at least 32 bytes');
  return { secret: new Uint8Array(secret), issuer, audience };
}

export function assertConfigured(config: DashboardAuthConfig): Required<DashboardAuthConfig> {
  if (!config.secret || !config.issuer || !config.audience)
    throw new AuthError(503, 'auth_unavailable');
  return config as Required<DashboardAuthConfig>;
}

export interface DashboardUser {
  user_id: string;
  email: string;
  full_name: string;
  role: DashboardRole;
  operator_id?: string;
  operator_name?: string;
  staff_role?: StaffRole;
}

export class StaffAccounts {
  /** Hashed once; used when no user matches so every attempt costs one scrypt. */
  private readonly dummyHash = hashPassword(randomBytes(18).toString('base64url'));

  constructor(
    private readonly db: Db,
    private readonly config: DashboardAuthConfig,
    private readonly limiter = new ChargePointLoginLimiter(STAFF_LOGIN_LIMITS),
  ) {}

  /**
   * UC-ACC-04. Wrong email or password, a driver, or staff/admin without its extension row: the
   * same 401. Locked account (F-13) or inactive Operator: 403, only after the password matched.
   */
  async login(body: Record<string, unknown>, ip: string) {
    const { secret, issuer, audience } = assertConfigured(this.config);
    if (
      Object.keys(body).some((k) => k !== 'email' && k !== 'password') ||
      typeof body['email'] !== 'string' ||
      typeof body['password'] !== 'string'
    )
      throw new AuthError(400, 'invalid_input');
    const email = body['email'].trim().toLowerCase();
    const password = body['password'];
    if (email.length > 254 || [...password].length > 128)
      throw new AuthError(401, 'invalid_credentials');

    const lock = this.limiter.check(email, ip);
    if (lock.locked) throw new AuthError(429, 'too_many_attempts', lock.retryAfterS);
    const done = this.limiter.begin(ip);
    try {
      const row = (
        await this.db.$client.query<{
          id: string;
          email: string;
          full_name: string;
          role: string;
          account_status: string;
          password_hash: string | null;
          is_admin: boolean;
          operator_id: string | null;
          operator_name: string | null;
          operator_status: string | null;
          staff_role: StaffRole | null;
        }>(
          `SELECT u.id::text AS id,u.email,u.full_name,u.role,u.account_status,u.password_hash,
             (a.user_id IS NOT NULL) AS is_admin,s.operator_id::text AS operator_id,
             o.legal_name AS operator_name,o.status AS operator_status,s.staff_role
           FROM users u LEFT JOIN admins a ON a.user_id=u.id
           LEFT JOIN operator_staff s ON s.user_id=u.id LEFT JOIN operators o ON o.id=s.operator_id
           WHERE lower(u.email)=$1`,
          [email],
        )
      ).rows[0];
      const ok = await verifyPassword(password, row?.password_hash ?? (await this.dummyHash));
      const staff = row?.role === 'operator_staff' && row.operator_id !== null;
      const admin = row?.role === 'admin' && row.is_admin;
      if (!row?.password_hash || !ok || !(staff || admin)) {
        this.limiter.recordFailure(email, ip);
        throw new AuthError(401, 'invalid_credentials');
      }
      this.limiter.recordSuccess(email, ip);
      if (row.account_status !== 'active') throw new AuthError(403, 'account_locked');
      if (staff && row.operator_status !== 'active') throw new AuthError(403, 'operator_inactive');

      const user: DashboardUser = {
        user_id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: row.role as DashboardRole,
        ...(staff
          ? {
              operator_id: row.operator_id!,
              operator_name: row.operator_name!,
              staff_role: row.staff_role!,
            }
          : {}),
      };
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        role: user.role,
        ...(staff ? { operator_id: user.operator_id, staff_role: user.staff_role } : {}),
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.user_id)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + DASHBOARD_TOKEN_TTL_S)
        .setJti(randomUUID())
        .sign(secret);
      return {
        access_token: token,
        token_type: 'Bearer' as const,
        expires_in: DASHBOARD_TOKEN_TTL_S,
        user,
      };
    } finally {
      done();
    }
  }
}
