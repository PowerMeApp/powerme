/**
 * Nhà cung cấp hoá đơn điện tử thật: SePay eInvoice (T144, decisions D5; nhà cung cấp gốc của tài
 * khoản là Mắt Bão). Chọn bằng `EINVOICE_PROVIDER=sepay` (`sepay-einvoice.config.ts`).
 *
 * Một lần `createInvoice` (cả lượt nằm trong 10 s của `callProvider`; ngân sách riêng 8,5 s):
 *   1. `ref = <prefix>-<idempotencyKey>`;
 *   2. tra trước `GET /v1/invoices/{ref}`: đã issued → trả số (idempotent khi lượt trước mất lease ở
 *      tx2); có mà chưa xong → `transient sepay_pending`; 404 → bước 3;
 *   3. `POST /v1/invoices/create` (`is_draft: false`, tạo và phát hành một bước); 409
 *      `EINVOICE_DOCUMENT_EXISTED` → không lỗi, theo dõi bằng tra theo ref;
 *   4. hỏi trạng thái vài lần trong ngân sách; vẫn chờ → `transient sepay_pending`, lượt sau vào
 *      thẳng bước 2. Không bao giờ POST lại trong cùng lượt.
 *
 * Token Bearer (`POST /v1/token`, Basic Auth, sống 86400 s) cache trong adapter, xin lại khi còn < 5
 * phút hoặc khi gặp 401 (gọi lại đúng một lần). Message / log không bao giờ chứa mật khẩu, token,
 * header hay URL: lỗi gốc của fetch không đưa ra ngoài.
 *
 * `adjustInvoice` (T32 Phần 9b) chưa cài: trả `data` `sepay_adjustment_not_supported`, không gọi HTTP.
 */
import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  EInvoiceAdjustmentInput,
  EInvoiceAdjustmentResult,
  EInvoiceInput,
  EInvoiceProviderAdapter,
  EInvoiceResult,
} from './e-invoice-provider.js';
import type { SepayEInvoiceConfig } from './sepay-einvoice.config.js';

/** Ngân sách thời gian của một lượt, chừa ~1,5 s trước timeout 10 s của `callProvider`. */
export const SEPAY_CALL_BUDGET_MS = 8_500;
/** Khoảng chờ trước mỗi lần hỏi trạng thái sau khi tạo (tối đa ~6,5 s). */
export const SEPAY_POLL_DELAYS_MS = [1_000, 1_500, 2_000, 2_000] as const;
/** Sau 409 tra ngay lần đầu. */
const POLL_DELAYS_AFTER_CONFLICT_MS = [0, 1_500, 2_000, 2_000] as const;
/** Chừa cho một lần gọi HTTP khi quyết định còn hỏi tiếp được không. */
const POLL_REQUEST_ALLOWANCE_MS = 1_000;
/** Xin token mới khi còn ít hơn chừng này. */
export const SEPAY_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MESSAGE_MAX = 200;

/** SePay: không chắc hoá đơn đã lên cơ quan thuế hay chưa — KHÔNG gửi lại (tài liệu dặn). */
const UNCONFIRMED_PHRASE = 'chưa xác nhận được kết quả phát hành';
/** 500 do trạng thái tài khoản: thử lại không đổi được (QUOTA… đúng chính tả của SePay). */
const DATA_5XX_CODES = new Set([
  'QUOTA_HAS_BEEN_USERD_UP',
  'REGISTRATION_NOT_COMPLETE',
  'BILLING_IS_UNPAID',
  'EINVOICE_ACCOUNT_NOT_FOUND',
]);
/** 4xx mà lượt sau tự qua: đồng hồ máy chủ nhanh hơn SePay vài giây → "ngày ở tương lai". */
const TRANSIENT_4XX_CODES = new Set(['ISSUED_DATE_INVALID', 'INVALID_ISSUED_DATE']);

export interface SepayDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: { warn(message: unknown): void; error(message: unknown): void };
}

