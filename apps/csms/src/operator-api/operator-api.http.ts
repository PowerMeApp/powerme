/**
 * IOperatorAPI (Report 4 component 02 `operator-api`, ADR-0018) on the console port:
 *   POST /api/auth/v1/login   public, staff and admins (screens 16, 26)
 *   GET  /api/operator/v1/me  operator_staff
 *   GET  /api/operator/v1/faults, POST …/faults/{id}/acknowledge|reset|close  (FE-04a, operator-faults.ts)
 *   GET  /api/admin/v1/me     admin
 * RolesGuard runs before route matching, so an unknown path without a valid token is 401, not 404.
 * CORS: localhost origins only (Vite dev server). JSON: snake_case, string ids, `{ error, detail }`.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Db } from '../db/db.module.js';
import type { DriverApiConfig } from '../driver/driver-auth.js';
import { FaultActionError, type FaultActions } from '../console/fault-actions.js';
import { AuthError, StaffAccounts, type DashboardAuthConfig } from '../users/auth.js';
import { rolesGuard, type Principal } from '../users/roles-guard.js';
import { matchFaultRoute, runFaultRoute } from './operator-faults.js';

/** Paths `ConsoleServer` hands to this listener, before its own `/api/admin/*` routes. */
export const OPERATOR_API_PATH = /^\/api\/(auth|operator|admin)\/v1(?:\/|\?|$)/;

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const BODY_LIMIT = 16 * 1024;

export function createOperatorApiListener(
  db: Db,
  config: DashboardAuthConfig,
  driverConfig?: DriverApiConfig,
  accounts = new StaffAccounts(db, config),
  /** FE-04a. Missing → fault routes answer 503 `faults_unavailable`. */
  faults?: FaultActions,
): RequestListener {
  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof FaultActionError)
        return send(res, error.status, {
          error: error.code,
          detail: error.message,
          ...error.extra,
        });
      if (!(error instanceof AuthError))
        return send(res, 500, { error: 'internal_error', detail: 'Lỗi nội bộ của CSMS' });
      if (error.retryAfterS !== undefined) res.setHeader('Retry-After', String(error.retryAfterS));
      send(res, error.status, { error: error.code, detail: error.code });
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin) {
      if (!LOCAL_ORIGIN.test(origin)) throw new AuthError(403, 'forbidden_origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '', 'http://operator-api.local');
    const [, surface, rest] = /^\/api\/(auth|operator|admin)\/v1(\/.*)?$/.exec(url.pathname) ?? [];
    // Only the fault list takes a query (status, limit); everywhere else a query is 400.
    if (url.search && !/^\/api\/operator\/v1\/faults$/.test(url.pathname))
      throw new AuthError(400, 'invalid_input');

    if (surface === 'auth') {
      if (rest !== '/login') throw new AuthError(404, 'not_found');
      allow(req, res, 'POST');
      const body = await readJsonObject(req, res);
      send(res, 200, await accounts.login(body, req.socket.remoteAddress ?? 'unknown'));
      return;
    }
    if (surface !== 'operator' && surface !== 'admin') throw new AuthError(404, 'not_found');
    const role = surface === 'operator' ? 'operator_staff' : 'admin';
    const principal = await rolesGuard(req, role, db, config, driverConfig);
    const faultRoute =
      surface === 'operator' ? matchFaultRoute(rest ?? '', url.searchParams) : null;
    if (faultRoute) {
      allow(req, res, faultRoute.kind === 'list' ? 'GET' : 'POST');
      if (!faults)
        throw new FaultActionError(503, 'faults_unavailable', 'FaultService chưa được nạp');
      const body =
        faultRoute.kind === 'action' && faultRoute.action === 'reset'
          ? await readJsonObject(req, res)
          : undefined;
      send(res, 200, await runFaultRoute(faultRoute, principal, faults, body));
      return;
    }
    if (rest !== '/me') throw new AuthError(404, 'not_found');
    allow(req, res, 'GET');
    send(res, 200, await me(principal));
  }

  /** The signed-in user, so the dashboard can restore a session after a reload (F2). */
  async function me(p: Principal) {
    const row = (
      await db.$client.query<{ email: string; full_name: string; operator_name: string | null }>(
        `SELECT u.email,u.full_name,o.legal_name AS operator_name FROM users u
         LEFT JOIN operators o ON o.id=$2 WHERE u.id=$1`,
        [p.userId, p.operatorId ?? null],
      )
    ).rows[0]!;
    return {
      user_id: p.userId,
      email: row.email,
      full_name: row.full_name,
      role: p.role,
      ...(p.operatorId
        ? { operator_id: p.operatorId, operator_name: row.operator_name, staff_role: p.staffRole }
        : {}),
    };
  }
}

function allow(req: IncomingMessage, res: ServerResponse, method: string) {
  if (req.method === method) return;
  res.setHeader('Allow', `${method}, OPTIONS`);
  throw new AuthError(405, 'method_not_allowed');
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse) {
  if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(req.headers['content-type'] ?? ''))
    throw new AuthError(415, 'unsupported_media_type');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      res.setHeader('Connection', 'close');
      throw new AuthError(413, 'payload_too_large');
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new AuthError(400, 'invalid_input');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new AuthError(400, 'invalid_input');
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const value = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(value),
  });
  res.end(value);
}
