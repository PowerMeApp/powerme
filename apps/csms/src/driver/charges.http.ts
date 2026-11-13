/**
 * BE-22 — route sạc và credit của app tài xế (hợp đồng #69, `docs/api/driver-api.openapi.yaml`).
 *
 * Tầng này chỉ: khớp đường dẫn + method, kiểm input HTTP (header Idempotency-Key, body JSON phẳng,
 * id bigint dạng chuỗi), gọi `DriverChargingService` có sẵn, rồi đổi kết quả sang snake_case với
 * id dạng chuỗi (hợp đồng §8). Luật nghiệp vụ (D4 start intent, BR-P18 giữ trước, BR-P01 dừng,
 * BR-P45 bảng kê) nằm hết trong service. Quyền sở hữu: service luôn lọc theo driver_id lấy từ
 * token, nên id của người khác ra `not_found` (404) — không phân biệt "không có" và "không của bạn".
 */
import type { IncomingMessage } from 'node:http';
import type { Db } from '../db/db.module.js';
import type { ChargeSnapshot, DriverChargingService } from '../sessions/driver-charging.service.js';
import { creditSummary, creditTransactions } from './driver-credit.js';
import { databaseId, DriverApiError } from './driver-auth.js';

const BASE = '/api/driver/v1';
/** Hợp đồng: 8–128 ký tự; service nhận tối đa 100 nên hợp đồng chốt 8–100 (BE-22). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const START_FIELDS = ['connector_id', 'vehicle_id', 'mode', 'energy_limit_wh'];

type Route =
  | { name: 'start' }
  | { name: 'start_status'; key: string }
  | { name: 'progress' | 'stop' | 'statement'; sessionId: string }
  | { name: 'credit' | 'credit_transactions' };

const METHOD: Record<Route['name'], 'GET' | 'POST'> = {
  start: 'POST',
  start_status: 'GET',
  progress: 'GET',
  stop: 'POST',
  statement: 'GET',
  credit: 'GET',
  credit_transactions: 'GET',
};

/** Đường dẫn thuộc nhóm charges/sessions/credit (kể cả dạng sai để trả 400 thay vì 404 chung). */
export function isChargePath(path: string): boolean {
  return (
    path === `${BASE}/charges` ||
    path.startsWith(`${BASE}/charges/`) ||
    path.startsWith(`${BASE}/sessions/`) ||
    path === `${BASE}/credit` ||
    path === `${BASE}/credit/transactions`
  );
}

/** Method cho phép của một đường dẫn charges (cho preflight CORS); null nếu không khớp route. */
export function chargeRouteMethod(path: string): 'GET' | 'POST' | null {
  try {
    return METHOD[matchRoute(path).name];
  } catch {
    return null;
  }
}

function matchRoute(path: string): Route {
  if (path === `${BASE}/charges`) return { name: 'start' };
  if (path === `${BASE}/credit`) return { name: 'credit' };
  if (path === `${BASE}/credit/transactions`) return { name: 'credit_transactions' };
  const charge = new RegExp(`^${BASE}/charges/([^/]+)$`).exec(path);
  if (charge) return { name: 'start_status', key: idempotencyKey(decode(charge[1]!)) };
  const session = new RegExp(`^${BASE}/sessions/([^/]+)/(progress|stop|statement)$`).exec(path);
  if (session)
    return {
      name: session[2] as 'progress' | 'stop' | 'statement',
      sessionId: databaseId(session[1]),
    };
  throw new DriverApiError(404, 'not_found');
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new DriverApiError(400, 'invalid_idempotency_key');
  }
}

function idempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY.test(raw))
    throw new DriverApiError(400, 'invalid_idempotency_key');
  return raw;
}

/** Đúng một header Idempotency-Key (Node nối nhiều header lạ bằng ", " nên phải đếm rawHeaders). */
export function headerKey(req: IncomingMessage): string {
  const count = req.rawHeaders.filter(
    (_, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === 'idempotency-key',
  ).length;
  if (count !== 1) throw new DriverApiError(400, 'invalid_idempotency_key');
  return idempotencyKey(req.headers['idempotency-key']);
}

/** id bigint hợp lệ nhưng vượt số an toàn của JS: không thể là dòng nào service đọc được → 404. */
export function safeId(id: string): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) throw new DriverApiError(404, 'not_found');
  return value;
}

function noQuery(q: URLSearchParams, allowed: string[] = []) {
  for (const key of q.keys())
    if (!allowed.includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
}

const idOrNull = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : String(v);
const intOrNull = (v: number | string | null | undefined) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('integer_out_of_range');
  return n;
};

export function chargeSnapshotJson(s: ChargeSnapshot) {
  return {
    intent_id: String(s.intentId),
    command_id: idOrNull(s.commandId),
    session_id: idOrNull(s.sessionId),
    outcome: s.outcome,
    effect_confirmed: s.effectConfirmed,
    version: s.version,
    max_energy_wh: s.maxEnergyWh,
  };
}

