/**
 * Operator session queues (FE-12, screen 23, UC-OPS-05, WF-03) behind RolesGuard `operator_staff`:
 *   GET  /api/operator/v1/sessions?queue=unattributed|review[&page=1..][&page_size=1..100]
 *        → { queue, items, total, page, page_size }
 *   POST /api/operator/v1/sessions/{id}/assign    { driver_id, note }      (F-12, BR-P06/P08)
 *   POST /api/operator/v1/sessions/{id}/close     { reason, note }         (F-12)
 *   POST /api/operator/v1/sessions/{id}/resolve   { resolution, note }     (STM-1 #17)
 *
 * A thin wrapper: all rules (operator scope, row lock, BR-P08 blockers, idempotency, settlement)
 * stay in Trí's services (BE-18 SessionReviewService, BE-24 UnattributedSessionService). The only
 * difference from the console routes is the actor: the token's staff user, never a body field
 * (docs/BE-24-UNATTRIBUTED.md "khi có đăng nhập operator … chỉ cần thay nguồn operatorUserId").
 * Lists are scoped to the token's Operator. Error codes and HTTP statuses are the console's.
 */
import { FaultActionError } from '../console/fault-actions.js';
import { DECISION_DETAIL } from '../console/console.commands.js';
import {
  SessionReviewError,
  type SessionReviewService,
} from '../sessions/session-review.service.js';
import {
  UnattributedSessionError,
  type UnattributedSessionService,
} from '../sessions/unattributed-session.service.js';
import type { Principal } from '../users/roles-guard.js';

export interface SessionQueueDeps {
  review?: SessionReviewService;
  unattributed?: UnattributedSessionService;
}

type Queue = 'unattributed' | 'review';
type SessionAction = 'assign' | 'close' | 'resolve';

export type SessionRoute =
  | { kind: 'list'; queue: Queue; page: number; pageSize: number }
  | { kind: 'action'; id: number; action: SessionAction };

const SESSION_PATH = /^\/sessions(?:\/([1-9][0-9]{0,14})\/(assign|close|resolve))?$/;
/** Contract §2.4: page from 1, page_size 1–100 (default 50). */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/**
 * The services read at most 500 rows per queue (newest first); pages are cut from those. A queue of
 * more than 500 undecided sessions for one Operator is far beyond the pilot, and `total` says 500.
 */
const QUEUE_CAP = 500;

/** Matches `rest` (path after /api/operator/v1); null if it is not a session route. */
export function matchSessionRoute(rest: string, query: URLSearchParams): SessionRoute | null {
  const m = SESSION_PATH.exec(rest);
  if (!m) return null;
  const keys = [...query.keys()];
  if (m[1]) {
    if (keys.length > 0) throw new FaultActionError(400, 'invalid_input', 'query');
    return { kind: 'action', id: Number(m[1]), action: m[2] as SessionAction };
  }
  if (
    keys.some((k) => !['queue', 'page', 'page_size'].includes(k)) ||
    new Set(keys).size !== keys.length
  )
    throw new FaultActionError(400, 'invalid_input', 'query');
  const queue = query.get('queue') ?? 'unattributed';
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (queue !== 'unattributed' && queue !== 'review') ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE) ||
    !(page >= 1 && (page - 1) * pageSize < QUEUE_CAP)
  )
    throw new FaultActionError(
      400,
      'invalid_input',
      `queue=unattributed|review, page_size=1..${MAX_PAGE_SIZE}, page within the first ${QUEUE_CAP} rows`,
    );
  return { kind: 'list', queue, page, pageSize };
}

/** Plain decimal, no sign or leading zero; NaN otherwise. */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  return /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : NaN;
}

/** `body` is the parsed JSON object for actions, undefined for the list. */
export async function runSessionRoute(
  route: SessionRoute,
  principal: Principal,
  deps: SessionQueueDeps,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const operatorId = Number(principal.operatorId);
  const staffId = Number(principal.userId);
  return mapDecisionErrors(async () => {
    if (route.kind === 'list') {
      const rows =
        route.queue === 'unattributed'
          ? (await requireUnattributed(deps).listPending(QUEUE_CAP, operatorId)).map(
              ({ operator_id: _op, station, ...r }) => ({
                ...r,
                session_id: String(r.session_id),
                charge_point_serial: station,
              }),
            )
          : (await requireReview(deps).listInReview(QUEUE_CAP, operatorId)).map(
              ({ operator_id: _op, station, ...r }) => ({
                ...r,
                session_id: String(r.session_id),
                charge_point_serial: station,
              }),
            );
      const from = (route.page - 1) * route.pageSize;
      return {
        queue: route.queue,
        items: rows.slice(from, from + route.pageSize),
        total: rows.length,
        page: route.page,
        page_size: route.pageSize,
      };
    }
    const note = text(body, 'note');
    switch (route.action) {
      case 'assign': {
        const r = await requireUnattributed(deps).assign(route.id, staffId, driverId(body), note);
        return {
          session_id: String(r.sessionId),
          decision: r.decision,
          driver_id: String(r.driverId),
          payment_mode: r.paymentMode,
          already_resolved: r.alreadyResolved,
          records_reviewed: r.recordsReviewed,
          settlement: r.settlement,
        };
      }
      case 'close': {
        const r = await requireUnattributed(deps).close(
          route.id,
          staffId,
          text(body, 'reason'),
          note,
        );
        return {
          session_id: String(r.sessionId),
          decision: r.decision,
          reason: r.reason,
          payment_mode: r.paymentMode,
          already_resolved: r.alreadyResolved,
          records_reviewed: r.recordsReviewed,
        };
      }
      case 'resolve': {
        const r = await requireReview(deps).resolveReview(
          route.id,
          staffId,
          text(body, 'resolution'),
          note,
        );
        return {
          session_id: String(r.sessionId),
          status: r.status,
          records_reviewed: r.recordsReviewed,
          settlement: r.settlement,
        };
      }
    }
  });
}

/** The field must be a string; the service checks its content (codes, note 1–500 characters). */
function text(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string') throw new FaultActionError(400, 'invalid_input', field);
  return value;
}

/** `driver_id` as a string id (contract) or a positive integer. */
function driverId(body: Record<string, unknown> | undefined): number {
  const value = body?.['driver_id'];
  if (typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value)) return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new FaultActionError(400, 'invalid_input', 'driver_id');
}

function requireUnattributed(deps: SessionQueueDeps): UnattributedSessionService {
  if (!deps.unattributed)
    throw new FaultActionError(
      503,
      'sessions_unavailable',
      'UnattributedSessionService chưa được nạp',
    );
  return deps.unattributed;
}

function requireReview(deps: SessionQueueDeps): SessionReviewService {
  if (!deps.review)
    throw new FaultActionError(503, 'sessions_unavailable', 'SessionReviewService chưa được nạp');
  return deps.review;
}

/** Same mapping as ConsoleCommands: 400 · 403 · 404 · 422 driver_not_eligible · 409 the rest. */
async function mapDecisionErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SessionReviewError || err instanceof UnattributedSessionError) {
      const status =
        err.code === 'invalid_input'
          ? 400
          : err.code === 'forbidden'
            ? 403
            : err.code === 'not_found'
              ? 404
              : err.code === 'driver_not_eligible'
                ? 422
                : 409;
      throw new FaultActionError(status, err.code, DECISION_DETAIL[err.code]);
    }
    throw err;
  }
}
