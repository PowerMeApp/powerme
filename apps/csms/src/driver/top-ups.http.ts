/**
 * T32 Phần 5 — route top-up của app tài xế (WF-02 SD-2a, decisions D2/D8,
 * `docs/api/driver-api.openapi.yaml`). Thay `TopUpController` của CD-2: hàm thuần theo mẫu
 * `charges.http.ts`, không có Nest controller.
 *
 * Tầng này chỉ: khớp đường dẫn + method, kiểm input HTTP (Idempotency-Key, body JSON phẳng, query,
 * id dạng chuỗi), gọi `TopUpService`, đổi kết quả sang snake_case với id dạng chuỗi (hợp đồng §8).
 * Luật nghiệp vụ (BR-P22, BR-P35, một pending, idempotency) nằm hết trong service.
 *
 * CHƯA DÙNG CHO APP tới khi Phần 6 (IPN cộng tiền, trang return) và Phần 8 (quét timeout) merge.
 */
import type { IncomingMessage } from 'node:http';
import { TopUpRejected, type TopUpRejectCode } from '../billing/billing-errors.js';
import type { TopUpQuote, TopUpService, TopUpView } from '../billing/top-up.service.js';
import { clientIp } from '../billing/vnpay.adapter.js';
import { headerKey, safeId } from './charges.http.js';
import { databaseId, DriverApiError } from './driver-auth.js';

const BASE = '/api/driver/v1/billing/top-ups';
const CREATE_FIELDS = ['amount_vnd', 'points_to_redeem'];

type Route = { name: 'create' } | { name: 'quote' } | { name: 'get'; topUpId: string };

const METHOD: Record<Route['name'], 'GET' | 'POST'> = { create: 'POST', quote: 'GET', get: 'GET' };

export function isTopUpPath(path: string): boolean {
  return path === BASE || path.startsWith(`${BASE}/`);
}

/** Method cho phép của một đường dẫn top-up (cho preflight CORS); null nếu không khớp route. */
export function topUpRouteMethod(path: string): 'GET' | 'POST' | null {
  try {
    return METHOD[matchRoute(path).name];
  } catch {
    return null;
  }
}

function matchRoute(path: string): Route {
  if (path === BASE) return { name: 'create' };
  if (path === `${BASE}/quote`) return { name: 'quote' };
  const one = /^\/api\/driver\/v1\/billing\/top-ups\/([^/]+)$/.exec(path);
  if (one) return { name: 'get', topUpId: databaseId(one[1]) };
  throw new DriverApiError(404, 'not_found');
}

function noQuery(q: URLSearchParams, allowed: string[] = []) {
  for (const key of q.keys())
    if (!allowed.includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
}

function createInput(body: Record<string, unknown>): {
  amountVnd: number;
  pointsToRedeem: number;
} {
  for (const key of Object.keys(body))
    if (!CREATE_FIELDS.includes(key)) throw new DriverApiError(400, 'invalid_input');
  const amount = body['amount_vnd'];
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount))
    throw new DriverApiError(400, 'invalid_input');
  const points = body['points_to_redeem'] ?? 0;
  if (typeof points !== 'number' || !Number.isSafeInteger(points) || points < 0)
    throw new DriverApiError(400, 'invalid_input');
  // Ngoài khoảng BR-P22 là lỗi nghiệp vụ (422 amount_out_of_range), service kiểm.
  return { amountVnd: amount, pointsToRedeem: points };
}

export function topUpJson(t: TopUpView) {
  return {
    top_up_id: String(t.topUpId),
    status: t.status,
    amount_vnd: t.amountVnd,
    points_redeemed: t.pointsRedeemed,
    points_discount_vnd: t.pointsDiscountVnd,
    amount_paid_vnd: t.amountPaidVnd,
    created_at: t.createdAt.toISOString(),
    expires_at: t.expiresAt.toISOString(),
    payment_url: t.paymentUrl,
  };
}

function quoteJson(q: TopUpQuote) {
  return {
    points_available: q.pointsAvailable,
    max_points: q.maxPoints,
    max_discount_vnd: q.maxDiscountVnd,
  };
}

