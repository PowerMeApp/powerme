/**
 * Cổng nhà cung cấp hoá đơn điện tử (CD-2 `EInvoiceProviderAdapter`, SD-2c) + bản stub (T32 Phần 7,
 * decisions D5).
 *
 * Vì sao tồn tại: `EInvoiceService` gọi nhà cung cấp qua interface để sau thay bằng provider thật
 * (MISA meInvoice, ngoài phạm vi) mà không sửa service. Bản stub không gọi HTTP; cấu hình bằng biến
 * môi trường để giả lập thành công / lỗi tạm thời / bị từ chối và độ trễ.
 *
 * Lệch CD-2 / SD-2c (diagrams/README.md Known differences): `createInvoice` không nhận thông tin
 * người mua (người tiêu dùng cá nhân, SRS §3.4.1 / UC-PAY-01) và trả kết quả đã phân loại thay vì
 * `string`. Thông tin người bán (MST, mẫu số, ký hiệu) thuộc cấu hình của adapter thật (gắn với tài
 * khoản nhà cung cấp), không truyền theo từng lần gọi; stub không dùng (decisions "Còn mở").
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { stubInvoiceNo } from './e-invoice.js';

/** Token Nest của `EInvoiceProviderAdapter` (BillingModule cấp bản stub). */
export const E_INVOICE_PROVIDER = Symbol('BILLING_E_INVOICE_PROVIDER');

/** Token tuỳ chọn để test đặt timeout nhỏ; mặc định `EINVOICE_PROVIDER_TIMEOUT_MS`. */
export const E_INVOICE_PROVIDER_TIMEOUT = Symbol('BILLING_E_INVOICE_PROVIDER_TIMEOUT');

/** D5: mỗi lần gọi nhà cung cấp tối đa 10 s, quá thì coi là lỗi tạm thời. */
export const EINVOICE_PROVIDER_TIMEOUT_MS = 10_000;

/** Mô tả dịch vụ trên hoá đơn (SRS UC-PAY-01: prepayment for EV charging). */
export const E_INVOICE_DESCRIPTION = 'Trả trước dịch vụ sạc xe điện';

/** Độ dài tối đa của `e_invoices.invoice_no` (`varchar(20)`, 0014). */
export const INVOICE_NO_MAX_LENGTH = 20;

export interface EInvoiceInput {
  /**
   * Khoá idempotent = `e_invoices.id` (chuỗi). Gọi lại cùng khoá PHẢI trả cùng `invoiceNo`, không cấp
   * hoá đơn thứ hai.
   */
  idempotencyKey: string;
  description: string;
  /** Số thực thu, ĐÃ GỒM VAT (`e_invoices.amount_vnd`). */
  amountVnd: number;
  /** Thuế suất % đã chốt lúc tạo dòng (`e_invoices.vat_rate`). */
  vatRate: number;
  /** Phần thuế nằm trong `amountVnd` (`e_invoices.vat_amount_vnd`). */
  vatAmountVnd: number;
  /** Thời điểm thu tiền (`top_ups.completed_at`), cũng là thời điểm lập hoá đơn (BR-P04). */
  paidAt: Date;
}

export type EInvoiceResult =
  | { kind: 'issued'; invoiceNo: string }
  /** Lỗi tạm thời (lỗi nhà cung cấp, timeout, mạng): tự thử lại theo `nextRetry`. */
  | { kind: 'transient'; message: string }
  /** Bị từ chối (dữ liệu / cấu hình sai): sang `needs_review`, Admin xử lý. */
  | { kind: 'data'; message: string };

/**
 * Cổng nhà cung cấp hoá đơn điện tử.
 *
 * YÊU CẦU với mọi bản cài (kể cả provider thật): **idempotent theo `idempotencyKey`**. Nhà cung cấp đã
 * cấp số nhưng worker mất lease ở tx2 (hoặc tiến trình sập) thì lượt sau gọi lại cùng khoá; nhà cung
 * cấp phải trả lại đúng số đã cấp, không cấp hoá đơn thứ hai cho cùng một khoản thu.
 *
 * Không ném cho lỗi nghiệp vụ: trả `transient` / `data`. Lỗi ném ra (không phân loại) được
 * `callProvider` coi là `transient`. Nên tôn trọng `signal` (timeout 10 s / shutdown).
 */
export interface EInvoiceProviderAdapter {
  createInvoice(input: EInvoiceInput, signal: AbortSignal): Promise<EInvoiceResult>;
}

