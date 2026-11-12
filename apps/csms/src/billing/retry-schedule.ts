/**
 * Lịch retry dùng chung cho việc nền của billing (decisions D7): e-invoice, điều chỉnh hoá đơn, refund.
 *
 * Vì sao tồn tại: D1 (refund) và D5 (e-invoice) cùng lịch 5 phút / 30 phút / 2 giờ và cùng giới hạn
 * `RETRY_LIMIT` lượt. Để ở một chỗ thì hai service không lệch nhau. `RETRY_LIMIT` lấy từ STM-10,
 * không định nghĩa lại.
 *
 * Hàm thuần: trả độ trễ; bên gọi ghi `next_attempt_at = now() + delay` bằng đồng hồ của DB.
 */
import { RETRY_LIMIT } from './refund-state-machine.js';

const MINUTE_MS = 60_000;

/** Độ trễ sau lượt thứ 1, 2, 3 bị lỗi tạm thời. */
export const RETRY_DELAYS_MS: readonly number[] = [5 * MINUTE_MS, 30 * MINUTE_MS, 120 * MINUTE_MS];

if (RETRY_DELAYS_MS.length !== RETRY_LIMIT - 1) {
  throw new Error('retry-schedule: số độ trễ phải bằng RETRY_LIMIT − 1');
}

export type RetryDecision = { exhausted: false; delayMs: number } | { exhausted: true };

/**
 * @param attemptCount số lượt đã thử, tính cả lượt vừa lỗi (cùng nghĩa guard `attemptCount` của
 *   STM-10). Đủ `RETRY_LIMIT` thì hết lượt.
 */
export function nextRetry(attemptCount: number): RetryDecision {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new RangeError(
      `retry-schedule: attemptCount phải là số nguyên ≥ 1, nhận ${attemptCount}`,
    );
  }
  if (attemptCount >= RETRY_LIMIT) return { exhausted: true };
  return { exhausted: false, delayMs: RETRY_DELAYS_MS[attemptCount - 1]! };
}
