/**
 * VnpayAdapter (CD-2 «port») — Phần 5: `buildPaymentUrl`; Phần 6: `verifyIpn` (kiểm chữ ký IPN);
 * Phần 8: `queryTransaction` (querydr). Phần dựng / kiểm là hàm THUẦN (không gọi mạng, không đọc DB
 * hay đồng hồ); lớp `VnpayAdapter` chỉ bọc cấu hình và HTTP của querydr. Refund (Phần 9) thêm sau.
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
//     thì đưa chuỗi rỗng vào chuỗi ký (chờ thử sandbox);
//   - `vnp_Amount` của response coi là VND × 100 như IPN (tài liệu querydr không ghi; chờ sandbox).
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
  amountPaidVnd: number;
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
  | 'amount_mismatch'
  | 'network'
  | 'timeout'
  | 'http_status';

/** Kết quả querydr đã phân loại (bảng 3.1, Ân 12/11). */
export type QueryResult =
  | { kind: 'paid'; transactionNo: string; amount: number; payDate: Date | null }
  | { kind: 'failed'; responseCode: string; transactionStatus: string }
  | { kind: 'not_found' }
  | {
      kind: 'unresolved';
      reason: QueryUnresolvedReason;
      responseCode?: string;
      transactionStatus?: string;
    };

/**
 * Kiểm + phân loại response querydr (hàm thuần, không log). Thứ tự: dạng body (chuẩn hoá giá trị
 * về chuỗi) → chữ ký (thời gian hằng) → `vnp_TmnCode` → `vnp_TxnRef` → RC `91` (`not_found`) →
 * RC ≠ `00` → `vnp_TransactionType` ≠ `01` → TS `00` (kiểm `vnp_TransactionNo`, số tiền) / `02` /
 * khác. Mọi ca không tin được → `unresolved` (giữ `pending`, hẹn lại).
 */
export function classifyQuerydrResponse(
  body: unknown,
  expect: { tmnCode: string; txnRef: string; amountPaidVnd: number },
  hashSecret: string,
): QueryResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { kind: 'unresolved', reason: 'malformed' };
  // Chuẩn hoá giá trị JSON về chuỗi trước khi ký / đọc: null / undefined = thiếu (chuỗi rỗng trong
  // chuỗi ký), số hữu hạn → String(v); object / array / boolean / số không hữu hạn → malformed.
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') r[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) r[k] = String(v);
    else return { kind: 'unresolved', reason: 'malformed' };
  }
  const str = (k: string) => r[k] ?? '';

  const given = str('vnp_SecureHash').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(given)) return { kind: 'unresolved', reason: 'signature' };
  const expected = vnpSecureHash(querydrResponseSignData(r), hashSecret);
  if (!timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex')))
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
    if (!/^\d{1,15}$/.test(transactionNo) || !/^\d{1,15}$/.test(amountRaw))
      return { kind: 'unresolved', reason: 'malformed', ...codes };
    if (BigInt(amountRaw) !== BigInt(expect.amountPaidVnd) * 100n)
      return { kind: 'unresolved', reason: 'amount_mismatch', ...codes };
    return {
      kind: 'paid',
      transactionNo,
      amount: Number(amountRaw) / 100,
      payDate: parseVnpDate(str('vnp_PayDate') || undefined),
    };
  }
  if (transactionStatus === '02') return { kind: 'failed', ...codes };
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
    const body = querydrRequest(
      topUp,
      {
        tmnCode: this.config.tmnCode,
        hashSecret: this.config.hashSecret,
        serverIp: this.api.serverIp,
      },
      new Date(),
      newQuerydrRequestId(),
    );
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
        return { kind: 'unresolved', reason: 'http_status' };
      }
      text = await response.text();
    } catch {
      // Không đưa lỗi gốc ra ngoài (có thể chứa URL / body); chỉ phân biệt timeout với lỗi mạng.
      return { kind: 'unresolved', reason: timeout.aborted ? 'timeout' : 'network' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'unresolved', reason: 'malformed' };
    }
    return classifyQuerydrResponse(
      json,
      {
        tmnCode: this.config.tmnCode,
        txnRef: topUp.gatewayReference,
        amountPaidVnd: topUp.amountPaidVnd,
      },
      this.config.hashSecret,
    );
  }
}
