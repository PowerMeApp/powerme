/**
 * Cấu hình VNPay của billing (T32 Phần 5, QA-04). Cùng mẫu `loyalty-policy.config.ts`: đọc env một
 * lần, cấp qua token `VNPAY_CONFIG` trong BillingModule.
 *
 * Thiếu `VNPAY_TMN_CODE` hoặc `VNPAY_HASH_SECRET` thì **không ném** lúc khởi động (dev / test /
 * staging chưa có mã sandbox vẫn chạy), chỉ đặt `configured = false`; tạo top-up khi đó trả 503
 * `payment_unconfigured` và không ghi dòng nào. Không ghi mã thật vào repo (`infra/.env.example`
 * để trống).
 */
import { isIP } from 'node:net';

export const VNPAY_CONFIG = Symbol('BILLING_VNPAY_CONFIG');

export const VNPAY_SANDBOX_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
/** D8: return URL chỉ để hiển thị (route có từ Phần 6). */
export const VNPAY_DEFAULT_RETURN_URL = 'http://localhost:3000/billing/vnpay/return';

export interface VnpayConfig {
  configured: boolean;
  tmnCode: string;
  hashSecret: string;
  payUrl: string;
  returnUrl: string;
}

export function loadVnpayConfig(env: NodeJS.ProcessEnv = process.env): VnpayConfig {
  const tmnCode = (env['VNPAY_TMN_CODE'] ?? '').trim();
  const hashSecret = (env['VNPAY_HASH_SECRET'] ?? '').trim();
  const payUrl = (env['VNPAY_URL'] ?? '').trim() || VNPAY_SANDBOX_URL;
  const returnUrl = (env['VNPAY_RETURN_URL'] ?? '').trim() || VNPAY_DEFAULT_RETURN_URL;
  for (const [name, value] of [
    ['VNPAY_URL', payUrl],
    ['VNPAY_RETURN_URL', returnUrl],
  ] as const) {
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`invalid_vnpay_config: ${name} phải là URL http(s)`);
  }
  return {
    configured: tmnCode !== '' && hashSecret !== '',
    tmnCode,
    hashSecret,
    payUrl,
    returnUrl,
  };
}

/**
 * Cấu hình gọi API querydr (T32 Phần 8). Tách khỏi `VnpayConfig` để cấu hình thanh toán / IPN của
 * Phần 5–6 giữ nguyên hình dạng; cấp qua token `VNPAY_API_CONFIG`.
 *
 * - `VNPAY_API_URL`: endpoint POST JSON (tài liệu `truy-van-hoan-tien/querydr&refund.html`), trống =
 *   sandbox; phải là URL http(s).
 * - `VNPAY_SERVER_IP`: `vnp_IpAddr` của querydr = "IP của máy chủ gọi API"; trống = `127.0.0.1`. Nếu
 *   VNPay kiểm IP thì querydr sẽ không ngã ngũ (decisions "Còn mở", chờ thử sandbox).
 */
export const VNPAY_API_CONFIG = Symbol('BILLING_VNPAY_API_CONFIG');

export const VNPAY_SANDBOX_API_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
export const VNPAY_DEFAULT_SERVER_IP = '127.0.0.1';

export interface VnpayApiConfig {
  apiUrl: string;
  serverIp: string;
}

export const DEFAULT_VNPAY_API_CONFIG: VnpayApiConfig = {
  apiUrl: VNPAY_SANDBOX_API_URL,
  serverIp: VNPAY_DEFAULT_SERVER_IP,
};

export function loadVnpayApiConfig(env: NodeJS.ProcessEnv = process.env): VnpayApiConfig {
  const apiUrl = (env['VNPAY_API_URL'] ?? '').trim() || VNPAY_SANDBOX_API_URL;
  const serverIp = (env['VNPAY_SERVER_IP'] ?? '').trim() || VNPAY_DEFAULT_SERVER_IP;
  let ok = false;
  try {
    ok = ['http:', 'https:'].includes(new URL(apiUrl).protocol);
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('invalid_vnpay_config: VNPAY_API_URL phải là URL http(s)');
  if (isIP(serverIp) === 0) {
    throw new Error('invalid_vnpay_config: VNPAY_SERVER_IP phải là địa chỉ IP');
  }
  return { apiUrl, serverIp };
}
