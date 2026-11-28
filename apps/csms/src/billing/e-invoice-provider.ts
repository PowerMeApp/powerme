/**
 * Cổng nhà cung cấp hoá đơn điện tử (CD-2 `EInvoiceProviderAdapter`, SD-2c) + bản stub (T32 Phần 7,
 * decisions D5).
 *
 * Vì sao tồn tại: `EInvoiceService` gọi nhà cung cấp qua interface, không biết bản cài nào. Bản thật
 * là SePay eInvoice (T144, `sepay-einvoice.provider.ts`); chọn bằng `EINVOICE_PROVIDER`
 * (`sepay-einvoice.config.ts`), mặc định stub. Bản stub không gọi HTTP; cấu hình bằng biến môi trường
 * để giả lập thành công / lỗi tạm thời / bị từ chối và độ trễ.
 *
 * Lệch CD-2 / SD-2c (diagrams/README.md Known differences): `createInvoice` không nhận thông tin
 * người mua (người tiêu dùng cá nhân, SRS §3.4.1 / UC-PAY-01) và trả kết quả đã phân loại thay vì
 * `string`. Thông tin người bán (MST, mẫu số, ký hiệu) thuộc cấu hình của adapter thật (gắn với tài
 * khoản nhà cung cấp), không truyền theo từng lần gọi; stub không dùng (decisions "Còn mở").
 *
 * T32 Phần 9b: `adjustInvoice` (hoá đơn điều chỉnh giảm khi hoàn tiền), cùng yêu cầu idempotent,
 * cùng timeout 10 s qua `callAdjustProvider`. Viết chung để adapter thật (SePay eInvoice, task riêng)
 * cài sau; chưa kiểm SePay hỗ trợ điều chỉnh giảm thế nào (decisions "Còn mở").
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { stubAdjustmentNo, stubInvoiceNo } from './e-invoice.js';

/** Token Nest của `EInvoiceProviderAdapter` (BillingModule chọn bằng `createEInvoiceProvider`). */
export const E_INVOICE_PROVIDER = Symbol('BILLING_E_INVOICE_PROVIDER');

/** Token tuỳ chọn để test đặt timeout nhỏ; mặc định `EINVOICE_PROVIDER_TIMEOUT_MS`. */
export const E_INVOICE_PROVIDER_TIMEOUT = Symbol('BILLING_E_INVOICE_PROVIDER_TIMEOUT');

/** D5: mỗi lần gọi nhà cung cấp tối đa 10 s, quá thì coi là lỗi tạm thời. */
export const EINVOICE_PROVIDER_TIMEOUT_MS = 10_000;

/** Mô tả dịch vụ trên hoá đơn (SRS UC-PAY-01: prepayment for EV charging). */
export const E_INVOICE_DESCRIPTION = 'Trả trước dịch vụ sạc xe điện';

/** Độ dài tối đa của `e_invoices.invoice_no` (`varchar(20)`, 0014). */
export const INVOICE_NO_MAX_LENGTH = 20;

/** Độ dài tối đa của `invoice_adjustments.provider_adjustment_no` (`varchar(20)`, 0015). */
export const ADJUSTMENT_NO_MAX_LENGTH = 20;

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

/** Điều chỉnh giảm cho một hoá đơn gốc đã phát hành (T32 Phần 9b, D5). */
export interface EInvoiceAdjustmentInput {
  /**
   * Khoá idempotent = `invoice_adjustments.id` (chuỗi). Gọi lại cùng khoá PHẢI trả cùng
   * `adjustmentNo`, không cấp điều chỉnh thứ hai.
   */
  idempotencyKey: string;
  /** Số hoá đơn gốc (`e_invoices.invoice_no`); chỉ gửi khi gốc đã `issued`. */
  originalInvoiceNo: string;
  /** Số thứ tự điều chỉnh của ta trên hoá đơn gốc (`invoice_adjustments.adjustment_no`, từ 1). */
  adjustmentNo: number;
  reason: string;
  /** Số điều chỉnh, ĐÃ GỒM VAT, âm = giảm (`invoice_adjustments.amount_vnd`). */
  amountVnd: number;
  /** Thuế suất % của hoá đơn gốc (`e_invoices.vat_rate`), không tính lại theo ngày hoàn. */
  vatRate: number;
  /** Phần thuế nằm trong `amountVnd`, âm (`adjustmentVat`). */
  vatAmountVnd: number;
  /** Lúc Admin ghi nhận hoàn xong trên cổng (`refunds.completed_at`). */
  refundedAt: Date;
}