/** `TopUpRejected.code` → HTTP (hợp đồng §7). */
const STATUS: Record<TopUpRejectCode, number> = {
  idempotency_conflict: 409,
  account_closed: 409,
  top_up_pending: 409,
  pending_top_up_confirming: 409,
  amount_out_of_range: 422,
  balance_limit_exceeded: 422,
  points_below_minimum: 422,
  points_unavailable: 422,
  points_exceed_cap: 422,
  payment_unconfigured: 503,
  not_found: 404,
};

const DETAIL: Record<TopUpRejectCode, string> = {
  idempotency_conflict: 'Idempotency-Key này đã dùng cho một yêu cầu nạp khác',
  account_closed: 'Tài khoản đã đóng',
  top_up_pending: 'Còn giao dịch nạp chưa thanh toán; có thể tiếp tục thanh toán giao dịch đó',
  pending_top_up_confirming: 'Giao dịch trước đang được xác nhận, thử lại sau ít phút',
  amount_out_of_range: 'Mỗi lần nạp từ 50.000 ₫ đến 2.000.000 ₫',
  balance_limit_exceeded: 'Số dư sau khi nạp không được vượt 5.000.000 ₫',
  points_below_minimum: 'Cần dùng ít nhất 500 điểm',
  points_unavailable: 'Không đủ điểm còn hiệu lực',
  points_exceed_cap: 'Điểm dùng không được vượt 50 % số tiền nạp',
  payment_unconfigured: 'Cổng thanh toán chưa được cấu hình',
  not_found: 'not_found',
};

export function topUpErrorJson(error: TopUpRejected): { status: number; body: unknown } {
  return {
    status: STATUS[error.code],
    body: {
      error: error.code,
      detail: DETAIL[error.code],
      ...(error.extra.topUpId === undefined ? {} : { top_up_id: String(error.extra.topUpId) }),
      ...(error.extra.paymentUrl === undefined ? {} : { payment_url: error.extra.paymentUrl }),
    },
  };
}

export interface TopUpRouteContext {
  req: IncomingMessage;
  path: string;
  q: URLSearchParams;
  driverId: string;
  /** Không có (server dựng không kèm billing, vd test) → 503 payment_unconfigured. */
  topUps?: TopUpService;
  /** Đọc body JSON object (415/413/400 theo mẫu /auth/*). */
  readBody: () => Promise<Record<string, unknown>>;
  setAllow: (methods: string) => void;
}

export async function handleTopUpRoute(
  ctx: TopUpRouteContext,
): Promise<{ status: number; body: unknown }> {
  const route = matchRoute(ctx.path);
  const method = METHOD[route.name];
  if (ctx.req.method !== method) {
    ctx.setAllow(`${method}, OPTIONS`);
    throw new DriverApiError(405, 'method_not_allowed');
  }
  noQuery(ctx.q, route.name === 'quote' ? ['amount_vnd'] : []);
  const driver = safeId(ctx.driverId);
  const ip = clientIp(ctx.req.socket.remoteAddress);
  try {
    switch (route.name) {
      case 'quote': {
        const raw = ctx.q.get('amount_vnd');
        if (raw === null || !/^[0-9]{1,15}$/.test(raw))
          throw new DriverApiError(400, 'invalid_input');
        const service = need(ctx.topUps);
        return { status: 200, body: quoteJson(await service.quote(driver, Number(raw))) };
      }
      case 'create': {
        const key = headerKey(ctx.req);
        const input = createInput(await ctx.readBody());
        const result = await need(ctx.topUps).create(driver, key, input, ip);
        return { status: result.created ? 201 : 200, body: topUpJson(result.topUp) };
      }
      case 'get': {
        const id = safeId(route.topUpId);
        return { status: 200, body: topUpJson(await need(ctx.topUps).get(driver, id, ip)) };
      }
    }
  } catch (error) {
    if (error instanceof TopUpRejected) return topUpErrorJson(error);
    throw error;
  }
}

function need(service: TopUpService | undefined): TopUpService {
  if (!service) throw new TopUpRejected('payment_unconfigured');
  return service;
}
