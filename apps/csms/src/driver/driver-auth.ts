import type { IncomingMessage } from 'node:http';
import { jwtVerify } from 'jose';
import type { Db } from '../db/db.module.js';

export interface DriverApiConfig {
  secret?: Uint8Array;
  issuer?: string;
  audience?: string;
  devAuth: boolean;
  searchKey?: string;
}

export class DriverApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
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
  return {
    secret,
    issuer,
    audience,
    devAuth: dev === 'true',
    searchKey: env['VIETMAP_SEARCH_API_KEY'],
  };
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
      `SELECT u.role,u.account_status,d.user_id FROM users u LEFT JOIN drivers d ON d.user_id=u.id WHERE u.id=$1`,
      [subject],
    )
  ).rows[0];
  if (!row) throw new DriverApiError(401, 'unauthorized');
  if (row.role !== 'driver' || row.account_status !== 'active' || !row.user_id)
    throw new DriverApiError(403, 'forbidden');
  return subject;
}
