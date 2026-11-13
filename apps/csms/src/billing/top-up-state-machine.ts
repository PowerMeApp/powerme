/**
 * TopUpStateMachine — STM-4 TopUp (`top_ups.status`), lớp THUẦN (không DB, không Nest, không đồng hồ).
 *
 * Vì sao tồn tại: bất biến của billing "mọi chuyển trạng thái top-up đi qua TopUpStateMachine".
 * Đây là nơi DUY NHẤT biết bảng chuyển của STM-4 (`diagrams/report4/state/STM-4/STM-4.puml`, v1.1
 * 10/11/2026: `expired` là trạng thái cuối, bỏ cửa sổ trả trễ, T117); TopUpService (Phần 5–9 của
 * WF-02) chỉ gọi `apply()` rồi ghi kết quả xuống DB. Cùng mẫu với FaultStateMachine (STM-6) và
 * SessionStateMachine (STM-1).
 *
 * Số `no` là số chuyển STM-4 dùng trong `billing/CLAUDE.md` và decisions (giữ số cũ, #5 đã bỏ ở
 * T117 nên không còn):
 *   #1 ● → pending (tạo, `initial()`) · #2 pending → credited · #3 pending → failed
 *   #4 pending → expired
 *   #6 thành công sau khi đã expired → khoản trễ, vẫn expired (ghi chú ở `expired` của STM-4)
 *   #7 credited → refunded (Admin hoàn, UC-ADM-08)
 *
 * Guard do service tính rồi truyền vào (`TopUpGuards`); máy không đọc DB hay đồng hồ, giống guard
 * #19 của SessionStateMachine. Thiếu guard cần cho nhánh đang xét → `MissingGuard`.
 *
 * `apply` trả `outcome`:
 *   - `transition`: đổi trạng thái theo bảng.
 *   - `already_applied`: kết quả thanh toán lặp, không ghi gì (BR-P13 → RspCode 02).
 *   - `late_payment`: đã trả nhưng không cộng; giữ trạng thái, ghi `late_*` để Admin hoàn. Có trên
 *       MỌI trạng thái trừ `pending` (T116, Ân 12/11): `expired` (#6), `failed`, và lần trả thứ hai
 *       (transactionNo khác giao dịch đã cộng) cho top-up `credited` / `refunded`.
 *   - `conflicting_result`: kết quả mâu thuẫn với kết quả đã ghi; không ghi gì, service log error để
 *       Admin xử lý ngoài hệ thống: khoản thứ ba (đã có khoản trễ với transactionNo khác), hoặc báo
 *       lỗi sau khi đã cộng.
 *   - `stale`: timeout đến khi đã rời `pending` (đua với IPN qua Scheduler); bỏ qua.
 *   - `rejected`: guard số dư của #7 sai (TC-STM4-12/13); service đổi thành RefundNotAllowed → 422.
 * Chỉ ADMIN_REFUND khi không ở `credited` mới ném `InvalidTransition` (vd. hoàn hai lần, TC-STM4-14).
 *
 * Bổ sung ⊕ chưa có trong diagram (decisions D4, chốt 04/11; T116 12/11):
 *   - Thành công tới khi đã `failed` → `late_payment`, giữ `failed`.
 *   - Thành công tới khi đã `credited` / `refunded` (T32 Phần 6), thứ tự kiểm:
 *       1. transactionNo = giao dịch đã cộng → `already_applied`;
 *       2. đã có khoản trễ: cùng transactionNo → `already_applied`, khác → `conflicting_result`;
 *       3. còn lại → `late_payment` (lần trả thứ hai), giữ trạng thái.
 *   - Đã có khoản trễ (`recordedLateRef`) trên `failed` / `expired`: cùng transactionNo →
 *     `already_applied`, khác → `conflicting_result`. Kiểm khoản trễ đã ghi TRƯỚC, để IPN lặp trả 02
 *     thay vì ghi khoản trễ lần hai.
 *   CHECK `top_ups_late_payment_status_check` cho khoản trễ trên mọi trạng thái trừ `pending` (0021).
 *
 * Bộ 5 × 4 = 20 cặp (trạng thái, event): 16 được nhận · 4 ném InvalidTransition.
 */
import { InvalidTransition, MissingGuard } from './invalid-transition.js';

export const TOP_UP_STATUSES = ['pending', 'credited', 'failed', 'expired', 'refunded'] as const;
export type TopUpStatus = (typeof TOP_UP_STATUSES)[number];

export const TOP_UP_EVENTS = [
  /** IPN có chữ ký hợp lệ, hoặc querydr, báo đã trả (SD-2b, SD-2d). */
  'PAYMENT_SUCCEEDED',
  /** Thanh toán lỗi hoặc tài xế huỷ (SD-2b). */
  'PAYMENT_FAILED',
  /**
   * Vòng quét lúc `expires_at + 2 phút`, querydr trả lời DỨT KHOÁT là chưa trả / thất bại (SD-2d).
   * Kết quả chưa ngã ngũ (đang xử lý, lỗi, timeout, sai chữ ký) thì KHÔNG gửi event này (D4 ⊕).
   */
  'TIMEOUT_NOT_PAID',
  /** Admin hoàn top-up (SD-2e, UC-ADM-08). */
  'ADMIN_REFUND',
] as const;
export type TopUpEvent = (typeof TOP_UP_EVENTS)[number];

