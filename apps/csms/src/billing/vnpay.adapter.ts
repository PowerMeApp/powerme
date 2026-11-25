/**
 * VnpayAdapter (CD-2 «port») — Phần 5: `buildPaymentUrl`; Phần 6: `verifyIpn` (kiểm chữ ký IPN);
 * Phần 8: `queryTransaction` (querydr); Phần 9a: `refund`, `queryRefundState`. Phần dựng / kiểm là
 * hàm THUẦN (không gọi mạng, không đọc DB hay đồng hồ); lớp `VnpayAdapter` chỉ bọc cấu hình và HTTP.
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
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_VNPAY_API_CONFIG,
  VNPAY_API_CONFIG,
  VNPAY_CONFIG,
  VnpayApiConfig,
  VnpayConfig,
} from './vnpay.config.js';

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

// ---------------------------------------------------------------------------------------------
// querydr (T32 Phần 8, SD-2d) — tài liệu `truy-van-hoan-tien/querydr&refund.html` (đọc 14/11):
//   - POST JSON tới `VNPAY_API_URL`; `vnp_RequestId` Alphanumeric[1,32], không trùng trong ngày;
//   - chuỗi ký request / response: các giá trị nối bằng `|` theo THỨ TỰ CỐ ĐỊNH của tài liệu, không
//     sắp xếp, không encode (tài liệu không ghi encode); HMAC-SHA512 như PAY 2.1.0;
//   - trường tuỳ chọn của response (`vnp_PayDate`, `vnp_PromotionCode`, `vnp_PromotionAmount`) thiếu
//     thì đưa chuỗi rỗng vào chuỗi ký (thử sandbox 16/11: RC `00` và `91` đều khớp);
//   - `vnp_Amount` của response là VND × 100 như IPN (thử sandbox 16/11).
// T32 Phần 8b: `paid` mang số VNPay thực trừ (`amount`, VND); việc so với `amount_paid_vnd` làm ở
// `TopUpService.applyLockedResult` (dưới khoá), không ở đây.
// ---------------------------------------------------------------------------------------------

/** Thứ tự chuỗi ký request querydr (tài liệu VNPay). */
export const QUERYDR_REQUEST_SIGN_FIELDS = [
  'vnp_RequestId',
  'vnp_Version',
  'vnp_Command',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_TransactionDate',
  'vnp_CreateDate',
  'vnp_IpAddr',
  'vnp_OrderInfo',
] as const;

/** Thứ tự chuỗi ký response querydr (tài liệu VNPay). */
export const QUERYDR_RESPONSE_SIGN_FIELDS = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
  'vnp_PromotionCode',
  'vnp_PromotionAmount',
] as const;

/** Timeout của một lần querydr (D4: 10 s). */
export const QUERYDR_TIMEOUT_MS = 10_000;

function joinFields(fields: readonly string[], values: Record<string, unknown>): string {
  return fields.map((f) => (typeof values[f] === 'string' ? (values[f] as string) : '')).join('|');
}

export function querydrRequestSignData(params: Record<string, string>): string {
  return joinFields(QUERYDR_REQUEST_SIGN_FIELDS, params);
}

export function querydrResponseSignData(body: Record<string, unknown>): string {
  return joinFields(QUERYDR_RESPONSE_SIGN_FIELDS, body);
}

/** `vnp_RequestId` mới: 32 ký tự hex ngẫu nhiên (trùng trong ngày gần như không xảy ra). */
export function newQuerydrRequestId(): string {
  return randomBytes(16).toString('hex');
}

/** Đủ để hỏi querydr: các cột của dòng `top_ups`. */
export interface QueryTopUp {
  gatewayReference: string;
  /** `top_ups.created_at` — `vnp_TransactionDate` = `vnp_CreateDate` của lệnh pay. */
  createdAt: Date;
}

