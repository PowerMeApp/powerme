/**
 * VnpayAdapter (CD-2 «port») — Phần 5: `buildPaymentUrl`; Phần 6: `verifyIpn` (kiểm chữ ký IPN).
 * Đều là hàm THUẦN, không gọi mạng, không đọc DB hay đồng hồ. querydr (Phần 8), refund (Phần 9)
 * thêm sau.
 *
 * URL thanh toán **không lưu DB**: dựng lại từ dòng `top_ups` + cấu hình mỗi lần cần (tạo, gửi lại
 * cùng key, GET), nên `vnp_CreateDate` / `vnp_ExpireDate` lấy từ `created_at` / `expires_at` của
 * dòng; chỉ `vnp_IpAddr` lấy từ request hiện tại.
 *
 * Theo tài liệu VNPay PAY 2.1.0 (sandbox `apis/docs/thanh-toan-pay/pay.html`):
 *   - tham số sắp xếp tăng dần theo tên; chuỗi ký = `key=encode(value)` nối bằng `&`; chữ ký =
 *     HMAC-SHA512 (hex) bằng hash secret, gắn thêm `vnp_SecureHash` (không gửi vnp_SecureHashType);
 *   - tài liệu không ghi quy tắc encode. Mẫu PHP (`urlencode`) và Java (`URLEncoder`) encode giá
 *     trị, dấu cách → `+`; theo PHP: chỉ giữ nguyên `A-Za-z0-9-_.`. `vnp_OrderInfo` chỉ có chữ, số,
 *     dấu cách nên các cách encode chỉ có thể khác nhau ở ký tự của `vnp_ReturnUrl` (`:/?=&`), mà
 *     ba mẫu encode giống nhau;
 *   - `vnp_Amount` = VND × 100; ngày giờ `yyyyMMddHHmmss` theo GMT+7;
 *   - `vnp_TxnRef` Alphanumeric[1,100], không trùng trong ngày (DB: UNIQUE `gateway_reference`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { VNPAY_CONFIG, VnpayConfig } from './vnpay.config.js';

export const VNP_VERSION = '2.1.0';
/** Trang không có bảng danh mục hàng hoá; `other` là giá trị duy nhất thấy trong ví dụ. */
export const VNP_ORDER_TYPE = 'other';
export const VNP_LOCALE = 'vn';

/** Đủ để dựng URL: các cột của dòng `top_ups`. */
export interface PaymentUrlTopUp {
  gatewayReference: string;
  amountPaidVnd: number;
  createdAt: Date;
  expiresAt: Date;
}

export type VnpaySigning = Pick<VnpayConfig, 'tmnCode' | 'hashSecret' | 'payUrl' | 'returnUrl'>;

/** Encode kiểu PHP `urlencode`: chỉ giữ `A-Za-z0-9-_.`, dấu cách → `+`. */
export function vnpEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/** `yyyyMMddHHmmss` theo GMT+7, không phụ thuộc múi giờ của máy chạy. */
export function vnpDate(at: Date): string {
  const t = new Date(at.getTime() + 7 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    String(t.getUTCFullYear()) +
    p(t.getUTCMonth() + 1) +
    p(t.getUTCDate()) +
    p(t.getUTCHours()) +
    p(t.getUTCMinutes()) +
    p(t.getUTCSeconds())
  );
}

/**
 * Ngược của `vnpDate`: `yyyyMMddHHmmss` theo GMT+7 → `Date`. Sai dạng / ngày không có → `null`.
 * Dùng cho `vnp_PayDate` của IPN (tài liệu không ghi múi giờ; theo cùng quy ước `vnp_CreateDate`).
 */
export function parseVnpDate(s: string | undefined): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const utc = Date.UTC(y, mo - 1, d, h, mi, se) - 7 * 3600 * 1000;
  const back = new Date(utc);
  // Date.UTC tự "lăn" ngày sai (vd. 31/02); so lại để từ chối.
  return vnpDate(back) === s ? back : null;
}

