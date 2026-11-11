/**
 * Bộ định tuyến THUẦN của bảng điều khiển: (method, url) → route hoặc lỗi HTTP. Không đụng
 * socket, DB hay Nest nên test được từng đường dẫn / mã lỗi bằng spec.
 *
 * Quy ước lỗi: 404 đường dẫn lạ · 405 sai method (kèm danh sách `allow`) · 400 tham số sai
 * (limit/after/id không phải số nguyên hợp lệ). Mọi lỗi có dạng `{error, detail}`.
 */

export type Route =
  | { kind: 'page' }
  | { kind: 'health' }
  | { kind: 'stations' }
  | { kind: 'sessions'; limit: number }
  | { kind: 'session'; id: number }
  | { kind: 'reconciliation'; limit: number }
  | { kind: 'messages'; limit: number; after: number | null }
  | { kind: 'summary' }
  | { kind: 'disconnect'; serial: string }
  | { kind: 'remoteStop'; id: number }
  // WF-04 (FE-04): cảnh báo sự cố và ba hành động của operator (STM-6 t2, t4, t7).
  | { kind: 'faults'; filter: 'open' | 'all'; limit: number }
  | { kind: 'faultAcknowledge'; id: number }
  | { kind: 'faultReset'; id: number; type: 'Soft' | 'Hard'; force: boolean }
  | { kind: 'faultClose'; id: number }
  // BE-24 (F-12, FR-13): hàng đợi và quyết định của operator cho phiên unattributed / review.
  // Thân POST là JSON; operator_user_id trong thân là TẠM (console chưa đăng nhập — F-13).
  | { kind: 'unattributedQueue'; limit: number }
  | { kind: 'reviewQueue'; limit: number }
  | { kind: 'assignUnattributed'; id: number }
  | { kind: 'closeUnattributed'; id: number }
  | { kind: 'resolveReview'; id: number }
  // WF-05 (T119): Admin registry step (UC-ADM-03) and operator onboarding (UC-OPS-01). The body is
  // read by the listener with BE-24's readJsonBody and checked by parse*Body below.
  | { kind: 'registerChargePoint' }
  | { kind: 'onboardChargePoint' };

export interface RouteError {
  status: 400 | 404 | 405;
  error: string;
  detail: string;
  allow?: string[];
}

export type RouteResult = { ok: true; route: Route } | ({ ok: false } & RouteError);

const MAX_LIMIT = 500;

function fail(status: RouteError['status'], error: string, detail: string, allow?: string[]) {
  return { ok: false as const, status, error, detail, ...(allow ? { allow } : {}) };
}

function parseIntParam(
  raw: string | null,
  name: string,
  opts: { min: number; max: number; fallback: number | null },
): { ok: true; value: number | null } | { ok: false; detail: string } {
  if (raw === null || raw === '') return { ok: true, value: opts.fallback };
  if (!/^\d+$/.test(raw)) return { ok: false, detail: `${name} phải là số nguyên không âm` };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) {
    return { ok: false, detail: `${name} phải nằm trong [${opts.min}, ${opts.max}]` };
  }
  return { ok: true, value: n };
}