/** Body JSON đã ký của một querydr. Hàm thuần: `now`, `requestId` do bên gọi đưa vào. */
export function querydrRequest(
  topUp: Pick<QueryTopUp, 'gatewayReference' | 'createdAt'>,
  cfg: Pick<VnpayConfig, 'tmnCode' | 'hashSecret'> & Pick<VnpayApiConfig, 'serverIp'>,
  now: Date,
  requestId: string,
): Record<string, string> {
  if (!/^[A-Za-z0-9]{1,100}$/.test(topUp.gatewayReference))
    throw new Error('invalid_gateway_reference');
  if (!/^[A-Za-z0-9]{1,32}$/.test(requestId)) throw new Error('invalid_request_id');
  const params: Record<string, string> = {
    vnp_RequestId: requestId,
    vnp_Version: VNP_VERSION,
    vnp_Command: 'querydr',
    vnp_TmnCode: cfg.tmnCode,
    vnp_TxnRef: topUp.gatewayReference,
    vnp_TransactionDate: vnpDate(topUp.createdAt),
    vnp_CreateDate: vnpDate(now),
    vnp_IpAddr: cfg.serverIp,
    // Chỉ chữ, số, dấu cách: chuỗi ký không encode.
    vnp_OrderInfo: `Truy van giao dich ${topUp.gatewayReference}`,
  };
  return {
    ...params,
    vnp_SecureHash: vnpSecureHash(querydrRequestSignData(params), cfg.hashSecret),
  };
}

export type QueryUnresolvedReason =
  | 'malformed'
  | 'signature'
  | 'tmn_code'
  | 'txn_ref'
  | 'response_code'
  | 'transaction_type'
  | 'transaction_status'
  | 'network'
  | 'timeout'
  | 'http_status';

/**
 * Mã / câu thô của một response querydr CHƯA xác thực (sai / thiếu chữ ký, `vnp_TmnCode` hay
 * `vnp_TxnRef` khác), ví dụ để phân biệt RC `94` với `99` (thử sandbox 16/11).
 *
 * RC chưa xác thực chỉ để log, ngoại lệ duy nhất: 94 ở mốc +60 để hẹn thêm một lần querydr (D4, T32
 * Phần 8c). Không bao giờ dùng để phân loại kết quả hay ghi gì vào DB.
 */
export interface UnverifiedResponseInfo {
  responseCode?: string;
  message?: string;
  hasSecureHash: boolean;
}

/** Kết quả querydr đã phân loại (bảng 3.1, Ân 12/11). */
export type QueryResult =
  | {
      kind: 'paid';
      transactionNo: string;
      /** Số VNPay thực trừ, **VND** (`vnp_Amount / 100`, luôn nguyên). */
      amount: number;
      payDate: Date | null;
    }
  | { kind: 'failed'; responseCode: string; transactionStatus: string }
  | { kind: 'not_found' }
  | {
      kind: 'unresolved';
      reason: QueryUnresolvedReason;
      responseCode?: string;
      transactionStatus?: string;
      /** Chỉ có khi `queryTransaction` gắn vào, cho lý do `signature` / `tmn_code` / `txn_ref`. */
      unverified?: UnverifiedResponseInfo;
    };

/** Độ dài tối đa của mã / câu thô chưa xác thực đưa vào log. */
export const UNVERIFIED_FIELD_MAX = 200;

/**
 * Lấy `vnp_ResponseCode` / `vnp_Message` thô (chuỗi hoặc số hữu hạn, cắt ≤ 200 ký tự) và có trường
 * `vnp_SecureHash` hay không. Không đọc giá trị chữ ký. Hàm thuần.
 */
export function unverifiedResponseInfo(body: unknown): UnverifiedResponseInfo {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { hasSecureHash: false };
  const b = body as Record<string, unknown>;
  const raw = (k: string): string | undefined => {
    const v = b[k];
    if (typeof v === 'string') return v.slice(0, UNVERIFIED_FIELD_MAX);
    if (typeof v === 'number' && Number.isFinite(v))
      return String(v).slice(0, UNVERIFIED_FIELD_MAX);
    return undefined;
  };
  const responseCode = raw('vnp_ResponseCode');
  const message = raw('vnp_Message');
  return {
    ...(responseCode !== undefined && { responseCode }),
    ...(message !== undefined && { message }),
    hasSecureHash: b['vnp_SecureHash'] !== undefined && b['vnp_SecureHash'] !== null,
  };
}

const UNVERIFIED_REASONS: ReadonlySet<QueryUnresolvedReason> = new Set([
  'signature',
  'tmn_code',
  'txn_ref',
]);

