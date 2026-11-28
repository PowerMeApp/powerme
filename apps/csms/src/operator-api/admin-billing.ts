/**
 * Admin billing routes (T32 Phần 10a; UC-ADM-08 Billing Exceptions; WF-02 D1, D4, D10) behind
 * RolesGuard `admin`, under /api/admin/v1:
 *   GET  /billing/exceptions                        → BillingExceptionsQuery.list (200)
 *   POST /billing/e-invoices/{id}/retry             → EInvoiceService.adminRetry (202)
 *   POST /billing/top-ups/{id}/recheck              → TopUpService.recheckTopUp (200)
 *   POST /billing/top-ups/{id}/exception-reviewed   → TopUpService.markExceptionReviewed (200)
 *   POST /billing/payment-conflicts/{id}/review     { note } → TopUpService.markConflictReviewed (200)
 * Manual refunds (WF-02 D1, D-AC / SRS BR-P51; SD-2e v3.0): customer care refunds on the VNPay
 * merchant portal, the Admin records the result here:
 *   POST /billing/top-ups/{id}/refund               → TopUpService.refund (202)
 *   POST /billing/top-ups/{id}/late-refund          → TopUpService.refundLatePayment (202)
 *   GET  /billing/refunds[?status=requested|failed] → BillingExceptionsQuery.listRefunds (200)
 *   POST /billing/refunds/{id}/confirm  { gateway_refund_no } → RefundService.confirmDone (200)
 *   POST /billing/refunds/{id}/fail     { reason }            → RefundService.markFailed (200)
 *   POST /billing/refunds/{id}/redo                           → RefundService.redo (200)
 * `Idempotency-Key` on the refund commands is accepted and not stored (as operator-pricing): a
 * repeat is caught by STM-4 / STM-10 and the UNIQUE refund number. The repo has no audit table:
 * every Admin action is a structured log line with `admin_id` (as `e_invoice_admin_retry`).
 * Domain errors → `{ error, detail }` here;
 * 401 / 403 / 405 / 415 / 413 come from the router (operator-api.http.ts), like the other routes.
 */
import { Logger } from '@nestjs/common';
import {
  BillingExceptionsQuery,
  type RefundQueueStatus,
} from '../billing/billing-exceptions.query.js';
import {
  AdminReviewRejected,
  EInvoiceNotFound,
  RefundNotAllowed,
  RefundNotFound,
  RefundNoUsed,
  TopUpRejected,
} from '../billing/billing-errors.js';
import type { EInvoiceService } from '../billing/e-invoice.service.js';
import { InvalidTransition } from '../billing/invalid-transition.js';
import {
  parseFailureReason,
  parseGatewayRefundNo,
  type RefundService,
} from '../billing/refund.service.js';
import type { RecheckResult, RefundDecision, TopUpService } from '../billing/top-up.service.js';
import { AuthError } from '../users/auth.js';
import type { Principal } from '../users/roles-guard.js';

/** Billing services the routes need (BillingModule, via ConsoleServer). */
export interface AdminBillingDeps {
  topUps: TopUpService;
  eInvoices: EInvoiceService;
  refunds: RefundService;
}

export type BillingRoute =
  | { kind: 'exceptions' }
  | { kind: 'invoice_retry'; id: number }
  | { kind: 'recheck'; id: number }
  | { kind: 'exception_reviewed'; id: number }
  | { kind: 'conflict_review'; id: number }
  | { kind: 'refund_top_up'; id: number }
  | { kind: 'refund_late'; id: number }
  | { kind: 'refunds'; statuses: RefundQueueStatus[] }
  | { kind: 'refund_confirm'; id: number }
  | { kind: 'refund_fail'; id: number }
  | { kind: 'refund_redo'; id: number };

type ActionKind = Exclude<BillingRoute['kind'], 'exceptions' | 'refunds'>;

const ACTIONS: Record<string, ActionKind> = {
  'e-invoices/retry': 'invoice_retry',
  'top-ups/recheck': 'recheck',
  'top-ups/exception-reviewed': 'exception_reviewed',
  'payment-conflicts/review': 'conflict_review',
  'top-ups/refund': 'refund_top_up',
  'top-ups/late-refund': 'refund_late',
  'refunds/confirm': 'refund_confirm',
  'refunds/fail': 'refund_fail',
  'refunds/redo': 'refund_redo',
};
const REFUND_QUEUE_STATUSES: readonly RefundQueueStatus[] = ['requested', 'failed'];
const ACTION_PATH = /^\/billing\/([a-z-]+)\/([^/]+)\/([a-z-]+)$/;
/** Safe integer, no sign or leading zero (as the fault routes). */
const ID = /^[1-9][0-9]{0,14}$/;
export const REVIEW_NOTE_MAX = 1000;
/** VNPay blocks a repeated querydr (RC 94) for a few minutes (sandbox 16/11, D4). */
const RECHECK_RETRY_AFTER_MINUTES = 15;

/**
 * Matches `rest` (path after /api/admin/v1); null if it is not a billing route. Only
 * `/billing/refunds` takes a query (`status`, at most once); the router rejects it elsewhere.
 */
