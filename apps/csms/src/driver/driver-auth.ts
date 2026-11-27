import type { IncomingMessage } from 'node:http';
import { jwtVerify } from 'jose';
import type { Db } from '../db/db.module.js';

export interface DriverApiConfig {
  secret?: Uint8Array;
  issuer?: string;
  audience?: string;
  devAuth: boolean;
  searchKey?: string;
  /** Refresh token life in seconds (BE-21, `DRIVER_API_REFRESH_TTL_S`); access tokens stay 900 s. */
  refreshTtlS?: number;
  /**
   * BE-45: CSMS đứng sau Caddy (staging) → lấy IP client từ giá trị CUỐI của X-Forwarded-For (do Caddy
   * thêm, client không giả được) cho bộ khoá đăng nhập theo IP và vnp_IpAddr. Biến `DRIVER_API_TRUST_PROXY`.
   * KHÔNG bật khi Driver API lộ thẳng ra internet: khi đó header do client tự đặt.
   */
  trustProxy?: boolean;
}

/** BE-21: default refresh token life = 30 days; bounds 1 h .. 90 days. */
export const DEFAULT_DRIVER_REFRESH_TTL_S = 30 * 24 * 3600;
const MIN_DRIVER_REFRESH_TTL_S = 3600;
const MAX_DRIVER_REFRESH_TTL_S = 90 * 24 * 3600;

export class DriverApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * BE-49: số trong claim `ver` (so với `users.token_version`, migration 0033). Token phát trước BE-49
 * không có claim → 0, bằng DEFAULT của cột, nên deploy không đăng xuất ai. Sai kiểu → ném lỗi.
 */
export function tokenVersionClaim(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error('ver');
  return raw;
}

export function databaseId(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(raw) ||
    BigInt(raw) > 9223372036854775807n
  )
    throw new DriverApiError(400, 'invalid_input');
  return raw;
}

export function loadDriverApiConfig(env: NodeJS.ProcessEnv): DriverApiConfig {
  const dev = env['DRIVER_API_DEV_AUTH'] ?? 'false';
  if (!['true', 'false'].includes(dev)) throw new Error('Invalid DRIVER_API_DEV_AUTH');
  if (
    dev === 'true' &&
    !(
      (env['NODE_ENV'] === 'test' && env['DRIVER_API_ENV'] === 'test') ||
      (env['NODE_ENV'] === 'development' && env['DRIVER_API_ENV'] === 'local')
    )
  )
    throw new Error('Driver dev auth requires explicit local/test environment');
  const encoded = env['DRIVER_API_JWT_SECRET_BASE64'];
  const issuer = env['DRIVER_API_JWT_ISSUER'];
  const audience = env['DRIVER_API_JWT_AUDIENCE'];
  let secret: Uint8Array | undefined;
  if (encoded || issuer || audience) {
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !issuer?.trim() || !audience?.trim())
      throw new Error('Driver JWT requires secret, issuer and audience');
    secret = Buffer.from(encoded, 'base64');
    if (secret.length < 32 || Buffer.from(secret).toString('base64') !== encoded)
      throw new Error('Driver JWT secret must be canonical base64 of at least 32 random bytes');
  }
  const proxy = env['DRIVER_API_TRUST_PROXY'] ?? 'false';
  if (!['true', 'false'].includes(proxy)) throw new Error('Invalid DRIVER_API_TRUST_PROXY');
  const refreshRaw = env['DRIVER_API_REFRESH_TTL_S'];
  let refreshTtlS = DEFAULT_DRIVER_REFRESH_TTL_S;
  if (refreshRaw !== undefined && refreshRaw !== '') {
    refreshTtlS = /^[1-9][0-9]{0,8}$/.test(refreshRaw) ? Number(refreshRaw) : NaN;
    if (!(refreshTtlS >= MIN_DRIVER_REFRESH_TTL_S && refreshTtlS <= MAX_DRIVER_REFRESH_TTL_S))
      throw new Error('DRIVER_API_REFRESH_TTL_S must be an integer between 3600 and 7776000');
  }
  return {
    secret,
    issuer,
    audience,
    devAuth: dev === 'true',
    searchKey: env['VIETMAP_SEARCH_API_KEY'],
    refreshTtlS,
    trustProxy: proxy === 'true',
  };
}

/** IP của client cho giới hạn đăng nhập và VNPay; xem `DriverApiConfig.trustProxy`. */
export function driverClientIp(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  config: Pick<DriverApiConfig, 'trustProxy'>,
): string {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export async function authenticateDriver(
  req: IncomingMessage,
  db: Db,
  config: DriverApiConfig,
): Promise<string> {
  const authorizationCount = req.rawHeaders.filter(
    (_, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === 'authorization',
  ).length;
  const header = req.headers.authorization;
  let subject: string;
  /** null = đăng nhập dev (X-Driver-Id), không có token để so. */
  let version: number | null = null;
  if (header !== undefined) {
    if (
      authorizationCount !== 1 ||
      header.length > 8192 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header)
    )
      throw new DriverApiError(401, 'unauthorized');
    if (!config.secret || !config.issuer || !config.audience)
      throw new DriverApiError(503, 'auth_unavailable');
    try {
      const { payload } = await jwtVerify(header.slice(7), config.secret, {
        algorithms: ['HS256'],
        typ: 'JWT',
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['sub', 'exp', 'iat', 'role'],
        maxTokenAge: 900,
        clockTolerance: 0,
      });
      subject = databaseId(payload.sub);
      if (
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.iat) ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 900
      )
        throw new DriverApiError(401, 'unauthorized');
      if (payload.role !== 'driver') throw new DriverApiError(403, 'forbidden');
      version = tokenVersionClaim(payload['ver']);
    } catch (error) {
      if (error instanceof DriverApiError && error.status === 403) throw error;
      throw new DriverApiError(401, 'unauthorized');
    }
  } else if (config.devAuth) {
    try {
      subject = databaseId(req.headers['x-driver-id']);
    } catch {
      throw new DriverApiError(401, 'unauthorized');
    }
  } else throw new DriverApiError(401, 'unauthorized');
  // WP3: roles and account state are checked against DB on every request.
  const row = (
    await db.$client.query(
      `SELECT u.role,u.account_status,u.token_version,d.user_id FROM users u LEFT JOIN drivers d ON d.user_id=u.id WHERE u.id=$1`,
      [subject],
    )
  ).rows[0];
  if (!row) throw new DriverApiError(401, 'unauthorized');
  // BE-49: tài xế đã đăng xuất sau khi token này được phát → token chết như hết hạn.
  if (version !== null && row.token_version !== version)
    throw new DriverApiError(401, 'unauthorized');
  if (row.role !== 'driver' || row.account_status !== 'active' || !row.user_id)
    throw new DriverApiError(403, 'forbidden');
  return subject;
}