/**
 * Chuẩn hoá body JSON của VNPay về chuỗi trước khi ký / đọc: null / undefined = thiếu (chuỗi rỗng
 * trong chuỗi ký), số hữu hạn → `String(v)`; object / array / boolean / số không hữu hạn → `null`.
 */
function normalizeVnpBody(body: unknown): Record<string, string> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') r[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) r[k] = String(v);
    else return null;
  }
  return r;
}

/** So `vnp_SecureHash` của response với chuỗi ký, thời gian hằng. */
function signatureMatches(
  r: Record<string, string>,
  signData: string,
  hashSecret: string,
): boolean {
  const given = (r['vnp_SecureHash'] ?? '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(given)) return false;
  const expected = vnpSecureHash(signData, hashSecret);
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Kiểm + phân loại response querydr (hàm thuần, không log). Thứ tự: dạng body (chuẩn hoá giá trị
 * về chuỗi) → chữ ký (thời gian hằng) → `vnp_TmnCode` → `vnp_TxnRef` → RC `91` (`not_found`) →
 * RC ≠ `00` → `vnp_TransactionType` ≠ `01` → TS `00` (kiểm dạng `vnp_TransactionNo`, `vnp_Amount`
 * chia hết cho 100) / `02` / khác. Mọi ca không tin được → `unresolved` (giữ `pending`, hẹn lại).
 * Không so số tiền: `paid` mang số thực trừ, `TopUpService` so dưới khoá (T32 Phần 8b).
 */
export function classifyQuerydrResponse(
  body: unknown,
  expect: { tmnCode: string; txnRef: string },
  hashSecret: string,
): QueryResult {
  const r = normalizeVnpBody(body);
  if (!r) return { kind: 'unresolved', reason: 'malformed' };
  const str = (k: string) => r[k] ?? '';

  if (!signatureMatches(r, querydrResponseSignData(r), hashSecret))
    return { kind: 'unresolved', reason: 'signature' };
  if (str('vnp_TmnCode') !== expect.tmnCode) return { kind: 'unresolved', reason: 'tmn_code' };
  if (str('vnp_TxnRef') !== expect.txnRef) return { kind: 'unresolved', reason: 'txn_ref' };

  const responseCode = str('vnp_ResponseCode');
  if (responseCode === '91') return { kind: 'not_found' };
  if (responseCode !== '00') return { kind: 'unresolved', reason: 'response_code', responseCode };
  const transactionStatus = str('vnp_TransactionStatus');
  const codes = { responseCode, transactionStatus };
  if (str('vnp_TransactionType') !== '01')
    return { kind: 'unresolved', reason: 'transaction_type', ...codes };
  if (transactionStatus === '00') {
    const transactionNo = str('vnp_TransactionNo');
    const amountRaw = str('vnp_Amount');
    // VND không có đơn vị lẻ: vnp_Amount phải chia hết cho 100 (Khang 16/11), nếu không là sai dạng.
    if (
      !/^\d{1,15}$/.test(transactionNo) ||
      !/^\d{1,15}$/.test(amountRaw) ||
      BigInt(amountRaw) % 100n !== 0n
    )
      return { kind: 'unresolved', reason: 'malformed', ...codes };
    return {
      kind: 'paid',
      transactionNo,
      amount: Number(BigInt(amountRaw) / 100n),
      payDate: parseVnpDate(str('vnp_PayDate') || undefined),
    };
  }
  if (transactionStatus === '02') return { kind: 'failed', ...codes };
  return { kind: 'unresolved', reason: 'transaction_status', ...codes };
}

// ---------------------------------------------------------------------------------------------
// refund (T32 Phần 9a, SD-2e, D1) — cùng trang tài liệu với querydr (đọc 23/11), cùng endpoint.
// Giả định (trang không ghi; refund không thử được trên sandbox, VNPay trả lời 18/11):
//   - `vnp_Amount` = VND × 100, như lệnh trả, IPN và querydr;
//   - luôn gửi `vnp_TransactionNo`, nên không gặp ca trường này vắng trong chuỗi ký;
//   - trường thiếu trong response đưa vào chuỗi ký là chuỗi rỗng, như querydr;
//   - RC 00 + TS 00 / 05 / 06 = done: VNPay đã nhận yêu cầu hoàn; không có nghĩa tiền đã về tài
//     khoản tài xế (VNPay / ngân hàng chuyển sau, ta không có kênh báo về).
// ---------------------------------------------------------------------------------------------

/** Thứ tự chuỗi ký request refund (tài liệu VNPay). */
export const REFUND_REQUEST_SIGN_FIELDS = [
  'vnp_RequestId',
  'vnp_Version',
  'vnp_Command',
  'vnp_TmnCode',
  'vnp_TransactionType',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_TransactionNo',
  'vnp_TransactionDate',
  'vnp_CreateBy',
  'vnp_CreateDate',
  'vnp_IpAddr',
  'vnp_OrderInfo',
] as const;

/** Thứ tự chuỗi ký response refund (tài liệu VNPay). */
export const REFUND_RESPONSE_SIGN_FIELDS = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
] as const;

export function refundRequestSignData(params: Record<string, string>): string {
  return joinFields(REFUND_REQUEST_SIGN_FIELDS, params);
}

export function refundResponseSignData(body: Record<string, unknown>): string {
  return joinFields(REFUND_RESPONSE_SIGN_FIELDS, body);
}

/** Đủ để gửi một lệnh refund. */
export interface RefundInput {
  refundId: number;
  /** `top_ups.gateway_reference` (khoản trễ dùng cùng TxnRef với top-up gốc). */
  gatewayReference: string;
  /** `vnp_TransactionNo` của giao dịch gốc theo kind (bảng 2.1). */
  originalTransactionNo: string;
  /** Số tiền của giao dịch gốc, VND: bằng `amountVnd` thì hoàn toàn phần (02), khác thì 03. */
  originalAmountVnd: number;
  /** `top_ups.created_at` = `vnp_CreateDate` của lệnh trả. */
  createdAt: Date;
  amountVnd: number;
  /** `refunds.requested_by`; NULL = hệ thống. */
  requestedBy: number | null;
}

const VNP_REF = /^[A-Za-z0-9]{1,100}$/;

/** Body JSON đã ký của một lệnh refund. Hàm thuần: `now`, `requestId` do bên gọi đưa vào. */
export function refundRequest(
  input: RefundInput,
  cfg: Pick<VnpayConfig, 'tmnCode' | 'hashSecret'> & Pick<VnpayApiConfig, 'serverIp'>,
  now: Date,
  requestId: string,
): Record<string, string> {
  const amount = input.amountVnd * 100;
  if (!Number.isSafeInteger(amount) || amount <= 0 || input.amountVnd > input.originalAmountVnd)
    throw new Error('invalid_refund_amount');
  if (!VNP_REF.test(input.gatewayReference)) throw new Error('invalid_gateway_reference');
  if (!VNP_REF.test(input.originalTransactionNo)) throw new Error('invalid_transaction_no');
  if (!/^[A-Za-z0-9]{1,32}$/.test(requestId)) throw new Error('invalid_request_id');
  const params: Record<string, string> = {
    vnp_RequestId: requestId,
    vnp_Version: VNP_VERSION,
    vnp_Command: 'refund',
    vnp_TmnCode: cfg.tmnCode,
    vnp_TransactionType: input.amountVnd === input.originalAmountVnd ? '02' : '03',
    vnp_TxnRef: input.gatewayReference,
    vnp_Amount: String(amount),
    vnp_TransactionNo: input.originalTransactionNo,
    vnp_TransactionDate: vnpDate(input.createdAt),
    vnp_CreateBy: input.requestedBy === null ? 'system' : `admin:${input.requestedBy}`,
    vnp_CreateDate: vnpDate(now),
    vnp_IpAddr: cfg.serverIp,
    vnp_OrderInfo: `Hoan tien PowerMe ${input.refundId}`,
  };
  return {
    ...params,
    vnp_SecureHash: vnpSecureHash(refundRequestSignData(params), cfg.hashSecret),
  };
}

export type RefundUnknownReason = QueryUnresolvedReason | 'amount' | 'transaction_no';

/** Kết quả một lệnh refund (bảng 2.2). */
export type RefundResult =
  | { kind: 'accepted'; refundNo: string; transactionStatus: string }
  | { kind: 'rejected'; responseCode: string; transactionStatus?: string }
  /** RC 94: VNPay đang xử lý yêu cầu hoàn trước đó. Không gửi lại; lượt sau truy vấn. */
  | { kind: 'in_progress'; verified: boolean; unverified?: UnverifiedResponseInfo }
  | {
      kind: 'unknown';
      reason: RefundUnknownReason;
      responseCode?: string;
      transactionStatus?: string;
      unverified?: UnverifiedResponseInfo;
    };

const REFUND_OK_STATUSES: ReadonlySet<string> = new Set(['00', '05', '06']);
const REFUND_REJECT_CODES: ReadonlySet<string> = new Set(['02', '03', '91', '95']);

/**
 * Phân loại response refund (bảng 2.2, hàm thuần, chỉ gọi với HTTP 200). RC 94 nhận cả khi không có
 * chữ ký (sandbox trả 94 không ký) và chỉ dẫn tới "không gửi lại". RC 97 là VNPay báo sai chữ ký của
 * ta, thường không ký; chỉ làm refund `failed`, không bao giờ `done`. RC 02 / 03 / 91 / 95 có thể
 * không lặp lại `vnp_TmnCode` / `vnp_TxnRef`: thiếu thì chấp nhận, có mà khác thì `unknown`.
 */
export function classifyRefundResponse(
  body: unknown,
  expect: { tmnCode: string; txnRef: string; amountVnd: number },
  hashSecret: string,
): RefundResult {
  const r = normalizeVnpBody(body);
  if (!r) return { kind: 'unknown', reason: 'malformed' };
  const str = (k: string) => r[k] ?? '';
  const responseCode = str('vnp_ResponseCode');
  const signed = signatureMatches(r, refundResponseSignData(r), hashSecret);
  if (responseCode === '94') return { kind: 'in_progress', verified: signed };
  if (responseCode === '97') return { kind: 'rejected', responseCode };
  if (!signed) return { kind: 'unknown', reason: 'signature' };

  const tmn = str('vnp_TmnCode');
  const ref = str('vnp_TxnRef');
  if (REFUND_REJECT_CODES.has(responseCode)) {
    if (tmn !== '' && tmn !== expect.tmnCode)
      return { kind: 'unknown', reason: 'tmn_code', responseCode };
    if (ref !== '' && ref !== expect.txnRef)
      return { kind: 'unknown', reason: 'txn_ref', responseCode };
    return { kind: 'rejected', responseCode };
  }
  if (tmn !== expect.tmnCode) return { kind: 'unknown', reason: 'tmn_code', responseCode };
  if (ref !== expect.txnRef) return { kind: 'unknown', reason: 'txn_ref', responseCode };
  if (responseCode !== '00') return { kind: 'unknown', reason: 'response_code', responseCode };

  const transactionStatus = str('vnp_TransactionStatus');
  const codes = { responseCode, transactionStatus };
  if (transactionStatus === '09') return { kind: 'rejected', ...codes };
  if (!REFUND_OK_STATUSES.has(transactionStatus))
    return { kind: 'unknown', reason: 'transaction_status', ...codes };
  if (str('vnp_Amount') !== String(expect.amountVnd * 100))
    return { kind: 'unknown', reason: 'amount', ...codes };
  // `gateway_refund_no` là varchar(20), bắt buộc khi done theo đường này.
  const refundNo = str('vnp_TransactionNo');
  if (!/^\d{1,20}$/.test(refundNo)) return { kind: 'unknown', reason: 'transaction_no', ...codes };
  return { kind: 'accepted', refundNo, transactionStatus };
}

/** Kết quả querydr trước khi gửi lại refund (mục 2.3). */
export type RefundQueryResult =
  /** Đã có lệnh hoàn, TS 00 / 05 / 06. */
  | { kind: 'refunded'; transactionType: string; transactionStatus: string }
  /** Đã có lệnh hoàn, TS 09. */
  | { kind: 'refund_rejected'; transactionType: string; transactionStatus: string }
  /** Giao dịch trả 01 / 00 cùng mã. KHÔNG chứng minh chưa hoàn: tài liệu không ghi querydr đổi loại. */
  | { kind: 'payment_only' }
  | {
      kind: 'unresolved';
      reason: RefundUnknownReason;
      responseCode?: string;
      transactionStatus?: string;
      transactionType?: string;
      unverified?: UnverifiedResponseInfo;
    };

/**
 * Phân loại querydr cho refund (hàm thuần). Khác `classifyQuerydrResponse` (giữ cho top-up): loại
 * 02 / 03 là kết quả hợp lệ, và `vnp_TransactionNo` phải khớp giao dịch gốc của kind. Cách nhận lệnh
 * hoàn là suy luận từ tài liệu, chưa thử được trên sandbox. Mọi ca không chắc → `unresolved`.
 */
export function classifyRefundQueryResponse(
  body: unknown,
  expect: { tmnCode: string; txnRef: string; transactionNo: string; amountVnd: number },
  hashSecret: string,
): RefundQueryResult {
  const r = normalizeVnpBody(body);
  if (!r) return { kind: 'unresolved', reason: 'malformed' };
  const str = (k: string) => r[k] ?? '';
  if (!signatureMatches(r, querydrResponseSignData(r), hashSecret))
    return { kind: 'unresolved', reason: 'signature' };
  if (str('vnp_TmnCode') !== expect.tmnCode) return { kind: 'unresolved', reason: 'tmn_code' };
  if (str('vnp_TxnRef') !== expect.txnRef) return { kind: 'unresolved', reason: 'txn_ref' };
  const responseCode = str('vnp_ResponseCode');
  if (responseCode !== '00') return { kind: 'unresolved', reason: 'response_code', responseCode };
  const transactionStatus = str('vnp_TransactionStatus');
  const transactionType = str('vnp_TransactionType');
  const codes = { responseCode, transactionStatus, transactionType };
  if (str('vnp_TransactionNo') !== expect.transactionNo)
    return { kind: 'unresolved', reason: 'transaction_no', ...codes };
  if (transactionType === '01')
    return transactionStatus === '00'
      ? { kind: 'payment_only' }
      : { kind: 'unresolved', reason: 'transaction_status', ...codes };
  if (transactionType !== '02' && transactionType !== '03')
    return { kind: 'unresolved', reason: 'transaction_type', ...codes };
  if (str('vnp_Amount') !== String(expect.amountVnd * 100))
    return { kind: 'unresolved', reason: 'amount', ...codes };
  if (REFUND_OK_STATUSES.has(transactionStatus))
    return { kind: 'refunded', transactionType, transactionStatus };
  if (transactionStatus === '09')
    return { kind: 'refund_rejected', transactionType, transactionStatus };
  return { kind: 'unresolved', reason: 'transaction_status', ...codes };
}

/** Token inject hàm `fetch` (test thay bằng fetch giả, không gọi mạng). */
export const VNPAY_FETCH = Symbol('BILLING_VNPAY_FETCH');
/** Token inject timeout querydr (test đặt nhỏ; mặc định `QUERYDR_TIMEOUT_MS`). */
export const VNPAY_QUERY_TIMEOUT_MS = Symbol('BILLING_VNPAY_QUERY_TIMEOUT_MS');

@Injectable()
export class VnpayAdapter {
  private readonly api: VnpayApiConfig;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    @Inject(VNPAY_CONFIG) private readonly config: VnpayConfig,
    @Optional() @Inject(VNPAY_API_CONFIG) api?: VnpayApiConfig,
    @Optional() @Inject(VNPAY_FETCH) request?: typeof fetch,
    @Optional() @Inject(VNPAY_QUERY_TIMEOUT_MS) timeoutMs?: number,
  ) {
    this.api = api ?? DEFAULT_VNPAY_API_CONFIG;
    this.request = request ?? fetch;
    this.timeoutMs = timeoutMs ?? QUERYDR_TIMEOUT_MS;
  }

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

  /**
   * querydr (SD-2d `queryTransaction`): POST JSON tới `VNPAY_API_URL`, timeout 10 s. Lỗi mạng,
   * timeout, HTTP ≠ 200, JSON hỏng → `unresolved` (không ném). Chỉ gọi khi `configured`.
   */
  async queryTransaction(topUp: QueryTopUp, signal?: AbortSignal): Promise<QueryResult> {
    if (!this.config.configured) throw new Error('vnpay_unconfigured');
    const body = querydrRequest(topUp, this.signing(), new Date(), newQuerydrRequestId());
    const sent = await this.postJson(body, signal);
    if (!sent.ok) return { kind: 'unresolved', reason: sent.reason };
    const result = classifyQuerydrResponse(
      sent.json,
      { tmnCode: this.config.tmnCode, txnRef: topUp.gatewayReference },
      this.config.hashSecret,
    );
    // Response không tin được: kèm mã / câu thô để log (T32 Phần 8b, mục 5.1); phân loại giữ nguyên.
    if (result.kind === 'unresolved' && UNVERIFIED_REASONS.has(result.reason))
      return { ...result, unverified: unverifiedResponseInfo(sent.json) };
    return result;
  }

  /**
   * Gửi lệnh refund (SD-2e, timeout 10 s). Lỗi mạng, timeout, HTTP ≠ 200, JSON hỏng → `unknown`
   * (không ném): lệnh có thể đã tới VNPay. Chỉ `RefundService.send` gọi, ngoài DB transaction.
   */
  async refund(input: RefundInput, signal?: AbortSignal): Promise<RefundResult> {
    if (!this.config.configured) throw new Error('vnpay_unconfigured');
    const body = refundRequest(input, this.signing(), new Date(), newQuerydrRequestId());
    const sent = await this.postJson(body, signal);
    if (!sent.ok) return { kind: 'unknown', reason: sent.reason };
    const result = classifyRefundResponse(
      sent.json,
      {
        tmnCode: this.config.tmnCode,
        txnRef: input.gatewayReference,
        amountVnd: input.amountVnd,
      },
      this.config.hashSecret,
    );
    if (
      (result.kind === 'unknown' &&
        UNVERIFIED_REASONS.has(result.reason as QueryUnresolvedReason)) ||
      (result.kind === 'in_progress' && !result.verified)
    )
      return { ...result, unverified: unverifiedResponseInfo(sent.json) };
    return result;
  }

  /** querydr trước khi gửi lại refund (mục 2.3). Dùng `querydrRequest` như top-up. */
  async queryRefundState(input: RefundInput, signal?: AbortSignal): Promise<RefundQueryResult> {
    if (!this.config.configured) throw new Error('vnpay_unconfigured');
    const body = querydrRequest(
      { gatewayReference: input.gatewayReference, createdAt: input.createdAt },
      this.signing(),
      new Date(),
      newQuerydrRequestId(),
    );
    const sent = await this.postJson(body, signal);
    if (!sent.ok) return { kind: 'unresolved', reason: sent.reason };
    const result = classifyRefundQueryResponse(
      sent.json,
      {
        tmnCode: this.config.tmnCode,
        txnRef: input.gatewayReference,
        transactionNo: input.originalTransactionNo,
        amountVnd: input.amountVnd,
      },
      this.config.hashSecret,
    );
    if (
      result.kind === 'unresolved' &&
      UNVERIFIED_REASONS.has(result.reason as QueryUnresolvedReason)
    )
      return { ...result, unverified: unverifiedResponseInfo(sent.json) };
    return result;
  }

  private signing() {
    return {
      tmnCode: this.config.tmnCode,
      hashSecret: this.config.hashSecret,
      serverIp: this.api.serverIp,
    };
  }

  /** POST JSON tới `VNPAY_API_URL`, timeout 10 s. Không ném; không đưa lỗi gốc ra ngoài. */
  private async postJson(
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; json: unknown }
    | { ok: false; reason: 'http_status' | 'timeout' | 'network' | 'malformed' }
  > {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let text: string;
    try {
      const response = await this.request(this.api.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'http_status' };
      }
      text = await response.text();
    } catch {
      // Lỗi gốc có thể chứa URL / body; chỉ phân biệt timeout với lỗi mạng.
      return { ok: false, reason: timeout.aborted ? 'timeout' : 'network' };
    }
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
}