export function matchBillingRoute(
  rest: string,
  query: URLSearchParams = new URLSearchParams(),
): BillingRoute | null {
  if (rest === '/billing/exceptions') return { kind: 'exceptions' };
  if (rest === '/billing/refunds') return { kind: 'refunds', statuses: refundStatuses(query) };
  const m = ACTION_PATH.exec(rest);
  if (!m) return null;
  const kind = ACTIONS[`${m[1]}/${m[3]}`];
  if (!kind) return null;
  if (!ID.test(m[2]!)) throw new AuthError(400, 'invalid_input');
  return { kind, id: Number(m[2]) };
}

function refundStatuses(query: URLSearchParams): RefundQueueStatus[] {
  const keys = [...query.keys()];
  if (keys.length === 0) return [...REFUND_QUEUE_STATUSES];
  const status = query.get('status') as RefundQueueStatus;
  if (keys.length !== 1 || keys[0] !== 'status' || !REFUND_QUEUE_STATUSES.includes(status))
    throw new AuthError(400, 'invalid_input');
  return [status];
}

export const billingRouteMethod = (r: BillingRoute) =>
  r.kind === 'exceptions' || r.kind === 'refunds' ? 'GET' : 'POST';
/** Routes with a JSON body (the others take none and do not read it). */
export const billingRouteHasBody = (r: BillingRoute) =>
  r.kind === 'conflict_review' || r.kind === 'refund_confirm' || r.kind === 'refund_fail';

export interface RouteReply {
  status: number;
  body: unknown;
}

const logger = new Logger('AdminBilling');
function log(level: 'log' | 'warn', event: string, fields: Record<string, unknown>) {
  logger[level](JSON.stringify({ event, ...fields }));
}

const err = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) =>
  ({ status, body: { error, detail, ...extra } }) satisfies RouteReply;

/** The body has exactly `key`, a string; returns it (not trimmed). Otherwise 400. */
function onlyString(body: Record<string, unknown> | undefined, key: string): string {
  const keys = Object.keys(body ?? {});
  const value = body?.[key];
  if (keys.length !== 1 || keys[0] !== key || typeof value !== 'string')
    throw new AuthError(400, 'invalid_input');
  return value;
}

export async function runBillingRoute(
  route: BillingRoute,
  principal: Principal,
  deps: AdminBillingDeps,
  exceptions: BillingExceptionsQuery,
  body?: Record<string, unknown>,
): Promise<RouteReply> {
  const adminId = Number(principal.userId);
  switch (route.kind) {
    case 'exceptions':
      return { status: 200, body: await exceptions.list() };
    case 'invoice_retry':
      try {
        const r = await deps.eInvoices.adminRetry(route.id, adminId);
        return {
          status: 202,
          body: {
            e_invoice_id: String(r.eInvoiceId),
            status: r.status,
            attempt_count: r.attemptCount,
          },
        };
      } catch (error) {
        if (error instanceof EInvoiceNotFound) return err(404, 'not_found', 'Không có hoá đơn này');
        if (error instanceof InvalidTransition)
          return err(409, 'invalid_state', 'Chỉ thử lại hoá đơn đang needs_review');
        throw error;
      }
    case 'recheck':
      return recheck(route.id, adminId, deps.topUps);
    case 'exception_reviewed':
      try {
        const r = await deps.topUps.markExceptionReviewed(route.id);
        if (!r.alreadyReviewed)
          log('log', 'top_up_exception_reviewed', {
            top_up_id: route.id,
            admin_id: adminId,
            exception_kind: r.exceptionKind,
          });
        return {
          status: 200,
          body: {
            top_up_id: String(route.id),
            exception_kind: r.exceptionKind,
            exception_reviewed_at: r.reviewedAt.toISOString(),
            already_reviewed: r.alreadyReviewed,
          },
        };
      } catch (error) {
        if (error instanceof AdminReviewRejected)
          return error.reason === 'not_found'
            ? err(404, 'not_found', 'Không có top-up này')
            : err(409, 'no_exception', 'Top-up không có ngoại lệ để đánh dấu đã xem');
        throw error;
      }
    case 'conflict_review': {
      const note = onlyString(body, 'note').trim();
      if (note === '' || note.length > REVIEW_NOTE_MAX) throw new AuthError(400, 'invalid_input');
      try {
        const r = await deps.topUps.markConflictReviewed(route.id, adminId, note);
        log('log', 'payment_conflict_reviewed', {
          conflict_id: route.id,
          admin_id: adminId,
          review_note: note,
        });
        return {
          status: 200,
          body: {
            conflict_id: String(route.id),
            reviewed_at: r.reviewedAt.toISOString(),
            reviewed_by: String(r.reviewedBy),
            review_note: r.reviewNote,
          },
        };
      } catch (error) {
        if (error instanceof AdminReviewRejected)
          return error.reason === 'not_found'
            ? err(404, 'not_found', 'Không có lần trả mâu thuẫn này')
            : err(409, 'already_reviewed', 'Lần trả mâu thuẫn này đã được xử lý');
        throw error;
      }
    }
    case 'refund_top_up':
    case 'refund_late':
      return createRefund(route.kind, route.id, adminId, deps.topUps);
    case 'refunds':
      return { status: 200, body: await exceptions.listRefunds(route.statuses) };
    case 'refund_confirm': {
      const refundNo = parseGatewayRefundNo(onlyString(body, 'gateway_refund_no'));
      if (refundNo === null) throw new AuthError(400, 'invalid_input');
      return refundAction(async () => {
        const r = await deps.refunds.confirmDone(route.id, refundNo, adminId);
        return {
          refund_id: String(r.refundId),
          status: r.status,
          gateway_refund_no: r.gatewayRefundNo,
          completed_at: r.completedAt.toISOString(),
          already_done: r.alreadyDone,
        };
      });
    }
    case 'refund_fail': {
      const reason = parseFailureReason(onlyString(body, 'reason'));
      if (reason === null) throw new AuthError(400, 'invalid_input');
      return refundAction(async () => {
        const r = await deps.refunds.markFailed(route.id, reason, adminId);
        return { refund_id: String(r.refundId), status: r.status, failure_reason: r.failureReason };
      });
    }
    case 'refund_redo':
      return refundAction(async () => {
        const r = await deps.refunds.redo(route.id, adminId);
        return { refund_id: String(r.refundId), status: r.status };
      });
  }
}

