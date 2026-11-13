/**
 * Cấu hình VNPay của billing (T32 Phần 5, QA-04). Cùng mẫu `loyalty-policy.config.ts`: đọc env một
 * lần, cấp qua token `VNPAY_CONFIG` trong BillingModule.
 *
 * Thiếu `VNPAY_TMN_CODE` hoặc `VNPAY_HASH_SECRET` thì **không ném** lúc khởi động (dev / test /
 * staging chưa có mã sandbox vẫn chạy), chỉ đặt `configured = false`; tạo top-up khi đó trả 503
 * `payment_unconfigured` và không ghi dòng nào. Không ghi mã thật vào repo (`infra/.env.example`
 * để trống).
 */
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