/**
 * Gọi nhà cung cấp với timeout (D5: 10 s) bọc ngoài adapter. Hết giờ → `transient` `provider_timeout`
 * kể cả khi adapter không tôn trọng `signal`; adapter ném → `transient`; số hoá đơn rỗng / quá
 * `INVOICE_NO_MAX_LENGTH` → `data` (không ghi được vào DB, ghi lỗi để Admin xem thay vì lặp mãi ở tx2).
 * Không bao giờ ném.
 */
export async function callProvider(
  adapter: EInvoiceProviderAdapter,
  input: EInvoiceInput,
  signal?: AbortSignal,
  timeoutMs: number = EINVOICE_PROVIDER_TIMEOUT_MS,
): Promise<EInvoiceResult> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<EInvoiceResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error('provider_timeout'));
      resolve({ kind: 'transient', message: 'provider_timeout' });
    }, timeoutMs);
  });
  const called = adapter.createInvoice(input, ctrl.signal).then(normalize, (err: unknown) => ({
    kind: 'transient' as const,
    message: err instanceof Error ? err.message : String(err),
  }));
  try {
    return await Promise.race([called, timedOut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function normalize(r: EInvoiceResult): EInvoiceResult {
  if (r?.kind === 'issued') {
    const no = typeof r.invoiceNo === 'string' ? r.invoiceNo.trim() : '';
    if (no === '' || no.length > INVOICE_NO_MAX_LENGTH)
      return { kind: 'data', message: `invalid_invoice_no: '${String(r.invoiceNo)}'` };
    return { kind: 'issued', invoiceNo: no };
  }
  if (r?.kind === 'transient' || r?.kind === 'data')
    return { kind: r.kind, message: String(r.message ?? '') };
  return { kind: 'transient', message: 'provider_invalid_result' };
}

// ---------------------------------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------------------------------

export const EINVOICE_STUB_MODES = ['success', 'transient', 'data'] as const;
export type EInvoiceStubMode = (typeof EINVOICE_STUB_MODES)[number];

/** Trần của `EINVOICE_STUB_DELAY_MS`: 60 s (quá timeout 10 s là đủ để giả lập treo). */
export const EINVOICE_STUB_MAX_DELAY_MS = 60_000;

export interface EInvoiceStubConfig {
  mode: EInvoiceStubMode;
  delayMs: number;
}

/**
 * - `EINVOICE_STUB_MODE`: `success` (mặc định) | `transient` | `data`.
 * - `EINVOICE_STUB_DELAY_MS`: số nguyên trong [0, 60000], mặc định 0.
 * Giá trị sai → ném `invalid_einvoice_config` lúc khởi động (factory của BillingModule).
 */
export function loadEInvoiceStubConfig(env: NodeJS.ProcessEnv = process.env): EInvoiceStubConfig {
  const rawMode = (env['EINVOICE_STUB_MODE'] ?? '').trim();
  const mode = rawMode === '' ? 'success' : rawMode;
  if (!(EINVOICE_STUB_MODES as readonly string[]).includes(mode))
    throw new Error(
      `invalid_einvoice_config: EINVOICE_STUB_MODE phải là ${EINVOICE_STUB_MODES.join(' | ')}`,
    );
  const rawDelay = (env['EINVOICE_STUB_DELAY_MS'] ?? '').trim();
  const delayMs = rawDelay === '' ? 0 : Number(rawDelay);
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > EINVOICE_STUB_MAX_DELAY_MS)
    throw new Error(
      `invalid_einvoice_config: EINVOICE_STUB_DELAY_MS phải là số nguyên trong [0, ${EINVOICE_STUB_MAX_DELAY_MS}]`,
    );
  return { mode: mode as EInvoiceStubMode, delayMs };
}

/**
 * Nhà cung cấp giả: không gọi HTTP. `success` → số hoá đơn `stubInvoiceNo(khoá)` (ổn định theo khoá,
 * nên tự nhiên idempotent); `transient` / `data` → lỗi tương ứng. Độ trễ dừng sớm khi `signal` huỷ.
 */
export class StubEInvoiceProvider implements EInvoiceProviderAdapter {
  constructor(private readonly config: EInvoiceStubConfig) {}

  async createInvoice(input: EInvoiceInput, signal: AbortSignal): Promise<EInvoiceResult> {
    if (this.config.delayMs > 0) await sleep(this.config.delayMs, undefined, { signal });
    switch (this.config.mode) {
      case 'success':
        return { kind: 'issued', invoiceNo: stubInvoiceNo(input.idempotencyKey) };
      case 'transient':
        return { kind: 'transient', message: 'stub: lỗi tạm thời (EINVOICE_STUB_MODE=transient)' };
      case 'data':
        return { kind: 'data', message: 'stub: bị từ chối (EINVOICE_STUB_MODE=data)' };
    }
  }
}
