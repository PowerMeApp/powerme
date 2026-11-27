/**
 * Admin billing routes (T32 Phần 10a; UC-ADM-08 Billing Exceptions; WF-02 D1, D4, D10) behind
 * RolesGuard `admin`, under /api/admin/v1:
 *   GET  /billing/exceptions                        → BillingExceptionsQuery.list (200)
 *   POST /billing/e-invoices/{id}/retry             → EInvoiceService.adminRetry (202)
 *   POST /billing/top-ups/{id}/recheck              → TopUpService.recheckTopUp (200)
 *   POST /billing/top-ups/{id}/exception-reviewed   → TopUpService.markExceptionReviewed (200)
 *   POST /billing/payment-conflicts/{id}/review     { note } → TopUpService.markConflictReviewed (200)
 * Refunds are manual (WF-02 D1, D-AC / SRS BR-P51): customer care refunds on the VNPay merchant
 * portal and the Admin records the result; those routes come in a later PR. The repo has no audit
 * table: every Admin action is a structured log line with `admin_id` (as `e_invoice_admin_retry`).
 * Domain errors → `{ error, detail }` here;
 * 401 / 403 / 405 / 415 / 413 come from the router (operator-api.http.ts), like the other routes.
 */
import { Logger } from '@nestjs/common';
import { BillingExceptionsQuery } from '../billing/billing-exceptions.query.js';
import { AdminReviewRejected, EInvoiceNotFound, TopUpRejected } from '../billing/billing-errors.js';
import type { EInvoiceService } from '../billing/e-invoice.service.js';
import { InvalidTransition } from '../billing/invalid-transition.js';
import type { RecheckResult, TopUpService } from '../billing/top-up.service.js';
import { AuthError } from '../users/auth.js';
import type { Principal } from '../users/roles-guard.js';

/** Billing services the routes need (BillingModule, via ConsoleServer). */
export interface AdminBillingDeps {
  topUps: TopUpService;
  eInvoices: EInvoiceService;
}

export type BillingRoute =
  | { kind: 'exceptions' }
  | { kind: 'invoice_retry'; id: number }
  | { kind: 'recheck'; id: number }
  | { kind: 'exception_reviewed'; id: number }
  | { kind: 'conflict_review'; id: number };

type ActionKind = Exclude<BillingRoute['kind'], 'exceptions'>;

const ACTIONS: Record<string, ActionKind> = {
  'e-invoices/retry': 'invoice_retry',
  'top-ups/recheck': 'recheck',
  'top-ups/exception-reviewed': 'exception_reviewed',
  'payment-conflicts/review': 'conflict_review',
};
const ACTION_PATH = /^\/billing\/([a-z-]+)\/([^/]+)\/([a-z-]+)$/;
/** Safe integer, no sign or leading zero (as the fault routes). */
const ID = /^[1-9][0-9]{0,14}$/;
export const REVIEW_NOTE_MAX = 1000;
/** VNPay blocks a repeated querydr (RC 94) for a few minutes (sandbox 16/11, D4). */
const RECHECK_RETRY_AFTER_MINUTES = 15;

/** Matches `rest` (path after /api/admin/v1); null if it is not a billing route. */
export function matchBillingRoute(rest: string): BillingRoute | null {
  if (rest === '/billing/exceptions') return { kind: 'exceptions' };
  const m = ACTION_PATH.exec(rest);
  if (!m) return null;
  const kind = ACTIONS[`${m[1]}/${m[3]}`];
  if (!kind) return null;
  if (!ID.test(m[2]!)) throw new AuthError(400, 'invalid_input');
  return { kind, id: Number(m[2]) };
}

export const billingRouteMethod = (r: BillingRoute) => (r.kind === 'exceptions' ? 'GET' : 'POST');
/** Routes with a JSON body (the others take none and do not read it). */
export const billingRouteHasBody = (r: BillingRoute) => r.kind === 'conflict_review';

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
