/**
 * Bộ định tuyến THUẦN của bảng điều khiển: (method, url) → route hoặc lỗi HTTP. Không đụng
 * socket, DB hay Nest nên test được từng đường dẫn / mã lỗi bằng spec.
 *
 * Quy ước lỗi: 404 đường dẫn lạ · 405 sai method (kèm danh sách `allow`) · 400 tham số sai
 * (limit/after/id không phải số nguyên hợp lệ). Mọi lỗi có dạng `{error, detail}`.
 */

export type Route =
  | { kind: 'page' }
  | { kind: 'stations' }
  | { kind: 'sessions'; limit: number }
  | { kind: 'session'; id: number }
  | { kind: 'reconciliation'; limit: number }
  | { kind: 'messages'; limit: number; after: number | null }
  | { kind: 'summary' }
  | { kind: 'disconnect'; serial: string }
  | { kind: 'remoteStop'; id: number };

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

  const limitRoute = (kind: 'sessions' | 'reconciliation', fallback: number): RouteResult => {
    const limit = parseIntParam(q.get('limit'), 'limit', {
      min: 1,
      max: MAX_LIMIT,
      fallback,
    });
    if (!limit.ok) return fail(400, 'bad_request', limit.detail);
    return { ok: true, route: { kind, limit: limit.value as number } };
  };

  if (path === '/') return only(['GET'], () => ({ ok: true, route: { kind: 'page' } }));
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

  const sessionMatch = /^\/api\/admin\/sessions\/([^/]+)(\/remote-stop)?$/.exec(path);
  if (sessionMatch) {
    const isStop = sessionMatch[2] !== undefined;
    return only(isStop ? ['POST'] : ['GET'], () => {
      const id = parseIntParam(sessionMatch[1] ?? null, 'id', {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        fallback: null,
      });
      if (!id.ok || id.value === null) {
        return fail(400, 'bad_request', 'id phiên phải là số nguyên dương');
      }
      return {
        ok: true,
        route: isStop ? { kind: 'remoteStop', id: id.value } : { kind: 'session', id: id.value },
      };
    });
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
