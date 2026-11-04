/**
 * RefundStateMachine — STM-10 Refund (`refunds.status`), lớp THUẦN (không DB, không Nest).
 *
 * Vì sao tồn tại: RefundService (Phần 9, 11) và worker refund (Phần 12) chỉ gọi `apply()` rồi ghi
 * kết quả; bảng chuyển nằm ở một chỗ, theo `diagrams/stm/STM-10_Refund.puml` (v1.0, 01/11/2026)
 * và decisions D1.
 *
 * Số `no` theo thứ tự mũi tên trong STM-10:
 *   #1 ● → requested (tạo, `initial()`, cùng transaction với quyết định hoàn)
 *   #2 requested → requested  lỗi tạm thời và chưa hết lượt: ghi lỗi, hẹn retry
 *   #3 requested → done       VNPay xác nhận
 *   #4 requested → failed     bị từ chối, hoặc hết RETRY_LIMIT lượt
 *   #5 failed → requested     Admin retry: một lượt, KHÔNG reset bộ đếm
 * Không có `failed → done`; `done` là trạng thái cuối.
 *
 * "Truy vấn trạng thái trước khi gửi lại" (STM-10, `after(retry delay)`) là hành động bên trong
 * `requested`, không đổi trạng thái — RefundService lo. Lịch 5 phút / 30 phút / 2 giờ là helper
 * dùng chung với e-invoice (D7, Phần 12), không nằm ở đây.
 *
 * Bộ 3 × 3 = 9 cặp (trạng thái, event): 3 được nhận (4 chuyển) · 6 ném InvalidTransition.
 */
import { InvalidTransition, MissingGuard } from './invalid-transition.js';

export const REFUND_STATUSES = ['requested', 'done', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Số lượt gửi tối đa trước khi `failed` (D1, D7). */
export const RETRY_LIMIT = 4;

export const REFUND_EVENTS = [
  /** VNPay xác nhận đã hoàn (#3). */
  'GATEWAY_CONFIRMED',
  /** Một lượt gửi lỗi (#2 hoặc #4 tuỳ guard). */
  'ATTEMPT_FAILED',
  /** Admin bấm retry một refund `failed` (#5). */
  'ADMIN_RETRY',
] as const;
export type RefundEvent = (typeof REFUND_EVENTS)[number];

/** Dùng lại `e_invoice_error_kind` (decisions D8): `transient` = lỗi tạm thời, `data` = bị từ chối. */
export type RefundErrorKind = 'transient' | 'data';

export interface AttemptFailedGuards {
  errorKind: RefundErrorKind;
  /** `refunds.attempt_count` SAU lượt vừa thử (≥ 1). */
  attemptCount: number;
}

export interface RefundStep {
  to: RefundStatus;
  no: string;
  /** true khi vẫn `requested` và service phải hẹn `next_attempt_at` (#2). */
  retry: boolean;
}

export interface RefundTransition {
  no: string;
  from: RefundStatus;
  event: RefundEvent;
  to: RefundStatus;
}

export const REFUND_TRANSITIONS: readonly RefundTransition[] = [
  { no: '#2', from: 'requested', event: 'ATTEMPT_FAILED', to: 'requested' },
  { no: '#3', from: 'requested', event: 'GATEWAY_CONFIRMED', to: 'done' },
  { no: '#4', from: 'requested', event: 'ATTEMPT_FAILED', to: 'failed' },
  { no: '#5', from: 'failed', event: 'ADMIN_RETRY', to: 'requested' },
];

export class RefundStateMachine {
  /** #1: refund mới tạo. */
  initial(): RefundStatus {
    return 'requested';
  }

  canApply(from: RefundStatus, event: RefundEvent): boolean {
    return REFUND_TRANSITIONS.some((t) => t.from === from && t.event === event);
  }

  apply(
    from: RefundStatus,
    event: RefundEvent,
    guards: Partial<AttemptFailedGuards> = {},
  ): RefundStep {
    if (!this.canApply(from, event)) throw new InvalidTransition('STM-10', from, event);
    // Ngoài ATTEMPT_FAILED, mỗi cặp (from, event) chỉ có một mũi tên.
    if (event !== 'ATTEMPT_FAILED') return this.step(from, event);

    const { errorKind, attemptCount } = guards;
    if (errorKind === undefined) throw new MissingGuard('STM-10', from, event, 'errorKind');
    if (attemptCount === undefined) throw new MissingGuard('STM-10', from, event, 'attemptCount');
    if (!Number.isInteger(attemptCount) || attemptCount < 1) {
      throw new RangeError(`STM-10: attemptCount phải là số nguyên ≥ 1, nhận ${attemptCount}`);
    }
    const retry = errorKind === 'transient' && attemptCount < RETRY_LIMIT;
    return this.step(from, event, retry ? 'requested' : 'failed');
  }

  private step(from: RefundStatus, event: RefundEvent, to?: RefundStatus): RefundStep {
    const t = REFUND_TRANSITIONS.find(
      (x) => x.from === from && x.event === event && (to === undefined || x.to === to),
    );
    if (!t) throw new InvalidTransition('STM-10', from, event);
    return { to: t.to, no: t.no, retry: t.no === '#2' };
  }
}