/** RefundNotAllowed → HTTP (D1, SD-2e "409 / 422"): balance rule 422, state conflicts 409. */
const REFUND_REJECT: Record<string, { status: number; detail: string }> = {
  not_found: { status: 404, detail: 'Không có top-up này' },
  not_refundable: { status: 409, detail: 'Chỉ hoàn top-up đang credited' },
  account_closed: { status: 409, detail: 'Tài khoản đã đóng' },
  insufficient_available_balance: {
    status: 422,
    detail: 'Số dư khả dụng không đủ để trừ số đã nạp',
  },
  no_late_payment: { status: 409, detail: 'Top-up không có khoản thanh toán trễ' },
  already_requested: { status: 409, detail: 'Khoản trễ này đã có yêu cầu hoàn' },
};

async function createRefund(
  kind: 'refund_top_up' | 'refund_late',
  topUpId: number,
  adminId: number,
  topUps: TopUpService,
): Promise<RouteReply> {
  let r: RefundDecision;
  try {
    r =
      kind === 'refund_top_up'
        ? await topUps.refund(topUpId, adminId)
        : await topUps.refundLatePayment(topUpId, adminId);
  } catch (error) {
    const m = error instanceof RefundNotAllowed ? REFUND_REJECT[error.reason] : undefined;
    if (m) return err(m.status, (error as RefundNotAllowed).reason, m.detail);
    throw error;
  }
  return {
    status: 202,
    body: { refund_id: String(r.refundId), status: r.status, amount_vnd: r.amountVnd },
  };
}

/** Shared errors of confirm / fail / redo (STM-10). */
async function refundAction(run: () => Promise<Record<string, unknown>>): Promise<RouteReply> {
  try {
    return { status: 200, body: await run() };
  } catch (error) {
    if (error instanceof RefundNotFound) return err(404, 'not_found', 'Không có refund này');
    if (error instanceof RefundNoUsed)
      return err(409, 'refund_no_used', 'Mã hoàn này đã được ghi cho một refund khác');
    if (error instanceof InvalidTransition)
      return err(409, 'invalid_transition', 'Refund không ở trạng thái cho phép thao tác này', {
        from: error.from,
      });
    throw error;
  }
}

async function recheck(topUpId: number, adminId: number, topUps: TopUpService) {
  let r: RecheckResult;
  try {
    r = await topUps.recheckTopUp(topUpId);
  } catch (error) {
    if (error instanceof TopUpRejected && error.code === 'payment_unconfigured') {
      log('log', 'top_up_admin_recheck', {
        top_up_id: topUpId,
        admin_id: adminId,
        result: 'payment_unconfigured',
      });
      return err(503, 'payment_unconfigured', 'Chưa cấu hình VNPay');
    }
    throw error;
  }
  log('log', 'top_up_admin_recheck', {
    top_up_id: topUpId,
    admin_id: adminId,
    result: r.result,
    ...('reason' in r && { reason: r.reason }),
  });
  if (r.result === 'not_eligible')
    return r.reason === 'not_found'
      ? err(404, 'not_found', 'Không có top-up này')
      : err(409, 'not_eligible', 'Top-up không đủ điều kiện kiểm tra lại', { reason: r.reason });
  const base = { top_up_id: String(topUpId), result: r.result };
  if (r.result !== 'still_unresolved') return { status: 200, body: base };
  return {
    status: 200,
    body: {
      ...base,
      reason: r.reason,
      ...(r.responseCode !== undefined && { response_code: r.responseCode }),
      ...(r.transactionStatus !== undefined && { transaction_status: r.transactionStatus }),
      retry_after_minutes: RECHECK_RETRY_AFTER_MINUTES,
      hint: `Thử lại sau khoảng ${RECHECK_RETRY_AFTER_MINUTES} phút (VNPay chặn querydr lặp).`,
    },
  };
}
