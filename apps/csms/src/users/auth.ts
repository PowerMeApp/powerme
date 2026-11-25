/**
 * IAuth (Report 4 component 03 `users`, ADR-0018, F-13): one login for operator staff and admins.
 * HS256 tokens with their own key (`DASHBOARD_JWT_*`). Access token 900 s: claims `sub`, `role`, and
 * for staff `operator_id` / `staff_role`. Refresh token (T125, contract §2.2b): same key, header
 * `typ: refresh+jwt`, claim `token_use: refresh`, no `role`, lives `DASHBOARD_JWT_REFRESH_TTL_S`
 * (12 h) from login and is not rotated. RolesGuard needs `typ: JWT` + `role`, `refresh()` needs
 * `typ: refresh+jwt` + `token_use`, so neither token works in place of the other. Passwords: scrypt
 * of ADR-0011. Never logs secrets.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Db } from '../db/db.module.js';
import {
  hashChargePointPassword as hashPassword,
  verifyChargePointPassword as verifyPassword,
} from '../stations/charge-point-credential.js';
import {
  ChargePointLoginLimiter,
  type ChargePointLoginLimits,
} from '../stations/charge-point-login-limiter.js';

/** Access token life (Ân 12/11, contract §2.2b): a leaked token works at most 15 minutes. */
export const DASHBOARD_TOKEN_TTL_S = 900;
/** Refresh token life: one shift including handover (Nghĩa 16/11); bounds 1 h .. 24 h. */
export const DEFAULT_DASHBOARD_REFRESH_TTL_S = 12 * 3600;
const MIN_DASHBOARD_REFRESH_TTL_S = 3600;
const MAX_DASHBOARD_REFRESH_TTL_S = 24 * 3600;
const REFRESH_TYP = 'refresh+jwt';
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
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
  /** `DASHBOARD_JWT_REFRESH_TTL_S`; unset = {@link DEFAULT_DASHBOARD_REFRESH_TTL_S}. */
  refreshTtlS?: number;
  /**
   * BE-46: `DASHBOARD_ALLOWED_ORIGINS`, exact https origins (comma-separated) allowed besides
   * localhost — the dashboard served by Caddy on staging sends `Origin: https://<DOMAIN>`.
   */
  allowedOrigins?: readonly string[];
}

/** Each entry must be exactly an https origin (no path, query or trailing slash). */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((value) => {
    const v = value.trim();
    let origin: string | null = null;
    try {
      origin = new URL(v).origin;
    } catch {
      /* invalid below */
    }
    if (!v.startsWith('https://') || origin !== v)
      throw new Error(
        'DASHBOARD_ALLOWED_ORIGINS must list exact https origins, e.g. https://example.com',
      );
    return v;
  });
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

/**
 * All three variables or none; the key is canonical base64 of at least 32 random bytes. The refresh
 * life is optional and checked even without a key, so a typo never waits for the key to surface.
 */
export function loadDashboardAuthConfig(env: NodeJS.ProcessEnv): DashboardAuthConfig {
  const encoded = env['DASHBOARD_JWT_SECRET_BASE64'];
  const issuer = env['DASHBOARD_JWT_ISSUER'];
  const audience = env['DASHBOARD_JWT_AUDIENCE'];
  const refreshRaw = env['DASHBOARD_JWT_REFRESH_TTL_S'];
  const allowedOrigins = parseAllowedOrigins(env['DASHBOARD_ALLOWED_ORIGINS']);
  let refresh: { refreshTtlS?: number; allowedOrigins?: readonly string[] } = {};
  if (refreshRaw !== undefined && refreshRaw !== '') {
    const ttl = /^[1-9][0-9]{0,8}$/.test(refreshRaw) ? Number(refreshRaw) : NaN;
    if (!(ttl >= MIN_DASHBOARD_REFRESH_TTL_S && ttl <= MAX_DASHBOARD_REFRESH_TTL_S))
      throw new Error('DASHBOARD_JWT_REFRESH_TTL_S must be an integer between 3600 and 86400');
    refresh = { refreshTtlS: ttl };
  }
  if (allowedOrigins.length) refresh = { ...refresh, allowedOrigins };
  if (!encoded && !issuer && !audience) return refresh;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !issuer?.trim() || !audience?.trim())
    throw new Error('Dashboard JWT requires DASHBOARD_JWT_SECRET_BASE64, _ISSUER and _AUDIENCE');
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length < 32 || secret.toString('base64') !== encoded)
    throw new Error('DASHBOARD_JWT_SECRET_BASE64 must be canonical base64 of at least 32 bytes');
  return { secret: new Uint8Array(secret), issuer, audience, ...refresh };
}

type SigningKey = Required<Pick<DashboardAuthConfig, 'secret' | 'issuer' | 'audience'>>;