/** Giá trị service tính trước khi gọi `apply`. Chỉ nhánh nào cần thì mới bắt buộc. */
export interface TopUpGuards {
  /** PAYMENT_SUCCEEDED: vnp_TransactionNo của kết quả đang xử lý. */
  transactionNo?: string;
  /** PAYMENT_SUCCEEDED trên credited/refunded: `top_ups.gateway_transaction_no` đã ghi khi cộng. */
  appliedTransactionNo?: string;
  /**
   * PAYMENT_SUCCEEDED trên mọi trạng thái trừ pending: `top_ups.late_gateway_ref` hiện tại;
   * `null` = chưa có khoản trễ.
   */
  recordedLateRef?: string | null;
  /** ADMIN_REFUND (#7): số dư ≥ số tiền top-up (không hoàn một phần). */
  balanceCoversAmount?: boolean;
}

export type TopUpOutcome =
  'transition' | 'already_applied' | 'late_payment' | 'conflicting_result' | 'stale' | 'rejected';

export interface TopUpStep {
  to: TopUpStatus;
  outcome: TopUpOutcome;
  /** Số chuyển STM-4; null khi kết quả không ứng với mũi tên nào của diagram. */
  no: string | null;
  /** Chỉ có khi `outcome = 'rejected'`. */
  reason?: 'insufficient_balance';
}

export interface TopUpTransition {
  no: string;
  from: TopUpStatus;
  event: TopUpEvent;
  to: TopUpStatus;
}

/** Các mũi tên đổi trạng thái của STM-4 (#1 là `initial()`, #6 không đổi trạng thái). */
export const TOP_UP_TRANSITIONS: readonly TopUpTransition[] = [
  { no: '#2', from: 'pending', event: 'PAYMENT_SUCCEEDED', to: 'credited' },
  { no: '#3', from: 'pending', event: 'PAYMENT_FAILED', to: 'failed' },
  { no: '#4', from: 'pending', event: 'TIMEOUT_NOT_PAID', to: 'expired' },
  { no: '#7', from: 'credited', event: 'ADMIN_REFUND', to: 'refunded' },
];

/** Kết quả thanh toán và timeout được nhận ở mọi trạng thái; chỉ lệnh của Admin mới bị chặn. */
const ALWAYS_ACCEPTED: ReadonlySet<TopUpEvent> = new Set([
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'TIMEOUT_NOT_PAID',
]);

export class TopUpStateMachine {
  /** #1: top-up mới tạo (SD-2a). */
  initial(): TopUpStatus {
    return 'pending';
  }

  /** "Top-up đang mở" chặn tạo mới: chỉ `pending` (D2 ⊕; `expired` không chặn). */
  isOpen(status: TopUpStatus): boolean {
    return status === 'pending';
  }

  /** Event có được nhận ở trạng thái này không (kết quả có thể là no-op/late/rejected). */
  canApply(from: TopUpStatus, event: TopUpEvent): boolean {
    if (ALWAYS_ACCEPTED.has(event)) return true;
    return TOP_UP_TRANSITIONS.some((t) => t.from === from && t.event === event);
  }

  apply(from: TopUpStatus, event: TopUpEvent, guards: TopUpGuards = {}): TopUpStep {
    switch (event) {
      case 'PAYMENT_SUCCEEDED':
        return this.paymentSucceeded(from, guards);
      case 'PAYMENT_FAILED':
        if (from === 'pending') return this.step(from, event);
        // Đã cộng tiền mà VNPay lại báo lỗi: mâu thuẫn, không phải kết quả lặp.
        if (from === 'credited' || from === 'refunded') return stay(from, 'conflicting_result');
        return stay(from, 'already_applied');
      case 'TIMEOUT_NOT_PAID':
        return from === 'pending' ? this.step(from, event) : stay(from, 'stale');
      case 'ADMIN_REFUND': {
        if (from !== 'credited') throw new InvalidTransition('STM-4', from, event);
        const covers = need(guards, 'balanceCoversAmount', from, event);
        if (!covers)
          return { to: from, outcome: 'rejected', reason: 'insufficient_balance', no: '#7' };
        return this.step(from, event);
      }
    }
  }

  private paymentSucceeded(from: TopUpStatus, g: TopUpGuards): TopUpStep {
    const event = 'PAYMENT_SUCCEEDED';
    switch (from) {
      case 'pending':
        return this.step(from, event);
      case 'credited':
      case 'refunded': {
        const applied = need(g, 'appliedTransactionNo', from, event);
        const txn = need(g, 'transactionNo', from, event);
        const late = need(g, 'recordedLateRef', from, event);
        if (applied === txn) return stay(from, 'already_applied');
        if (late !== null)
          return stay(from, late === txn ? 'already_applied' : 'conflicting_result');
        // Lần trả thứ hai cho top-up đã cộng (T116): ghi khoản trễ, không cộng lần hai.
        return stay(from, 'late_payment');
      }
      case 'failed':
      case 'expired': {
        const late = need(g, 'recordedLateRef', from, event);
        const txn = need(g, 'transactionNo', from, event);
        if (late !== null)
          return stay(from, late === txn ? 'already_applied' : 'conflicting_result');
        if (from === 'failed') return stay(from, 'late_payment');
        return { to: 'expired', outcome: 'late_payment', no: '#6' };
      }
    }
  }

  private step(from: TopUpStatus, event: TopUpEvent): TopUpStep {
    const t = TOP_UP_TRANSITIONS.find((x) => x.from === from && x.event === event);
    if (!t) throw new InvalidTransition('STM-4', from, event);
    return { to: t.to, outcome: 'transition', no: t.no };
  }
}

function stay(from: TopUpStatus, outcome: TopUpOutcome): TopUpStep {
  return { to: from, outcome, no: null };
}

function need<K extends keyof TopUpGuards>(
  g: TopUpGuards,
  key: K,
  from: TopUpStatus,
  event: TopUpEvent,
): Exclude<TopUpGuards[K], undefined> {
  const v = g[key];
  if (v === undefined) throw new MissingGuard('STM-4', from, event, key);
  return v as Exclude<TopUpGuards[K], undefined>;
}