export function matchRoute(method: string, rawUrl: string): RouteResult {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://console.local');
  } catch {
    return fail(400, 'bad_request', 'URL không hợp lệ');
  }
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const q = url.searchParams;

  const only = (allowed: string[], route: () => RouteResult): RouteResult =>
    allowed.includes(method)
      ? route()
      : fail(405, 'method_not_allowed', `${method} không được hỗ trợ ở ${path}`, allowed);

  const limitRoute = (
    kind: 'sessions' | 'reconciliation' | 'unattributedQueue' | 'reviewQueue',
    fallback: number,
  ): RouteResult => {
    const limit = parseIntParam(q.get('limit'), 'limit', {
      min: 1,
      max: MAX_LIMIT,
      fallback,
    });
    if (!limit.ok) return fail(400, 'bad_request', limit.detail);
    return { ok: true, route: { kind, limit: limit.value as number } };
  };

  if (path === '/') return only(['GET'], () => ({ ok: true, route: { kind: 'page' } }));
  if (path === '/health') return only(['GET'], () => ({ ok: true, route: { kind: 'health' } }));
  if (path === '/api/admin/stations') {
    return only(['GET'], () => ({ ok: true, route: { kind: 'stations' } }));
  }
  if (path === '/api/admin/summary') {
    return only(['GET'], () => ({ ok: true, route: { kind: 'summary' } }));
  }
  if (path === '/api/admin/sessions') return only(['GET'], () => limitRoute('sessions', 50));
  if (path === '/api/admin/reconciliation') {
    return only(['GET'], () => limitRoute('reconciliation', 50));
  }
  if (path === '/api/admin/unattributed') {
    return only(['GET'], () => limitRoute('unattributedQueue', 50));
  }
  if (path === '/api/admin/review') return only(['GET'], () => limitRoute('reviewQueue', 50));
  if (path === '/api/admin/messages') {
    return only(['GET'], () => {
      const limit = parseIntParam(q.get('limit'), 'limit', {
        min: 1,
        max: MAX_LIMIT,
        fallback: 100,
      });
      if (!limit.ok) return fail(400, 'bad_request', limit.detail);
      const after = parseIntParam(q.get('after'), 'after', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        fallback: null,
      });
      if (!after.ok) return fail(400, 'bad_request', after.detail);
      return {
        ok: true,
        route: { kind: 'messages', limit: limit.value as number, after: after.value },
      };
    });
  }

  const sessionMatch =
    /^\/api\/admin\/sessions\/([^/]+)(?:\/(remote-stop|assign-driver|close-unattributed|resolve-review))?$/.exec(
      path,
    );
  if (sessionMatch) {
    const action = sessionMatch[2];
    return only(action !== undefined ? ['POST'] : ['GET'], () => {
      const id = parseIntParam(sessionMatch[1] ?? null, 'id', {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        fallback: null,
      });
      if (!id.ok || id.value === null) {
        return fail(400, 'bad_request', 'id phiên phải là số nguyên dương');
      }
      const kind =
        action === 'remote-stop'
          ? 'remoteStop'
          : action === 'assign-driver'
            ? 'assignUnattributed'
            : action === 'close-unattributed'
              ? 'closeUnattributed'
              : action === 'resolve-review'
                ? 'resolveReview'
                : 'session';
      return { ok: true, route: { kind, id: id.value } };
    });
  }

  if (path === '/api/admin/faults') {
    return only(['GET'], () => {
      const status = q.get('status') ?? 'open';
      if (status !== 'open' && status !== 'all') {
        return fail(400, 'bad_request', 'status phải là open hoặc all');
      }
      const limit = parseIntParam(q.get('limit'), 'limit', {
        min: 1,
        max: MAX_LIMIT,
        fallback: 100,
      });
      if (!limit.ok) return fail(400, 'bad_request', limit.detail);
      return { ok: true, route: { kind: 'faults', filter: status, limit: limit.value as number } };
    });
  }

  const faultMatch = /^\/api\/admin\/faults\/([^/]+)\/(acknowledge|reset|close)$/.exec(path);
  if (faultMatch) {
    return only(['POST'], () => {
      const id = parseIntParam(faultMatch[1] ?? null, 'id', {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        fallback: null,
      });
      if (!id.ok || id.value === null) {
        return fail(400, 'bad_request', 'id sự cố phải là số nguyên dương');
      }
      switch (faultMatch[2]) {
        case 'acknowledge':
          return { ok: true, route: { kind: 'faultAcknowledge', id: id.value } };
        case 'close':
          return { ok: true, route: { kind: 'faultClose', id: id.value } };
        default: {
          const type = q.get('type') ?? 'Soft';
          if (type !== 'Soft' && type !== 'Hard') {
            return fail(400, 'bad_request', 'type phải là Soft hoặc Hard');
          }
          // force=true: operator đã xác nhận lần hai rằng Reset sẽ cắt phiên đang sạc trên trụ.
          const force = q.get('force') ?? 'false';
          if (force !== 'true' && force !== 'false') {
            return fail(400, 'bad_request', 'force phải là true hoặc false');
          }
          return {
            ok: true,
            route: { kind: 'faultReset', id: id.value, type, force: force === 'true' },
          };
        }
      }
    });
  }

  if (path === '/api/admin/charge-points') {
    return only(['POST'], () => ({ ok: true, route: { kind: 'registerChargePoint' } }));
  }
  if (path === '/api/operator/charge-points/onboard') {
    return only(['POST'], () => ({ ok: true, route: { kind: 'onboardChargePoint' } }));
  }

  const stationMatch = /^\/api\/admin\/stations\/([^/]+)\/disconnect$/.exec(path);
  if (stationMatch) {
    return only(['POST'], () => {
      let serial: string;
      try {
        serial = decodeURIComponent(stationMatch[1] ?? '');
      } catch {
        return fail(400, 'bad_request', 'serial không giải mã được');
      }
      if (serial === '') return fail(400, 'bad_request', 'serial rỗng');
      return { ok: true, route: { kind: 'disconnect', serial } };
    });
  }

  return fail(404, 'not_found', `Không có đường dẫn ${path}`);
}

// ---- WF-05 request bodies (T119) ---------------------------------------------------------------
// Shape checks on the snake_case body of the T98 contract (OnboardRequest / RegisterDeviceRequest),
// converted to the service's camelCase input. The business rules (1–2 connectors, connectorNo 1/2,
// role and operator scoping) stay in ChargePointOnboardingService and are not duplicated here.