/** Kết quả lỗi đã phân loại (không bao giờ là `issued`). */
export type EInvoiceFailure = Exclude<EInvoiceResult, { kind: 'issued' }>;

export type InvoiceState =
  | { state: 'issued'; invoiceNo: string }
  | { state: 'pending' }
  | { state: 'failed'; message: string }
  | { state: 'malformed' };

// ---------------------------------------------------------------------------------------------------
// Hàm thuần
// ---------------------------------------------------------------------------------------------------

export function sepayReferenceCode(prefix: string, idempotencyKey: string): string {
  return `${prefix}-${idempotencyKey}`;
}

/** Số lưu vào `e_invoices.invoice_no`: số hoá đơn chỉ duy nhất trong một ký hiệu (đổi theo năm). */
export function sepayInvoiceNo(series: string, invoiceNumber: string): string {
  return `${series}-${invoiceNumber}`;
}

/** `YYYY-MM-DD HH:mm:ss` theo giờ Việt Nam (UTC+7, không có giờ mùa hè). */
export function vnDateTime(nowMs: number): string {
  return new Date(nowMs + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Body `POST /v1/invoices/create`. Gửi đúng số đã lưu trên dòng (SePay dùng số gửi, không tính lại):
 * đơn giá = tổng − thuế, thuế suất / tiền thuế từ input. `issued_date` = lúc gọi (SePay chỉ nhận ngày
 * hiện tại), không phải `paidAt`.
 */
export function buildCreateInvoiceBody(
  input: EInvoiceInput,
  config: SepayEInvoiceConfig,
  referenceCode: string,
  nowMs: number,
): Record<string, unknown> {
  return {
    provider_account_id: config.providerAccountId,
    template_code: config.templateCode,
    invoice_series: config.invoiceSeries,
    issued_date: vnDateTime(nowMs),
    currency: 'VND',
    is_draft: false,
    reference_code: referenceCode,
    payment_method: 'CK',
    total_amount: input.amountVnd,
    buyer: { type: 'personal', name: config.buyerName },
    items: [
      {
        line_number: 1,
        line_type: 1,
        item_code: config.itemCode,
        item_name: input.description,
        unit: config.unit,
        quantity: 1,
        unit_price: input.amountVnd - input.vatAmountVnd,
        tax_rate: input.vatRate,
        tax_amount: input.vatAmountVnd,
        total_amount: input.amountVnd,
      },
    ],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clip = (s: unknown): string =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX) : '';

/**
 * `data` của check (`{status, message, invoice}`) hoặc của chi tiết (chính hoá đơn). Xong = hoá đơn
 * `issued` và có số khác "0". `Failed` / câu "chưa xác nhận…" → `failed`. Còn lại → `pending`.
 */
export function classifyInvoiceState(data: unknown, fallbackSeries: string): InvoiceState {
  if (!isObject(data)) return { state: 'malformed' };
  const message = clip(data['message']);
  if (message.includes(UNCONFIRMED_PHRASE) || String(data['status']).toLowerCase() === 'failed')
    return { state: 'failed', message };
  const invoice = 'invoice' in data ? data['invoice'] : data;
  if (!isObject(invoice) || invoice['status'] !== 'issued') return { state: 'pending' };
  const raw = invoice['invoice_number'];
  const number = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (number === '' || /^0+$/.test(number)) return { state: 'pending' };
  const series =
    typeof invoice['invoice_series'] === 'string' && invoice['invoice_series'].trim() !== ''
      ? invoice['invoice_series'].trim()
      : fallbackSeries;
  return { state: 'issued', invoiceNo: sepayInvoiceNo(series, number) };
}

/** Phân loại response lỗi (status ≠ 2xx, trừ 401 / 404 / 409 adapter tự xử lý). */
export function classifyErrorResponse(status: number, json: unknown): EInvoiceFailure {
  const error = isObject(json) && isObject(json['error']) ? json['error'] : {};
  const code = typeof error['code'] === 'string' ? clip(error['code']) : '';
  const text = clip(error['message']);
  const detail = `http=${status}${code ? ` code=${code}` : ''}${text ? `: ${text}` : ''}`;
  if (text.includes(UNCONFIRMED_PHRASE)) return { kind: 'data', message: `sepay_failed ${detail}` };
  const transient =
    status === 429 ||
    (status >= 500 && !DATA_5XX_CODES.has(code)) ||
    (status >= 400 && status < 500 && TRANSIENT_4XX_CODES.has(code)) ||
    status < 400;
  return transient
    ? { kind: 'transient', message: `sepay_transient ${detail}` }
    : { kind: 'data', message: `sepay_rejected ${detail}` };
}

// ---------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------

/** Kết thúc lượt với kết quả đã phân loại (chỉ dùng bên trong adapter). */
class Stop {
  constructor(readonly result: EInvoiceResult) {}
}

type HttpReply = { status: number; json: unknown; malformed: boolean };

const PENDING: EInvoiceResult = { kind: 'transient', message: 'sepay_pending' };
const MALFORMED: EInvoiceResult = { kind: 'transient', message: 'sepay_malformed_response' };
const UNAUTHORIZED: EInvoiceResult = { kind: 'transient', message: 'sepay_unauthorized' };

export class SepayEInvoiceProvider implements EInvoiceProviderAdapter {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly logger: NonNullable<SepayDeps['logger']>;
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly config: SepayEInvoiceConfig,
    deps: SepayDeps = {},
  ) {
    this.request = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.logger = deps.logger ?? new Logger(SepayEInvoiceProvider.name);
  }

  async createInvoice(input: EInvoiceInput, signal: AbortSignal): Promise<EInvoiceResult> {
    const deadline = this.now() + SEPAY_CALL_BUDGET_MS;
    const ref = sepayReferenceCode(this.config.refPrefix, input.idempotencyKey);
    try {
      const found = await this.lookup(ref, signal);
      if (found !== 'not_found') return this.toResult(found);

      const body = buildCreateInvoiceBody(input, this.config, ref, this.now());
      const created = await this.api('POST', '/v1/invoices/create', signal, body);
      let poll: () => Promise<InvoiceState | 'not_found'>;
      let delays: readonly number[];
      if (created.status >= 200 && created.status < 300) {
        const data = isObject(created.json) ? created.json['data'] : undefined;
        const tracking = isObject(data) ? data['tracking_code'] : undefined;
        if (created.malformed || typeof tracking !== 'string' || tracking.trim() === '')
          return MALFORMED;
        poll = () => this.check(tracking, signal);
        delays = SEPAY_POLL_DELAYS_MS;
      } else if (created.status === 409) {
        // Mã đã có (lượt trước đã tạo): theo dõi bằng tra theo ref, KHÔNG gửi lại.
        poll = () => this.lookup(ref, signal);
        delays = POLL_DELAYS_AFTER_CONFLICT_MS;
      } else {
        return classifyErrorResponse(created.status, created.json);
      }

      for (const ms of delays) {
        if (deadline - this.now() < ms + POLL_REQUEST_ALLOWANCE_MS) break;
        if (ms > 0) await this.sleep(ms, signal);
        const state = await poll();
        if (state !== 'not_found' && state.state !== 'pending') return this.toResult(state);
      }
      return PENDING;
    } catch (error) {
      if (error instanceof Stop) return error.result;
      return { kind: 'transient', message: signal.aborted ? 'sepay_aborted' : 'sepay_network' };
    }
  }

  /**
   * Chưa hỗ trợ điều chỉnh qua SePay: chưa kiểm API điều chỉnh giảm của SePay (D5 "Còn mở"). Không gọi
   * HTTP, trả `data` để điều chỉnh vào `needs_review` cho Admin xem thay vì gửi sai.
   */
  async adjustInvoice(
    _input: EInvoiceAdjustmentInput,
    _signal: AbortSignal,
  ): Promise<EInvoiceAdjustmentResult> {
    return { kind: 'data', message: 'sepay_adjustment_not_supported' };
  }

  private toResult(state: InvoiceState): EInvoiceResult {
    switch (state.state) {
      case 'issued':
        return { kind: 'issued', invoiceNo: state.invoiceNo };
      case 'pending':
        return PENDING;
      case 'failed':
        return { kind: 'data', message: `sepay_failed: ${state.message}` };
      case 'malformed':
        return MALFORMED;
    }
  }

  /** Chi tiết theo `reference_code`: 404 → `not_found`; lỗi khác → `Stop`. */
  private async lookup(ref: string, signal: AbortSignal): Promise<InvoiceState | 'not_found'> {
    const r = await this.api('GET', `/v1/invoices/${encodeURIComponent(ref)}`, signal);
    if (r.status === 404) return 'not_found';
    return this.readState(r);
  }

  /** Trạng thái lệnh tạo theo `tracking_code`; 404 (chưa thấy lệnh) coi như đang chờ. */
  private async check(tracking: string, signal: AbortSignal): Promise<InvoiceState> {
    const path = `/v1/invoices/create/check/${encodeURIComponent(tracking)}`;
    const r = await this.api('GET', path, signal);
    if (r.status === 404) return { state: 'pending' };
    return this.readState(r);
  }

  private readState(r: HttpReply): InvoiceState {
    if (r.status < 200 || r.status >= 300) throw new Stop(classifyErrorResponse(r.status, r.json));
    if (r.malformed || !isObject(r.json)) throw new Stop(MALFORMED);
    const state = classifyInvoiceState(r.json['data'], this.config.invoiceSeries);
    if (state.state === 'malformed') throw new Stop(MALFORMED);
    return state;
  }

  /** Gọi API kèm Bearer; 401 → bỏ token, xin mới, gọi lại đúng một lần; vẫn 401 → `Stop`. */
  private async api(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<HttpReply> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(signal);
      const r = await this.send(method, path, signal, `Bearer ${token}`, body);
      if (r.status !== 401) return r;
      this.token = null;
      if (attempt >= 1) {
        this.logUnauthorized(path === '/v1/invoices/create' ? 'create' : 'read');
        throw new Stop(UNAUTHORIZED);
      }
    }
  }

  private async bearer(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > SEPAY_TOKEN_REFRESH_MARGIN_MS)
      return this.token.value;
    if (!this.pendingToken) {
      this.pendingToken = this.fetchToken(signal).finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  private async fetchToken(signal: AbortSignal): Promise<string> {
    const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
    const r = await this.send('POST', '/v1/token', signal, `Basic ${basic}`);
    if (r.status === 401) {
      this.logUnauthorized('token');
      throw new Stop(UNAUTHORIZED);
    }
    if (r.status < 200 || r.status >= 300) throw new Stop(classifyErrorResponse(r.status, r.json));
    const data = isObject(r.json) ? r.json['data'] : undefined;
    const value = isObject(data) ? data['access_token'] : undefined;
    const expiresIn = isObject(data) ? Number(data['expires_in']) : NaN;
    if (typeof value !== 'string' || value === '') throw new Stop(MALFORMED);
    const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
    this.token = { value, expiresAt: this.now() + ttlMs };
    return value;
  }

  /** Một request; lỗi mạng / huỷ ném nguyên lỗi (bắt ở `createInvoice`, không đưa ra ngoài). */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    authorization: string,
    body?: unknown,
  ): Promise<HttpReply> {
    const response = await this.request(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text), malformed: false };
    } catch {
      return { status: response.status, json: undefined, malformed: true };
    }
  }

  private logUnauthorized(step: string): void {
    this.logger.error(
      JSON.stringify({
        event: 'sepay_einvoice_unauthorized',
        step,
        hint: 'kiểm SEPAY_EINVOICE_USERNAME / PASSWORD và URL (token sandbox không dùng được ở production)',
      }),
    );
  }
}
