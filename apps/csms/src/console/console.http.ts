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
  /** WF-04 (FE-04): danh sách cảnh báo và ba hành động của operator. */
  faults(filter: 'open' | 'all', limit: number): Promise<unknown>;
  acknowledgeFault(id: number): Promise<unknown>;
  resetFault(id: number, type: 'Soft' | 'Hard', force: boolean): Promise<unknown>;
  closeFault(id: number): Promise<unknown>;
  /**
   * BE-24 (F-12, FR-13, UC-OPS-05): hàng đợi + quyết định của operator. `operatorUserId` lấy từ
   * thân JSON là TẠM — console chưa có đăng nhập; sẽ thay bằng phiên đăng nhập operator (F-13).
   * Mọi kiểm tra quyền nằm ở service (operator_staff active của operator sở hữu trụ).
   */
  unattributedQueue(limit: number): Promise<unknown>;
  reviewQueue(limit: number): Promise<unknown>;
  assignUnattributed(sessionId: number, input: AssignInput): Promise<unknown>;
  closeUnattributed(sessionId: number, input: CloseInput): Promise<unknown>;
  resolveReview(sessionId: number, input: ResolveInput): Promise<unknown>;
}

export interface AssignInput {
  operatorUserId: number;
  driverId: number;
  note: string;
}
export interface CloseInput {
  operatorUserId: number;
  reason: string;
  note: string;
}
export interface ResolveInput {
  operatorUserId: number;
  resolution: string;
  note: string;
}

/** Thân POST lớn nhất (byte). Ba lệnh BE-24 chỉ mang vài trường ngắn. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Đọc thân JSON của POST. Bắt buộc `Content-Type: application/json`: trình duyệt không gửi được
 * kiểu này sang origin khác mà không preflight, nên đây là thêm một lớp chống CSRF bên cạnh kiểm
 * Origin (không thay thế xác thực).
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    throw new ConsoleError(415, 'unsupported_media_type', 'Thân phải là application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ConsoleError(413, 'payload_too_large', `Thân vượt ${MAX_BODY_BYTES} byte`);
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConsoleError(400, 'bad_request', 'Thân không phải JSON hợp lệ');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConsoleError(400, 'bad_request', 'Thân phải là một object JSON');
  }
  return parsed as Record<string, unknown>;
}

function intField(body: Record<string, unknown>, name: string): number {
  const v = body[name];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw new ConsoleError(400, 'bad_request', `${name} phải là số nguyên dương`);
  }
  return v;
}

function textField(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== 'string') throw new ConsoleError(400, 'bad_request', `${name} phải là chuỗi`);
  return v;
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
        case 'faults':
          return sendJson(res, 200, await backend.faults(route.filter, route.limit), cors);
        case 'faultAcknowledge':
          return sendJson(res, 200, await backend.acknowledgeFault(route.id), cors);
        case 'faultReset':
          return sendJson(
            res,
            200,
            await backend.resetFault(route.id, route.type, route.force),
            cors,
          );
        case 'faultClose':
          return sendJson(res, 200, await backend.closeFault(route.id), cors);
        case 'unattributedQueue':
          return sendJson(res, 200, await backend.unattributedQueue(route.limit), cors);
        case 'reviewQueue':
          return sendJson(res, 200, await backend.reviewQueue(route.limit), cors);
        case 'assignUnattributed': {
          const body = await readJsonBody(req);
          const input: AssignInput = {
            operatorUserId: intField(body, 'operator_user_id'),
            driverId: intField(body, 'driver_id'),
            note: textField(body, 'note'),
          };
          return sendJson(res, 200, await backend.assignUnattributed(route.id, input), cors);
        }
        case 'closeUnattributed': {
          const body = await readJsonBody(req);
          const input: CloseInput = {
            operatorUserId: intField(body, 'operator_user_id'),
            reason: textField(body, 'reason'),
            note: textField(body, 'note'),
          };
          return sendJson(res, 200, await backend.closeUnattributed(route.id, input), cors);
        }
        case 'resolveReview': {
          const body = await readJsonBody(req);
          const input: ResolveInput = {
            operatorUserId: intField(body, 'operator_user_id'),
            resolution: textField(body, 'resolution'),
            note: textField(body, 'note'),
          };
          return sendJson(res, 200, await backend.resolveReview(route.id, input), cors);
        }
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
