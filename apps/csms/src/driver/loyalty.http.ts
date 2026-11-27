/**
 * T149 — route điểm thưởng của app tài xế (UC-PAY-04, SRS màn hình 15; WF-02 D11,
 * `docs/api/driver-api.openapi.yaml`). Hàm thuần theo mẫu `top-ups.http.ts`, không Nest controller.
 *
 * - `GET /loyalty`: tóm tắt từ `LoyaltyService.summary` (phát lại lô tại `now()` của DB, không đọc
 *   `points_balance`), nên `points_available` bằng số của quote top-up.
 * - `GET /loyalty/transactions`: dòng thô `loyalty_transactions`, phân trang như `/credit/transactions`.
 *
 * Mỗi request đọc trong **một** transaction `REPEATABLE READ READ ONLY`: tài khoản, sổ và `count`
 * cùng một snapshot, `now()` cố định = `as_of`. Sổ hỏng (`LoyaltyLedgerCorrupt`) → log error có cấu
 * trúc rồi 500 đã làm sạch; không trả số đoán.
 */
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { LoyaltyLedgerCorrupt } from '../billing/billing-errors.js';
import type { LoyaltyService } from '../billing/loyalty.service.js';
import type { Db } from '../db/db.module.js';
import { safeId } from './charges.http.js';
import { DriverApiError } from './driver-auth.js';

const BASE = '/api/driver/v1/loyalty';
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;

type Route = 'summary' | 'transactions';

const logger = new Logger('DriverLoyalty');

export function isLoyaltyPath(path: string): boolean {
  return path === BASE || path.startsWith(`${BASE}/`);
}

function matchRoute(path: string): Route {
  if (path === BASE) return 'summary';
  if (path === `${BASE}/transactions`) return 'transactions';
  throw new DriverApiError(404, 'not_found');
}

function onlyQuery(q: URLSearchParams, allowed: string[]) {
  for (const key of q.keys())
    if (!allowed.includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
}

/** Cùng luật với `pageParam` của `/credit/transactions`. */
function pageParam(q: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = q.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) > max)
    throw new DriverApiError(400, 'invalid_input');
  return Number(raw);
}

/** Một transaction chỉ đọc, REPEATABLE READ: mọi câu trong `work` thấy cùng một snapshot. */
async function readSnapshot<T>(db: Db, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.$client.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

export interface LoyaltyRouteContext {
  req: IncomingMessage;
  path: string;
  q: URLSearchParams;
  driverId: string;
  db: Db;
  /** Không có (server dựng không kèm billing) → 503 loyalty_unavailable. */
  loyalty?: LoyaltyService;
  setAllow: (methods: string) => void;
}

export async function handleLoyaltyRoute(
  ctx: LoyaltyRouteContext,
): Promise<{ status: number; body: unknown }> {
  const route = matchRoute(ctx.path);
  if (ctx.req.method !== 'GET') {
    ctx.setAllow('GET, OPTIONS');
    throw new DriverApiError(405, 'method_not_allowed');
  }
  onlyQuery(ctx.q, route === 'transactions' ? ['page', 'page_size'] : []);
  const page = route === 'transactions' ? pageParam(ctx.q, 'page', 1, MAX_PAGE) : 1;
  const pageSize = route === 'transactions' ? pageParam(ctx.q, 'page_size', 20, MAX_PAGE_SIZE) : 20;
  const loyalty = ctx.loyalty;
  if (!loyalty) throw new DriverApiError(503, 'loyalty_unavailable');
  const driver = safeId(ctx.driverId);

  if (route === 'transactions') {
    const r = await readSnapshot(ctx.db, (c) => loyalty.history(c, driver, page, pageSize));
    return {
      status: 200,
      body: {
        items: r.items.map((i) => ({
          transaction_id: i.id,
          entry_no: i.entryNo,
          transaction_type: i.type,
          points: i.points,
          expires_at: i.expiresAt?.toISOString() ?? null,
          session_id: i.sessionId,
          top_up_id: i.topUpId,
          created_at: i.createdAt.toISOString(),
        })),
        total: r.total,
        page,
        page_size: pageSize,
      },
    };
  }

  try {
    const s = await readSnapshot(ctx.db, (c) => loyalty.summary(c, driver));
    return {
      status: 200,
      body: {
        status: s.status,
        points_available: s.pointsAvailable,
        points_expiring_soon: s.pointsExpiringSoon,
        expiring_within_days: s.expiringWithinDays,
        expiring_soon: s.expiringSoon.map((l) => ({
          expires_at: l.expiresAt.toISOString(),
          points: l.points,
        })),
        points_earned_total: s.pointsEarnedTotal,
        points_redeemed_total: s.pointsRedeemedTotal,
        as_of: s.asOf.toISOString(),
      },
    };
  } catch (error) {
    if (!(error instanceof LoyaltyLedgerCorrupt)) throw error;
    logger.error(
      JSON.stringify({
        event: 'driver_loyalty_ledger_corrupt',
        reason: error.reason,
        entry_no: error.entryNo,
        driver_id: driver,
      }),
    );
    return { status: 500, body: { error: 'internal_error', detail: 'Lỗi nội bộ của CSMS' } };
  }
}
