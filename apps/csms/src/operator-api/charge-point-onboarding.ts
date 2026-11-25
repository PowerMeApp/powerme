/**
 * BE-44 — WF-05 routes behind RolesGuard (ADR-0018), thin wrappers over ChargePointOnboardingService:
 *   POST /api/admin/v1/charge-points               admin           UC-ADM-03, STM-3 #1 → 201 RegistryChargePoint
 *   GET  /api/admin/v1/charge-points?lifecycle=&page=&page_size=  admin  UC-ADM-03 → RegistryChargePointPage
 *   POST /api/operator/v1/charge-points/onboard    operator_staff  UC-OPS-01, STM-3 #2 → 201 OnboardResult
 *
 * Same bodies, checks and error codes as the console routes (T119): the body parsers come from
 * console.router.ts, the rules (role, 1–2 connectors, the site must belong to the caller's Operator,
 * 409 serial_not_registered / already_onboarded / serial_already_registered) stay in the service.
 * The acting user is the JWT principal (RolesGuard re-reads role, lock and Operator from the DB),
 * never CONSOLE_ACTOR_*. Manager and technician may both onboard (as for faults, D42).
 * The onboard response carries the Charge Point password once (only the scrypt hash is stored);
 * nothing here logs bodies or error messages, and every response is `Cache-Control: no-store`.
 */
import type { Db } from '../db/db.module.js';
import { parseOnboardBody, parseRegisterBody } from '../console/console.router.js';
import {
  OnboardingError,
  type ChargePointOnboardingService,
} from '../stations/charge-point-onboarding.service.js';
import { AuthError, type DashboardRole } from '../users/auth.js';
import type { Principal } from '../users/roles-guard.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';

const LIFECYCLES: readonly string[] = [
  'registered',
  'awaiting_connection',
  'in_service',
  'disabled',
  'decommissioned',
];

export interface OnboardingRoute {
  kind: 'register' | 'registry' | 'onboard';
  /** RolesGuard surface. */
  role: DashboardRole;
  /** Methods served on this path (405 with this `Allow` otherwise). */
  methods: readonly ('GET' | 'POST')[];
}

/** Full pathname → route, or null when it is not one of the three. Query checked in `run`. */
export function matchOnboardingRoute(pathname: string, method?: string): OnboardingRoute | null {
  if (pathname === '/api/operator/v1/charge-points/onboard')
    return { kind: 'onboard', role: 'operator_staff', methods: ['POST'] };
  if (pathname !== '/api/admin/v1/charge-points') return null;
  return {
    kind: method === 'GET' ? 'registry' : 'register',
    role: 'admin',
    methods: ['GET', 'POST'],
  };
}

export interface OnboardingRouteResult {
  status: number;
  body: unknown;
}

/** Runs after RolesGuard; `body` is the parsed JSON object for POST routes. */
export async function runOnboardingRoute(
  route: OnboardingRoute,
  principal: Principal,
  db: Db,
  query: URLSearchParams,
  service: ChargePointOnboardingService | undefined,
  body?: Record<string, unknown>,
): Promise<OnboardingRouteResult> {
  if (route.kind === 'registry') return { status: 200, body: await listRegistry(db, query) };
  if ([...query.keys()].length) throw new AuthError(400, 'invalid_input');
  if (!service)
    return {
      status: 503,
      body: { error: 'onboarding_unavailable', detail: 'Onboarding service not wired' },
    };
  const actor = Number(principal.userId);
  try {
    if (route.kind === 'register') {
      const input = parseRegisterBody(body);
      if (!input.ok) return { status: 400, body: { error: input.error, detail: input.detail } };
      const r = await service.registerDevice(actor, input.value);
      const row = await registryRows(db, { id: String(r.chargePointId) }, 1, 0);
      return { status: 201, body: row[0] };
    }
    const input = parseOnboardBody(body);
    if (!input.ok) return { status: 400, body: { error: input.error, detail: input.detail } };
    const r = await service.onboard(actor, input.value);
    return {
      status: 201,
      body: {
        charge_point_id: String(r.chargePointId),
        display_code: r.displayCode,
        lifecycle: r.lifecycle,
        ocpp_url: r.ocppUrl,
        identity: r.identity,
        password: r.password,
      },
    };
  } catch (error) {
    if (error instanceof OnboardingError)
      return { status: error.status, body: { error: error.code, detail: error.message } };
    throw error;
  }
}

async function listRegistry(db: Db, query: URLSearchParams) {
  const keys = [...query.keys()];
  if (
    keys.some((k) => !['lifecycle', 'page', 'page_size'].includes(k)) ||
    new Set(keys).size !== keys.length
  )
    throw new AuthError(400, 'invalid_input');
  const lifecycle = query.get('lifecycle');
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (lifecycle !== null && !LIFECYCLES.includes(lifecycle)) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new AuthError(400, 'invalid_input');
  const filter = { lifecycle };
  const total = Number(
    (
      await db.$client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM charge_points cp WHERE ($1::charge_point_lifecycle IS NULL OR cp.lifecycle=$1)`,
        [lifecycle],
      )
    ).rows[0]!.n,
  );
  const items = await registryRows(db, filter, pageSize, (page - 1) * pageSize);
  return { items, total, page, page_size: pageSize };
}

interface RegistryRow {
  id: string;
  serial_number: string;
  display_code: string | null;
  model: string | null;
  firmware_version: string | null;
  rated_power_kw: string | null;
  warranty_until: string | null;
  lifecycle: string;
  is_online: boolean;
  free_vend_tag: string | null;
  operator_id: string | null;
  operator_name: string | null;
  site_id: string | null;
  site_code: string | null;
  site_name: string | null;
  created_at: Date;
}

/** RegistryChargePoint rows, newest first; `id` picks one row (after register). */
async function registryRows(
  db: Db,
  filter: { id?: string; lifecycle?: string | null },
  limit: number,
  offset: number,
) {
  const rows = (
    await db.$client.query<RegistryRow>(
      `SELECT cp.id::text AS id,cp.serial_number,cp.display_code,cp.model,cp.firmware_version,
         cp.rated_power_kw::text AS rated_power_kw,to_char(cp.warranty_until,'YYYY-MM-DD') AS warranty_until,
         cp.lifecycle::text AS lifecycle,cp.is_online,cp.free_vend_tag,
         o.id::text AS operator_id,o.legal_name AS operator_name,
         s.id::text AS site_id,s.site_code,s.site_name,cp.created_at
       FROM charge_points cp LEFT JOIN sites s ON s.id=cp.site_id
       LEFT JOIN operators o ON o.id=s.operator_id
       WHERE ($1::bigint IS NULL OR cp.id=$1) AND ($2::charge_point_lifecycle IS NULL OR cp.lifecycle=$2)
       ORDER BY cp.id DESC LIMIT $3 OFFSET $4`,
      [filter.id ?? null, filter.lifecycle ?? null, limit, offset],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    serial_number: r.serial_number,
    display_code: r.display_code,
    model: r.model,
    firmware_version: r.firmware_version,
    rated_power_kw: r.rated_power_kw === null ? null : Number(r.rated_power_kw),
    warranty_until: r.warranty_until,
    lifecycle: r.lifecycle,
    is_online: r.is_online,
    free_vend_tag: r.free_vend_tag,
    operator: r.operator_id ? { id: r.operator_id, legal_name: r.operator_name } : null,
    site: r.site_id ? { id: r.site_id, site_code: r.site_code, site_name: r.site_name } : null,
    created_at: r.created_at.toISOString(),
  }));
}
