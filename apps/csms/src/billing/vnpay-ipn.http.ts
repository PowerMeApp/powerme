/**
 * T32 Phần 6 — hai đường dẫn công khai của VNPay (WF-02 SD-2b, decisions D3/D8). Thay
 * `VnpayIpnController` của CD-2: router viết tay theo mẫu `driver/top-ups.http.ts`, không có Nest
 * controller (chưa có RolesGuard; ghi ở `diagrams/README.md` Known differences).
 *
 *   - `GET /billing/vnpay/ipn`: VNPay gọi server-to-server. Không xác thực, chỉ dựa chữ ký (service
 *     kiểm). **Luôn** trả HTTP 200 JSON `{RspCode, Message}`; lỗi bất ngờ → 99 để VNPay gọi lại.
 *   - `GET /billing/vnpay/return`: trình duyệt của tài xế quay về sau khi thanh toán. CHỈ hiển thị
 *     (nguyên tắc 1): không đọc tham số, không kiểm chữ ký, không chạm DB. App poll
 *     `GET /api/driver/v1/billing/top-ups/{id}` để biết kết quả.
 *
 * `ConsoleServer` chuyển MỌI URL `/billing…` (`isVnpayPath`) vào đây, trước nhánh console chưa xác
 * thực; đường dẫn khác hai đường trên → 404, method khác GET → 405.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { ipnReply, IpnReply, TopUpService } from './top-up.service.js';

export const VNPAY_IPN_PATH = '/billing/vnpay/ipn';
export const VNPAY_RETURN_PATH = '/billing/vnpay/return';

/** Mọi URL `/billing`, `/billing/…`, `/billing?…` (khớp trên `req.url`, như mẫu `/api/driver`). */
export function isVnpayPath(url: string): boolean {
  return /^\/billing(?:\/|\?|$)/.test(url);
}

const RETURN_PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PowerMe – Đang xác nhận thanh toán</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 16px;text-align:center;color:#1f2937;background:#fff}h1{font-size:1.25rem}p{color:#4b5563}</style>
</head>
<body>
<h1>Đang xác nhận thanh toán</h1>
<p>Vui lòng quay lại ứng dụng PowerMe. Số dư được cập nhật khi cổng thanh toán xác nhận giao dịch.</p>
</body>
</html>
`;

/**
 * Tách query thành `Record<string,string>`. Tham số xuất hiện hai lần → `null` (không biết VNPay ký
 * giá trị nào; IPN trả 97).
 */
export function parseIpnQuery(search: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of search) {
    if (Object.prototype.hasOwnProperty.call(out, k)) return null;
    out[k] = v;
  }
  return out;
}

export function createVnpayListener(topUps?: TopUpService): RequestListener {
  return (req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.end();
      else if (pathOf(req) === VNPAY_IPN_PATH) sendJson(res, 200, ipnReply('99'));
      else sendJson(res, 500, { error: 'internal_error' });
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '', 'http://billing.local');
    const path = url.pathname;
    if (path !== VNPAY_IPN_PATH && path !== VNPAY_RETURN_PATH) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (path === VNPAY_RETURN_PATH) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(RETURN_PAGE);
      return;
    }
    const params = parseIpnQuery(url.searchParams);
    let reply: IpnReply;
    if (!topUps) reply = ipnReply('99');
    else if (!params) reply = ipnReply('97');
    else reply = await topUps.applyPaymentResult(params);
    sendJson(res, 200, reply);
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '', 'http://billing.local').pathname;
  } catch {
    return '';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
