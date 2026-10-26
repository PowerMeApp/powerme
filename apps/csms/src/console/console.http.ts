/**
 * Bộ xử lý HTTP (`http.RequestListener`) của bảng điều khiển: nối bộ định tuyến với "backend"
 * (truy vấn + lệnh) và trang HTML. Không phụ thuộc Nest hay DB — backend là interface, nên
 * spec dựng được server thật với backend giả.
 *
 * CHƯA CÓ XÁC THỰC (RolesGuard là việc sau — ADR-0011, package diagram). Hai lớp giảm rủi ro
 * tối thiểu ở đây, không thay thế xác thực:
 *   - host mặc định 127.0.0.1 (cấu hình ở ConsoleServer);
 *   - CORS chỉ mở cho Origin localhost/127.0.0.1/[::1], và POST có header Origin lạ bị từ chối
 *     403 (POST không preflight vẫn gửi được từ trang web bất kỳ — đây là chống CSRF cơ bản).
 *
 * Lỗi luôn là `{error, detail}`; lỗi không lường trước trả 500 với detail chung, chi tiết chỉ
 * vào log (không rò stack trace).
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { CONSOLE_PAGE_HTML } from './console-page.js';
import { matchRoute } from './console.router.js';

/** Lỗi nghiệp vụ có mã HTTP — backend ném, listener dịch ra `{error, detail}`. */
export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

export interface ConsoleBackend {
  /** `select 1` trên DB; ném lỗi nếu DB không trả lời. Dùng cho GET /health. */
  health(): Promise<void>;
  stations(): Promise<unknown>;
  sessions(limit: number): Promise<unknown>;
  session(id: number): Promise<unknown>;
  reconciliation(limit: number): Promise<unknown>;
  messages(limit: number, after: number | null): Promise<unknown>;
  summary(): Promise<unknown>;
  disconnect(serial: string): Promise<unknown>;
  remoteStop(sessionId: number): Promise<unknown>;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string>,
): void {
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  send(res, status, JSON.stringify(body), { ...JSON_HEADERS, ...extra });
}

export function createConsoleListener(backend: ConsoleBackend): RequestListener {
  const logger = new Logger('ConsoleHttp');

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    if (typeof origin === 'string' && LOCAL_ORIGIN.test(origin)) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Vary'] = 'Origin';
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const match = matchRoute(method, req.url ?? '/');
    if (!match.ok) {
      const extra: Record<string, string> = match.allow ? { Allow: match.allow.join(', ') } : {};
      sendJson(
        res,
        match.status,
        { error: match.error, detail: match.detail },
        { ...cors, ...extra },
      );
      return;
    }

    if (
      method === 'POST' &&
      typeof origin === 'string' &&
      cors['Access-Control-Allow-Origin'] === undefined
    ) {
      sendJson(res, 403, { error: 'forbidden_origin', detail: `Origin ${origin} không được phép` });
      return;
    }

    const { route } = match;
    try {
      switch (route.kind) {
        case 'page':
          send(res, 200, CONSOLE_PAGE_HTML, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return;
        case 'health':
          // Tối thiểu có chủ đích: không phiên bản, không chi tiết lỗi DB (chỉ vào log).
          try {
            await backend.health();
          } catch (err) {
            logger.error(
              `health: DB không trả lời: ${err instanceof Error ? err.message : String(err)}`,
            );
            return sendJson(res, 503, { ok: false, db: false }, cors);
          }
          return sendJson(res, 200, { ok: true, db: true }, cors);
        case 'stations':
          return sendJson(res, 200, await backend.stations(), cors);
        case 'sessions':
          return sendJson(res, 200, await backend.sessions(route.limit), cors);
        case 'session':
          return sendJson(res, 200, await backend.session(route.id), cors);
        case 'reconciliation':
          return sendJson(res, 200, await backend.reconciliation(route.limit), cors);
        case 'messages':
          return sendJson(res, 200, await backend.messages(route.limit, route.after), cors);
        case 'summary':
          return sendJson(res, 200, await backend.summary(), cors);
        case 'disconnect':
          return sendJson(res, 200, await backend.disconnect(route.serial), cors);
        case 'remoteStop':
          return sendJson(res, 200, await backend.remoteStop(route.id), cors);
      }
    } catch (err) {
      if (err instanceof ConsoleError) {
        sendJson(res, err.status, { error: err.code, detail: err.message }, cors);
        return;
      }
      logger.error(
        `${method} ${req.url ?? ''} lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 500, { error: 'internal_error', detail: 'Lỗi nội bộ của CSMS' }, cors);
    }
  };

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error(`không trả được phản hồi: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}
