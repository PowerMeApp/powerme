/**
 * Lỗi dùng chung cho các máy trạng thái của billing (TopUpStateMachine STM-4, RefundStateMachine
 * STM-10). Tên `InvalidTransition` theo `billing/CLAUDE.md` (bất biến: chuyển không hợp lệ → ném).
 */

export type BillingMachine = 'STM-4' | 'STM-10';

/** Cặp (trạng thái, event) không có trong diagram. Route map sang 409. */
export class InvalidTransition extends Error {
  constructor(
    readonly machine: BillingMachine,
    readonly from: string,
    readonly event: string,
  ) {
    super(`Chuyển trạng thái không hợp lệ: ${from} --${event}--> ? (không có trong ${machine})`);
    this.name = 'InvalidTransition';
  }
}

/**
 * Service gọi `apply` mà thiếu guard máy cần để chọn nhánh. Đây là lỗi lập trình, không phải lỗi
 * nghiệp vụ: máy không đoán giá trị mặc định cho guard tiền bạc.
 */
export class MissingGuard extends TypeError {
  constructor(
    readonly machine: BillingMachine,
    readonly from: string,
    readonly event: string,
    readonly guard: string,
  ) {
    super(`${machine}: ${from} --${event}--> cần guard '${guard}'`);
    this.name = 'MissingGuard';
  }
}
