/**
 * Operator fault API (FE-04a, UC-OPS-03, screen 21; D37–D42) behind RolesGuard `operator_staff`:
 *   GET  /api/operator/v1/faults?status=open|all|raised|acknowledged|resetting|resolved
 *        [&page=1..][&page_size=1..100]   → { items, total, page, page_size }   (contract §2.4)
 *   POST /api/operator/v1/faults/{id}/acknowledge | close     (no body)
 *   POST /api/operator/v1/faults/{id}/reset                   { type: Soft|Hard, force?: boolean }
 * Every call is scoped to the token's Operator (a FaultEvent of another Operator is 404) and records
 * the staff user as actor. Manager and technician may both act (D42). Logic: console/fault-actions.ts.
 */
import { FaultActionError, type FaultActions, type FaultActor } from '../console/fault-actions.js';
import { OFFLINE_ERROR_CODE } from '../stations/faults/error-code-guide.js';
import type {
  FaultListFilter,
  FaultListItem,
  ResetType,
} from '../stations/faults/fault.service.js';
import type { Principal } from '../users/roles-guard.js';

/** Wire types mirrored in packages/shared/src/api/faults.ts (D14: the CSMS does not import it). */
type FaultAction = 'acknowledge' | 'reset' | 'close';

const FAULT_PATH = /^\/faults(?:\/([1-9][0-9]{0,14})\/(acknowledge|reset|close))?$/;
/** Contract §2.4: page from 1, page_size 1–100 (default 50). */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const STATUSES: readonly string[] = [
  'open',
  'all',
  'raised',
  'acknowledged',
  'resetting',
  'resolved',
] satisfies FaultListFilter[];

export type FaultRoute =
  | { kind: 'list'; status: FaultListFilter; page: number; pageSize: number }
  | { kind: 'action'; id: number; action: FaultAction };

/** Matches `rest` (path after /api/operator/v1); null if it is not a fault route. */
export function matchFaultRoute(rest: string, query: URLSearchParams): FaultRoute | null {
  const m = FAULT_PATH.exec(rest);
  if (!m) return null;
  if (m[1]) {
    if ([...query.keys()].length > 0) throw new FaultActionError(400, 'invalid_input', 'query');
    return { kind: 'action', id: Number(m[1]), action: m[2] as FaultAction };
  }
  const keys = [...query.keys()];
  if (
    keys.some((k) => k !== 'status' && k !== 'page' && k !== 'page_size') ||
    new Set(keys).size !== keys.length
  )
    throw new FaultActionError(400, 'invalid_input', 'query');
  const status = query.get('status') ?? 'open';
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    !STATUSES.includes(status) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    throw new FaultActionError(
      400,
      'invalid_input',
      `status=${STATUSES.join('|')}, page=1..${MAX_PAGE}, page_size=1..${MAX_PAGE_SIZE}`,
    );
  return { kind: 'list', status: status as FaultListFilter, page, pageSize };
}

/** Plain decimal, no sign or leading zero; NaN otherwise. */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  return /^(0|[1-9][0-9]{0,5})$/.test(raw) ? Number(raw) : NaN;
}

/** `body` is the parsed JSON object for `reset`, undefined otherwise. Returns the response body. */
export async function runFaultRoute(
  route: FaultRoute,
  principal: Principal,
  actions: FaultActions,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const actor: FaultActor = {
    userId: Number(principal.userId),
    operatorId: Number(principal.operatorId),
  };
  if (route.kind === 'list') {
    const [rows, total] = await Promise.all([
      actions.list(route.status, route.pageSize, actor, (route.page - 1) * route.pageSize),
      actions.count(route.status, actor),
    ]);
    return {
      items: rows.map((f) => toDto(f, actions)),
      total,
      page: route.page,
      page_size: route.pageSize,
    };
  }
  switch (route.action) {
    case 'acknowledge':
      return ids(await actions.acknowledge(route.id, actor));
    case 'close':
      return ids(await actions.close(route.id, actor));
    case 'reset': {
      const { type, force } = resetInput(body);
      const r = await actions.reset(route.id, type, force, actor);
      return {
        fault_id: String(r.fault_id),
        command_id: String(r.command_id),
        reset_status: r.reset_status,
        fault_status: r.fault_status,
        forced: r.forced,
      };
    }
  }
}

function resetInput(body: Record<string, unknown> | undefined) {
  const keys = Object.keys(body ?? {});
  const type = body?.['type'];
  const force = body?.['force'] ?? false;
  if (
    keys.some((k) => k !== 'type' && k !== 'force') ||
    (type !== 'Soft' && type !== 'Hard') ||
    typeof force !== 'boolean'
  )
    throw new FaultActionError(400, 'invalid_input', 'type: Soft|Hard, force?: boolean');
  return { type: type as ResetType, force };
}

function ids(r: { id: number; status: string }) {
  return { id: String(r.id), status: r.status };
}

function toDto(f: FaultListItem, actions: FaultActions) {
  const deadline =
    f.status === 'resetting' && f.resetRequestedAt
      ? new Date(f.resetRequestedAt.getTime() + actions.resetTimeoutS * 1000).toISOString()
      : null;
  return {
    id: String(f.id),
    event_no: f.eventNo,
    kind:
      f.source === 'driver_report'
        ? 'driver_report'
        : f.errorCode === OFFLINE_ERROR_CODE
          ? 'offline'
          : ('faulted' as 'faulted' | 'offline' | 'driver_report'),
    charge_point_serial: f.serial,
    station_name: f.siteName,
    connector_no: f.connectorNo,
    error_code: f.errorCode,
    severity: f.severity,
    hint: f.hint,
    status: f.status,
    raised_at: f.raisedAt.toISOString(),
    acknowledged_at: f.acknowledgedAt?.toISOString() ?? null,
    resolved_at: f.resolvedAt?.toISOString() ?? null,
    reset:
      f.resetCommandId === null
        ? null
        : {
            command_id: String(f.resetCommandId),
            status: f.resetCommandStatus ?? 'pending',
            deadline,
          },
    charge_point_online: f.isOnline,
    /** Driver reports attached to this FaultEvent (F-05). */
    report_count: f.reportCount,
    allowed_actions: actions.allowedActions(f.status),
  };
}
