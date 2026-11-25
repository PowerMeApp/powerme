/**
 * EInvoiceStateMachine — STM-7 EInvoice (`e_invoices.status`, cũng dùng cho
 * `invoice_adjustments.status` ở Phần 9: cùng enum `e_invoice_status`), lớp THUẦN (không DB, không
 * Nest).
 *
 * Vì sao tồn tại: `EInvoiceService` (T32 Phần 7, worker `e-invoice-issue` và Admin retry) chỉ gọi
 * `apply()` rồi ghi kết quả; bảng chuyển nằm ở một chỗ, theo
 * `diagrams/report4/state/STM-7/STM-7.puml` (v1.0, 01/11/2026) và decisions D5.
 *
 * Số `no` theo thứ tự mũi tên trong STM-7:
 *   #1 ● → requested            tạo cùng transaction cộng tiền (`initial()`, T32 Phần 7 17/11)
 *   #2 requested → issued       nhà cung cấp trả số hoá đơn
 *   #3 requested → c1           lỗi hoặc không trả lời: attempts + 1, ghi loại lỗi
 *   #4 c1 → failed              [lỗi tạm thời và attempts < RETRY_LIMIT]: hẹn 5 phút / 30 phút / 2 giờ
 *   #5 c1 → needs_review        [còn lại: bị từ chối, hoặc lượt thứ RETRY_LIMIT trở đi]: báo Admin
 *   #6 failed → requested       đến hạn retry: gửi lại
 *   #7 needs_review → requested Admin retry: một lượt, KHÔNG reset bộ đếm
 * `issued` là trạng thái cuối.
 *
 * Khác STM-10 (refund): lỗi tạm thời của hoá đơn sang `failed` (STM-10 giữ `requested`), và hết lượt
 * thì sang `needs_review` (STM-10 sang `failed`). Lịch retry là `nextRetry` (retry-schedule.ts),
 * `RETRY_LIMIT` lấy từ STM-10, không định nghĩa lại.
 *
 * Bộ 4 × 4 = 16 cặp (trạng thái, event): 4 được nhận (5 chuyển, vì ATTEMPT_FAILED có hai đích tuỳ
 * guard) · 12 ném InvalidTransition.
 */
import { InvalidTransition, MissingGuard } from './invalid-transition.js';
import { RETRY_LIMIT } from './refund-state-machine.js';

export const E_INVOICE_STATUSES = ['requested', 'issued', 'failed', 'needs_review'] as const;
export type EInvoiceStatus = (typeof E_INVOICE_STATUSES)[number];

export const E_INVOICE_EVENTS = [
  /** Nhà cung cấp trả số hoá đơn (#2). */
  'PROVIDER_ISSUED',
  /** Một lượt gọi nhà cung cấp lỗi (#3, rồi #4 hoặc #5 tuỳ guard). */
  'ATTEMPT_FAILED',
  /** Hoá đơn `failed` đến hạn thử lại (#6). */
  'RETRY_DUE',
  /** Admin bấm retry một hoá đơn `needs_review` (#7). */
  'ADMIN_RETRY',
] as const;
export type EInvoiceEvent = (typeof E_INVOICE_EVENTS)[number];

/** Enum `e_invoice_error_kind`: `transient` = lỗi tạm thời (timeout, lỗi nhà cung cấp), `data` = bị từ chối. */
export type EInvoiceErrorKind = 'transient' | 'data';

export interface EInvoiceAttemptGuards {
  errorKind: EInvoiceErrorKind;
  /** `attempt_count` SAU lượt vừa thử (≥ 1). */
  attemptCount: number;
}

export interface EInvoiceStep {
  to: EInvoiceStatus;
  no: string;
  /** true khi sang `failed` và service phải hẹn `next_attempt_at` theo `nextRetry` (#4). */
  retry: boolean;
}

export interface EInvoiceTransition {
  no: string;
  from: EInvoiceStatus;
  event: EInvoiceEvent;
  to: EInvoiceStatus;
}

/** #3 là nửa đầu của #4 / #5 (cùng ATTEMPT_FAILED), nên mỗi dòng ATTEMPT_FAILED mang cả hai số. */
export const E_INVOICE_TRANSITIONS: readonly EInvoiceTransition[] = [
  { no: '#2', from: 'requested', event: 'PROVIDER_ISSUED', to: 'issued' },
  { no: '#3→#4', from: 'requested', event: 'ATTEMPT_FAILED', to: 'failed' },
  { no: '#3→#5', from: 'requested', event: 'ATTEMPT_FAILED', to: 'needs_review' },
  { no: '#6', from: 'failed', event: 'RETRY_DUE', to: 'requested' },
  { no: '#7', from: 'needs_review', event: 'ADMIN_RETRY', to: 'requested' },
];

export class EInvoiceStateMachine {
  /** #1: hoá đơn mới tạo. */
  initial(): EInvoiceStatus {
    return 'requested';
  }

  canApply(from: EInvoiceStatus, event: EInvoiceEvent): boolean {
    return E_INVOICE_TRANSITIONS.some((t) => t.from === from && t.event === event);
  }

  apply(
    from: EInvoiceStatus,
    event: EInvoiceEvent,
    guards: Partial<EInvoiceAttemptGuards> = {},
  ): EInvoiceStep {
    if (!this.canApply(from, event)) throw new InvalidTransition('STM-7', from, event);
    // Ngoài ATTEMPT_FAILED, mỗi cặp (from, event) chỉ có một mũi tên.
    if (event !== 'ATTEMPT_FAILED') return this.step(from, event);

    const { errorKind, attemptCount } = guards;
    if (errorKind === undefined) throw new MissingGuard('STM-7', from, event, 'errorKind');
    if (attemptCount === undefined) throw new MissingGuard('STM-7', from, event, 'attemptCount');
    if (!Number.isInteger(attemptCount) || attemptCount < 1) {
      throw new RangeError(`STM-7: attemptCount phải là số nguyên ≥ 1, nhận ${attemptCount}`);
    }
    const retry = errorKind === 'transient' && attemptCount < RETRY_LIMIT;
    return this.step(from, event, retry ? 'failed' : 'needs_review');
  }

  private step(from: EInvoiceStatus, event: EInvoiceEvent, to?: EInvoiceStatus): EInvoiceStep {
    const t = E_INVOICE_TRANSITIONS.find(
      (x) => x.from === from && x.event === event && (to === undefined || x.to === to),
    );
    if (!t) throw new InvalidTransition('STM-7', from, event);
    return { to: t.to, no: t.no, retry: t.no === '#3→#4' };
  }
}
