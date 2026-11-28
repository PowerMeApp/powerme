/**
 * RefundStateMachine — STM-10 Refund (`refunds.status`), lớp THUẦN (không DB, không Nest).
 *
 * Vì sao tồn tại: RefundService chỉ gọi `apply()` rồi ghi kết quả; bảng chuyển nằm ở một chỗ, theo
 * `diagrams/report4/state/STM-10/STM-10.puml` (v2.0, 26/11/2026, hoàn tiền thủ công D-AC / SRS BR-P51)
 * và decisions D1. Không có gửi tự động, truy vấn cổng hay retry tự động cho refund.
 *
 * Số `no` theo thứ tự mũi tên trong STM-10 v2.0:
 *   #1 ● → requested       tạo (`initial()`, cùng transaction với quyết định hoàn / đóng tài khoản)
 *   #2 requested → done     Admin nhập mã hoàn của cổng [mã chưa ghi lần nào]
 *   #3 requested → failed   Admin đánh dấu thất bại [cổng từ chối] / ghi lý do
 *   #4 failed → requested   Admin làm lại
 * Không có `failed → done`; `done` là trạng thái cuối.
 *
 * Guard "mã chưa ghi lần nào" do RefundService kiểm (UNIQUE `gateway_refund_no`), không nằm ở đây.
 * Bộ 3 × 3 = 9 cặp (trạng thái, event): 3 được nhận · 6 ném InvalidTransition.
 */
import { InvalidTransition } from './invalid-transition.js';

export const REFUND_STATUSES = ['requested', 'done', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_EVENTS = [
  /** Admin nhập mã hoàn của cổng merchant (#2). */
  'ADMIN_CONFIRMED',
  /** Admin đánh dấu thất bại kèm lý do (#3). */
  'ADMIN_MARKED_FAILED',
  /** Admin làm lại một refund `failed` (#4). */
  'ADMIN_REDO',
] as const;
export type RefundEvent = (typeof REFUND_EVENTS)[number];

export interface RefundStep {
  to: RefundStatus;
  no: string;
}

export interface RefundTransition {
  no: string;
  from: RefundStatus;
  event: RefundEvent;
  to: RefundStatus;
}

export const REFUND_TRANSITIONS: readonly RefundTransition[] = [
  { no: '#2', from: 'requested', event: 'ADMIN_CONFIRMED', to: 'done' },
  { no: '#3', from: 'requested', event: 'ADMIN_MARKED_FAILED', to: 'failed' },
  { no: '#4', from: 'failed', event: 'ADMIN_REDO', to: 'requested' },
];

export class RefundStateMachine {
  /** #1: refund mới tạo. */
  initial(): RefundStatus {
    return 'requested';
  }

  canApply(from: RefundStatus, event: RefundEvent): boolean {
    return REFUND_TRANSITIONS.some((t) => t.from === from && t.event === event);
  }

  apply(from: RefundStatus, event: RefundEvent): RefundStep {
    const t = REFUND_TRANSITIONS.find((x) => x.from === from && x.event === event);
    if (!t) throw new InvalidTransition('STM-10', from, event);
    return { to: t.to, no: t.no };
  }
}