export function assertConfigured(config: DashboardAuthConfig): SigningKey {
  if (!config.secret || !config.issuer || !config.audience)
    throw new AuthError(503, 'auth_unavailable');
  return config as SigningKey;
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

/** What the access token carries; read from the DB at login and again at each refresh. */
interface TokenSubject {
  userId: string;
  role: DashboardRole;
  operatorId?: string;
  staffRole?: StaffRole;
}

interface AccountRow {
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
}

const ACCOUNT_SQL = `SELECT u.id::text AS id,u.email,u.full_name,u.role,u.account_status,u.password_hash,
   (a.user_id IS NOT NULL) AS is_admin,s.operator_id::text AS operator_id,
   o.legal_name AS operator_name,o.status AS operator_status,s.staff_role
 FROM users u LEFT JOIN admins a ON a.user_id=u.id
 LEFT JOIN operator_staff s ON s.user_id=u.id LEFT JOIN operators o ON o.id=s.operator_id`;

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
        await this.db.$client.query<AccountRow>(`${ACCOUNT_SQL} WHERE lower(u.email)=$1`, [email])
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
      const subject: TokenSubject = {
        userId: user.user_id,
        role: user.role,
        ...(staff ? { operatorId: user.operator_id!, staffRole: user.staff_role! } : {}),
      };
      const now = Math.floor(Date.now() / 1000);
      const ttl = this.refreshTtlS;
      const refresh = await new SignJWT({
        token_use: 'refresh',
        ...(staff ? { operator_id: user.operator_id } : {}),
      })
        .setProtectedHeader({ alg: 'HS256', typ: REFRESH_TYP })
        .setSubject(user.user_id)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .setJti(randomUUID())
        .sign(secret);
      return {
        ...(await this.access(subject, now)),
        refresh_token: refresh,
        refresh_expires_in: ttl,
        user,
      };
    } finally {
      done();
    }
  }

  /**
   * T125, contract §2.2b: refresh token → new access token, no new refresh token (not rotated, so
   * the session ends `refreshTtlS` after login). The DB is read again: a locked account or
   * Operator stops the refresh, and role / Operator come from the DB, not from the token.
   */
  async refresh(body: Record<string, unknown>) {
    const { secret, issuer, audience } = assertConfigured(this.config);
    if (Object.keys(body).some((k) => k !== 'refresh_token'))
      throw new AuthError(400, 'invalid_input');
    const token = body['refresh_token'];
    if (typeof token !== 'string' || token.length > 8192 || !JWT_SHAPE.test(token))
      throw new AuthError(401, 'invalid_refresh_token');
    const ttl = this.refreshTtlS;
    let sub: string;
    let operatorClaim: unknown;
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        typ: REFRESH_TYP,
        issuer,
        audience,
        requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
        maxTokenAge: ttl,
        clockTolerance: 0,
      });
      if (
        payload.token_use !== 'refresh' ||
        payload['role'] !== undefined ||
        typeof payload.sub !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(payload.sub) ||
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.iat) ||
        payload.exp! - payload.iat! > ttl
      )
        throw new Error('claims');
      sub = payload.sub;
      operatorClaim = payload['operator_id'];
    } catch {
      throw new AuthError(401, 'invalid_refresh_token');
    }

    const row = (await this.db.$client.query<AccountRow>(`${ACCOUNT_SQL} WHERE u.id=$1`, [sub]))
      .rows[0];
    if (!row) throw new AuthError(401, 'invalid_refresh_token');
    const staff = row.role === 'operator_staff' && row.operator_id !== null;
    const admin = row.role === 'admin' && row.is_admin;
    if (!(staff || admin)) throw new AuthError(403, 'forbidden');
    // Role or Operator changed since login (the claim records staff + Operator) → log in again.
    if (staff ? row.operator_id !== operatorClaim : operatorClaim !== undefined)
      throw new AuthError(401, 'invalid_refresh_token');
    if (row.account_status !== 'active') throw new AuthError(403, 'account_locked');
    if (staff && row.operator_status !== 'active') throw new AuthError(403, 'operator_inactive');
    return this.access(
      {
        userId: row.id,
        role: row.role as DashboardRole,
        ...(staff ? { operatorId: row.operator_id!, staffRole: row.staff_role! } : {}),
      },
      Math.floor(Date.now() / 1000),
    );
  }

  private get refreshTtlS(): number {
    return this.config.refreshTtlS ?? DEFAULT_DASHBOARD_REFRESH_TTL_S;
  }

  private async access(subject: TokenSubject, now: number) {
    const { secret, issuer, audience } = assertConfigured(this.config);
    const token = await new SignJWT({
      role: subject.role,
      ...(subject.operatorId
        ? { operator_id: subject.operatorId, staff_role: subject.staffRole }
        : {}),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject.userId)
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
    };
  }
}