/** Chuỗi ký (và cũng là query string trước khi gắn chữ ký): tham số sắp xếp, đã encode. */
export function vnpSignData(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${vnpEncode(k)}=${vnpEncode(params[k]!)}`)
    .join('&');
}

export function vnpSecureHash(signData: string, hashSecret: string): string {
  return createHmac('sha512', hashSecret).update(signData, 'utf8').digest('hex');
}

/** Tham số gửi VNPay cho một top-up (chưa ký). */
export function paymentParams(
  topUp: PaymentUrlTopUp,
  cfg: VnpaySigning,
  ipAddr: string,
): Record<string, string> {
  const amount = topUp.amountPaidVnd * 100;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('invalid_payment_amount');
  if (!/^[A-Za-z0-9]{1,100}$/.test(topUp.gatewayReference))
    throw new Error('invalid_gateway_reference');
  return {
    vnp_Version: VNP_VERSION,
    vnp_Command: 'pay',
    vnp_TmnCode: cfg.tmnCode,
    vnp_Amount: String(amount),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: topUp.gatewayReference,
    vnp_OrderInfo: `Nap tien PowerMe ${topUp.gatewayReference}`,
    vnp_OrderType: VNP_ORDER_TYPE,
    vnp_Locale: VNP_LOCALE,
    vnp_ReturnUrl: cfg.returnUrl,
    vnp_IpAddr: ipAddr,
    vnp_CreateDate: vnpDate(topUp.createdAt),
    vnp_ExpireDate: vnpDate(topUp.expiresAt),
  };
}

/** URL thanh toán đã ký (SD-2a `buildPaymentUrl`). Hàm thuần. */
export function buildPaymentUrl(topUp: PaymentUrlTopUp, cfg: VnpaySigning, ipAddr: string): string {
  const data = vnpSignData(paymentParams(topUp, cfg, ipAddr));
  const sep = cfg.payUrl.includes('?') ? '&' : '?';
  return `${cfg.payUrl}${sep}${data}&vnp_SecureHash=${vnpSecureHash(data, cfg.hashSecret)}`;
}

/** Tham số không đưa vào chuỗi ký của IPN (code mẫu VNPay chỉ bỏ `vnp_SecureHash`). */
const IPN_UNSIGNED = new Set(['vnp_SecureHash', 'vnp_SecureHashType']);

export type IpnSignatureCheck = { ok: true } | { ok: false; reason: 'signature' | 'tmn_code' };

/**
 * Kiểm chữ ký IPN (SD-2b; Phần 6). Theo code mẫu PHP của VNPay: chỉ lấy tham số `vnp_*`, bỏ
 * `vnp_SecureHash` / `vnp_SecureHashType`, sắp tên tăng dần, encode + nối bằng **đúng** `vnpSignData`
 * (cùng hàm ký URL thanh toán), HMAC-SHA512, so sánh thời gian hằng. `vnp_TmnCode` khác cấu hình
 * cũng coi là sai chữ ký (RspCode 97).
 */
export function verifyIpnSignature(
  params: Record<string, string>,
  cfg: Pick<VnpayConfig, 'tmnCode' | 'hashSecret'>,
): IpnSignatureCheck {
  const given = (params['vnp_SecureHash'] ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(given)) return { ok: false, reason: 'signature' };
  const signed: Record<string, string> = {};
  for (const [k, v] of Object.entries(params))
    if (k.startsWith('vnp_') && !IPN_UNSIGNED.has(k)) signed[k] = v;
  const expected = vnpSecureHash(vnpSignData(signed), cfg.hashSecret);
  if (!timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex')))
    return { ok: false, reason: 'signature' };
  if (params['vnp_TmnCode'] !== cfg.tmnCode) return { ok: false, reason: 'tmn_code' };
  return { ok: true };
}

export type IpnResultKind = 'succeeded' | 'unresolved' | 'failed';

/**
 * Phân loại kết quả IPN (D3, chốt Khang + Ân 12–13/11):
 *   - `succeeded` ⇔ `vnp_ResponseCode = 00` **và** `vnp_TransactionStatus = 00`;
 *   - `unresolved` (chưa ngã ngũ, giữ `pending`, querydr Phần 8 hỏi lại): đúng một trong hai mã là
 *     `00` (`oneZero`; code mẫu VNPay dùng HOẶC nên ca này không coi là thất bại), hoặc
 *     `vnp_ResponseCode = 07` (đã trừ tiền, nghi gian lận), hoặc `vnp_TransactionStatus ∈ {01, 04, 07}`
 *     (chưa hoàn tất / giao dịch đảo / nghi gian lận);
 *   - `failed`: còn lại → `PAYMENT_FAILED`.
 */
export function classifyIpn(
  responseCode: string | undefined,
  transactionStatus: string | undefined,
): { kind: IpnResultKind; oneZero: boolean } {
  const rc00 = responseCode === '00';
  const ts00 = transactionStatus === '00';
  if (rc00 && ts00) return { kind: 'succeeded', oneZero: false };
  const oneZero = rc00 !== ts00;
  if (oneZero || responseCode === '07' || ['01', '04', '07'].includes(transactionStatus ?? ''))
    return { kind: 'unresolved', oneZero };
  return { kind: 'failed', oneZero: false };
}

const REF_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Độ dài phần ngẫu nhiên của `vnp_TxnRef` (36^14 ≈ 6·10^21; trùng thì service sinh lại). */
export const GATEWAY_REFERENCE_RANDOM_LEN = 14;

/** `vnp_TxnRef` mới: `PM` + 14 ký tự `[0-9A-Z]` (16 ký tự, chỉ chữ + số). */
export function newGatewayReference(): string {
  const bytes = randomBytes(GATEWAY_REFERENCE_RANDOM_LEN * 2);
  let out = 'PM';
  // Bỏ byte ≥ 252 (= 7 × 36) để không lệch phân bố; 28 byte dư cho 14 ký tự.
  for (const b of bytes) {
    if (out.length === 2 + GATEWAY_REFERENCE_RANDOM_LEN) break;
    if (b < 252) out += REF_ALPHABET[b % 36];
  }
  while (out.length < 2 + GATEWAY_REFERENCE_RANDOM_LEN)
    out += REF_ALPHABET[randomBytes(1)[0]! % 36];
  return out;
}

/**
 * `vnp_IpAddr` từ địa chỉ socket (IPv4 dạng `::ffff:a.b.c.d` → `a.b.c.d`). Chưa tin
 * `X-Forwarded-For`: sau Caddy / tunnel staging đây là IP proxy (ghi ở decisions D2).
 */
export function clientIp(remoteAddress: string | undefined): string {
  const raw = (remoteAddress ?? '').replace(/^::ffff:/i, '');
  return raw.length >= 7 && raw.length <= 45 ? raw : '127.0.0.1';
}

@Injectable()
export class VnpayAdapter {
  constructor(@Inject(VNPAY_CONFIG) private readonly config: VnpayConfig) {}

  /** Có đủ TMN code + hash secret chưa (thiếu → tạo top-up trả 503 payment_unconfigured). */
  get configured(): boolean {
    return this.config.configured;
  }

  buildPaymentUrl(topUp: PaymentUrlTopUp, ipAddr: string): string {
    return buildPaymentUrl(topUp, this.config, ipAddr);
  }

  /** Kiểm chữ ký + `vnp_TmnCode` của IPN. Chỉ gọi khi `configured`. */
  verifyIpn(params: Record<string, string>): IpnSignatureCheck {
    return verifyIpnSignature(params, this.config);
  }
}