export type EInvoiceAdjustmentResult =
  /** `adjustmentNo` = số điều chỉnh do nhà cung cấp cấp (`provider_adjustment_no`). */
  | { kind: 'issued'; adjustmentNo: string }
  | { kind: 'transient'; message: string }
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
  /**
   * Phát hành điều chỉnh giảm cho hoá đơn gốc `originalInvoiceNo` (T32 Phần 9b). Cùng các yêu cầu
   * trên: idempotent theo `idempotencyKey` (= `invoice_adjustments.id`), không ném cho lỗi nghiệp vụ.
   */
  adjustInvoice(
    input: EInvoiceAdjustmentInput,
    signal: AbortSignal,
  ): Promise<EInvoiceAdjustmentResult>;
}

/**
 * Gọi nhà cung cấp với timeout (D5: 10 s) bọc ngoài adapter. Hết giờ → `transient` `provider_timeout`
 * kể cả khi adapter không tôn trọng `signal`; adapter ném → `transient`; số hoá đơn rỗng / quá
 * `INVOICE_NO_MAX_LENGTH` → `data` (không ghi được vào DB, ghi lỗi để Admin xem thay vì lặp mãi ở tx2).
 * Không bao giờ ném.
 */
export function callProvider(
  adapter: EInvoiceProviderAdapter,
  input: EInvoiceInput,
  signal?: AbortSignal,
  timeoutMs: number = EINVOICE_PROVIDER_TIMEOUT_MS,
): Promise<EInvoiceResult> {
  return callWithTimeout((s) => adapter.createInvoice(input, s), normalize, signal, timeoutMs);
}

/**
 * Như `callProvider` cho `adjustInvoice` (T32 Phần 9b): timeout 10 s, adapter ném → `transient`, số
 * điều chỉnh rỗng / quá `ADJUSTMENT_NO_MAX_LENGTH` → `data` `invalid_adjustment_no`. Không bao giờ ném.
 */
export function callAdjustProvider(
  adapter: EInvoiceProviderAdapter,
  input: EInvoiceAdjustmentInput,
  signal?: AbortSignal,
  timeoutMs: number = EINVOICE_PROVIDER_TIMEOUT_MS,
): Promise<EInvoiceAdjustmentResult> {
  return callWithTimeout(
    (s) => adapter.adjustInvoice(input, s),
    normalizeAdjustment,
    signal,
    timeoutMs,
  );
}

type ProviderFailure = { kind: 'transient' | 'data'; message: string };

/**
 * Lõi chung của `callProvider` / `callAdjustProvider` (rút ra ở Phần 9b, hành vi của `callProvider`
 * không đổi): signal riêng cho adapter (huỷ khi worker huỷ hoặc hết giờ), đua với hẹn giờ, adapter
 * ném → `transient` kèm message.
 */
async function callWithTimeout<R>(
  call: (signal: AbortSignal) => Promise<R>,
  normalizeResult: (r: R) => R,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<R | ProviderFailure> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ProviderFailure>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error('provider_timeout'));
      resolve({ kind: 'transient', message: 'provider_timeout' });
    }, timeoutMs);
  });
  const called = call(ctrl.signal).then(normalizeResult, (err: unknown) => ({
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
  return normalizeFailure(r);
}

function normalizeAdjustment(r: EInvoiceAdjustmentResult): EInvoiceAdjustmentResult {
  if (r?.kind === 'issued') {
    const no = typeof r.adjustmentNo === 'string' ? r.adjustmentNo.trim() : '';
    if (no === '' || no.length > ADJUSTMENT_NO_MAX_LENGTH)
      return { kind: 'data', message: `invalid_adjustment_no: '${String(r.adjustmentNo)}'` };
    return { kind: 'issued', adjustmentNo: no };
  }
  return normalizeFailure(r);
}

/** Lỗi đã phân loại giữ nguyên; kết quả không đúng dạng → `transient` `provider_invalid_result`. */
function normalizeFailure(r: { kind?: unknown; message?: unknown } | undefined): ProviderFailure {
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
 * Nhà cung cấp giả: không gọi HTTP. `success` → số hoá đơn `stubInvoiceNo(khoá)` / số điều chỉnh
 * `stubAdjustmentNo(khoá)` (ổn định theo khoá, nên tự nhiên idempotent); `transient` / `data` → lỗi
 * tương ứng. Độ trễ dừng sớm khi `signal` huỷ. Hai method dùng chung cấu hình.
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

  async adjustInvoice(
    input: EInvoiceAdjustmentInput,
    signal: AbortSignal,
  ): Promise<EInvoiceAdjustmentResult> {
    if (this.config.delayMs > 0) await sleep(this.config.delayMs, undefined, { signal });
    switch (this.config.mode) {
      case 'success':
        return { kind: 'issued', adjustmentNo: stubAdjustmentNo(input.idempotencyKey) };
      case 'transient':
        return { kind: 'transient', message: 'stub: lỗi tạm thời (EINVOICE_STUB_MODE=transient)' };
      case 'data':
        return { kind: 'data', message: 'stub: bị từ chối (EINVOICE_STUB_MODE=data)' };
    }
  }
}