export type BodyResult<T> = { ok: true; value: T } | ({ ok: false } & RouteError);

const CONNECTOR_TYPES = ['ccs2', 'chademo', 'gbt', 'type2'] as const;
/** OCPP identity = Basic-auth user name (same rule as the service and the T98 contract). */
const SERIAL_RE = /^[A-Za-z0-9._-]{3,48}$/;
/** numeric(7, 2) columns (rated_power_kw, max_power_kw). */
const MAX_KW = 99_999.99;

function badBody(detail: string) {
  return fail(400, 'invalid_input', detail);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(obj).find((k) => !allowed.includes(k)) ?? null;
}

function optionalKw(v: unknown, name: string): BodyResult<number | null | undefined> {
  if (v === undefined || v === null) return { ok: true, value: v };
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_KW) {
    return badBody(`${name} must be a number in (0, ${MAX_KW}]`);
  }
  return { ok: true, value: v };
}

export interface RegisterBody {
  serialNumber: string;
  model?: string | null;
  ratedPowerKw?: number | null;
}

function serialField(v: Record<string, unknown>): BodyResult<string> {
  const serial = v['serial_number'];
  if (typeof serial !== 'string' || !SERIAL_RE.test(serial.trim())) {
    return badBody('serial_number must be 3–48 chars [A-Za-z0-9._-]');
  }
  return { ok: true, value: serial.trim() };
}

/** `POST /api/admin/charge-points` body: `{serial_number, model?, rated_power_kw?}`. */
export function parseRegisterBody(v: unknown): BodyResult<RegisterBody> {
  if (!isPlainObject(v)) return badBody('body must be a JSON object');
  const extra = unknownKey(v, ['serial_number', 'model', 'rated_power_kw']);
  if (extra) return badBody(`unknown field ${extra}`);
  const serial = serialField(v);
  if (!serial.ok) return serial;
  const model = v['model'];
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length > 20)) {
    return badBody('model must be a string of at most 20 characters');
  }
  const kw = optionalKw(v['rated_power_kw'], 'rated_power_kw');
  if (!kw.ok) return kw;
  return {
    ok: true,
    value: {
      serialNumber: serial.value,
      ...(model !== undefined ? { model: model as string | null } : {}),
      ...(kw.value !== undefined ? { ratedPowerKw: kw.value } : {}),
    },
  };
}

export interface OnboardBody {
  serialNumber: string;
  siteId: number;
  connectors: {
    connectorNo: number;
    connectorType?: (typeof CONNECTOR_TYPES)[number];
    maxPowerKw?: number | null;
  }[];
}

/**
 * `POST /api/operator/charge-points/onboard` body:
 * `{serial_number, site_id, connectors: [{connector_no, connector_type?, max_power_kw?}]}`.
 */
export function parseOnboardBody(v: unknown): BodyResult<OnboardBody> {
  if (!isPlainObject(v)) return badBody('body must be a JSON object');
  const extra = unknownKey(v, ['serial_number', 'site_id', 'connectors']);
  if (extra) return badBody(`unknown field ${extra}`);
  const serial = serialField(v);
  if (!serial.ok) return serial;
  const siteId = v['site_id'];
  if (typeof siteId !== 'number' || !Number.isSafeInteger(siteId) || siteId < 1) {
    return badBody('site_id must be a positive integer');
  }
  const list = v['connectors'];
  // Upper bound only to keep the work bounded; the 1–2 rule is the service's (invalid_input).
  if (!Array.isArray(list) || list.length > 8) return badBody('connectors must be an array');
  const connectors: OnboardBody['connectors'] = [];
  for (const c of list) {
    if (!isPlainObject(c)) return badBody('each connector must be a JSON object');
    const bad = unknownKey(c, ['connector_no', 'connector_type', 'max_power_kw']);
    if (bad) return badBody(`unknown connector field ${bad}`);
    const no = c['connector_no'];
    if (typeof no !== 'number' || !Number.isSafeInteger(no)) {
      return badBody('connector_no must be an integer');
    }
    const type = c['connector_type'];
    if (type !== undefined && !CONNECTOR_TYPES.includes(type as (typeof CONNECTOR_TYPES)[number])) {
      return badBody(`connector_type must be one of ${CONNECTOR_TYPES.join(', ')}`);
    }
    const kw = optionalKw(c['max_power_kw'], 'max_power_kw');
    if (!kw.ok) return kw;
    connectors.push({
      connectorNo: no,
      ...(type !== undefined ? { connectorType: type as (typeof CONNECTOR_TYPES)[number] } : {}),
      ...(kw.value !== undefined ? { maxPowerKw: kw.value } : {}),
    });
  }
  return { ok: true, value: { serialNumber: serial.value, siteId, connectors } };
}