// Hàng `progress` là hàng pg thô (bigint chuỗi); hợp đồng: Wh/VND là số nguyên, id là chuỗi.
function progressJson(row: Record<string, any>) {
  const consumed = intOrNull(row['consumed_wh']);
  const price = intOrNull(row['price_per_kwh_vnd']);
  return {
    session_id: String(row['id']),
    status: row['status'],
    updated_at: row['updated_at'],
    meter_start_wh: intOrNull(row['meter_start_wh']),
    meter_stop_wh: intOrNull(row['meter_stop_wh']),
    energy_wh: intOrNull(row['energy_wh']),
    consumed_wh: consumed,
    telemetry_quality: row['telemetry_quality'],
    limit_value: intOrNull(row['limit_value']),
    reserved_vnd: intOrNull(row['reserved_vnd']),
    // BE-22 (hợp đồng §11 #2): cận trên = ceil(Wh × giá cao nhất hiện hành / 1000), cùng công thức
    // giữ trước BR-P18 và est_cost_vnd_max của /stations. Không phải quyết toán (BR-P45 → statement).
    estimated_cost_vnd:
      consumed === null || price === null ? null : Math.ceil((consumed * price) / 1000),
    billing_review_required: row['billing_review_required'] === true,
    settlement_state: row['settlement_state'] ?? null,
    settlement_reason: row['settlement_reason'] ?? null,
    settlement_retry_at: row['settlement_retry_at'] ?? null,
    // Hàm ước tính thời gian còn lại chưa có (hợp đồng §3, Tuần 9) → luôn null ở BE-22.
    time_left: null,
    charge_point: {
      lifecycle: row['lifecycle'],
      is_online: row['is_online'],
      online_changed_at: row['online_changed_at'] ?? null,
      last_message_at: row['last_message_at'] ?? null,
    },
  };
}

function statementJson(row: Record<string, any>) {
  return {
    session_id: String(row['session_id']),
    driver_id: String(row['driver_id']),
    energy_wh: intOrNull(row['energy_wh']),
    amount_vnd: intOrNull(row['amount_vnd']),
    earned_points: intOrNull(row['earned_points']),
    debit_id: String(row['debit_id']),
    loyalty_entry_id: String(row['loyalty_entry_id']),
    created_at: row['created_at'],
  };
}

function startInput(body: Record<string, unknown>) {
  for (const key of Object.keys(body))
    if (!START_FIELDS.includes(key)) throw new DriverApiError(400, 'invalid_input');
  if (typeof body['mode'] !== 'string') throw new DriverApiError(400, 'invalid_input');
  const limit = body['energy_limit_wh'];
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
    throw new DriverApiError(400, 'invalid_input');
  return {
    connectorId: Number(databaseId(body['connector_id'])),
    vehicleId: Number(databaseId(body['vehicle_id'])),
    // Service tự trả `unsupported_mode` cho mode khác energy_kwh.
    mode: body['mode'] as 'energy_kwh',
    energyLimitWh: limit,
  };
}

export interface ChargeRouteContext {
  req: IncomingMessage;
  path: string;
  q: URLSearchParams;
  driverId: string;
  db: Db;
  service: DriverChargingService;
  /** Đọc body JSON object (415/413/400 theo mẫu /auth/*). */
  readBody: () => Promise<Record<string, unknown>>;
  /** Bỏ body không dùng (POST stop) nhưng vẫn giữ giới hạn kích thước. */
  drainBody: () => Promise<void>;
  setAllow: (methods: string) => void;
}

export async function handleChargeRoute(
  ctx: ChargeRouteContext,
): Promise<{ status: number; body: unknown }> {
  const route = matchRoute(ctx.path);
  const method = METHOD[route.name];
  if (ctx.req.method !== method) {
    ctx.setAllow(`${method}, OPTIONS`);
    throw new DriverApiError(405, 'method_not_allowed');
  }
  noQuery(ctx.q, route.name === 'credit_transactions' ? ['page', 'page_size'] : []);
  const driver = safeId(ctx.driverId);
  switch (route.name) {
    case 'start': {
      const key = headerKey(ctx.req);
      const input = startInput(await ctx.readBody());
      return {
        status: 202,
        body: chargeSnapshotJson(await ctx.service.start(driver, key, input)),
      };
    }
    case 'start_status':
      return {
        status: 200,
        body: chargeSnapshotJson(await ctx.service.getStart(driver, route.key)),
      };
    case 'progress':
      return {
        status: 200,
        body: progressJson(await ctx.service.progress(driver, safeId(route.sessionId))),
      };
    case 'stop': {
      const key = headerKey(ctx.req);
      const sessionId = safeId(route.sessionId);
      await ctx.drainBody();
      const row = (await ctx.service.stop(driver, key, sessionId)) as Record<string, unknown>;
      return {
        status: 202,
        body: {
          command_id: String(row['command_id']),
          command_status: row['command_status'],
          session_status: row['session_status'],
          effect_confirmed: row['effect_confirmed'] === true,
        },
      };
    }
    case 'statement':
      return {
        status: 200,
        body: statementJson(await ctx.service.statement(driver, safeId(route.sessionId))),
      };
    case 'credit':
      return { status: 200, body: await creditSummary(ctx.db, ctx.driverId) };
    case 'credit_transactions':
      return { status: 200, body: await creditTransactions(ctx.db, ctx.driverId, ctx.q) };
  }
}

/**
 * `ChargingError.code` → HTTP (hợp đồng §7). Mã ngoài bảng (đường operator T72, lỗi lạ) → 500 đã
 * làm sạch; không trả mã nội bộ cho app.
 */
const CONFLICT = new Set([
  'idempotency_conflict',
  'credit_unavailable',
  'connector_unavailable',
  'connector_busy_or_unknown',
  'tariff_unavailable',
  'session_not_stoppable',
  'stop_pending_or_unknown',
]);
const BAD_REQUEST = new Set([
  'reserved_idempotency_key',
  'unsupported_mode',
  'vehicle_not_owned_or_incompatible',
]);

export function chargingErrorStatus(code: string): number {
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  if (code === 'policy_unconfigured') return 503;
  if (CONFLICT.has(code)) return 409;
  if (BAD_REQUEST.has(code) || code.startsWith('invalid_')) return 400;
  return 500;
}
