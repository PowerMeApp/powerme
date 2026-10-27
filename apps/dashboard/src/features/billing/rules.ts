/**
 * Luật nghiệp vụ của UC-ADM-08 Billing Exceptions mà UI và mock server dùng chung.
 * Nguồn: SD-2c pha E (refund), STM-4 #7, BR-P21 (hoàn toàn bộ, chỉ khi số dư ≥ số top-up; khi đóng
 * tài khoản hoàn về nguồn của các top-up mới nhất trước), BR-P44 (Admin retry từng lần một).
 */

/** STM-4 #7: chỉ hoàn toàn bộ, và chỉ khi số dư còn ≥ số tiền top-up (không bao giờ làm âm số dư). */
export function canRefundTopUp(balanceVnd: number, amountVnd: number): boolean {
  return balanceVnd >= amountVnd;
}

/**
 * BR-P21: số dư chưa dùng hoàn về nguồn của các top-up credited MỚI NHẤT trước. Trả về phần hoàn
 * cho từng top-up (không vượt số tiền đã thu của top-up đó); phần thừa (nếu nguồn không đủ) =
 * `uncovered`, cần Admin xử lý tay.
 */
export function splitClosureRefund(
  unusedBalanceVnd: number,
  topUpsNewestFirst: { topUpId: number; amountPaidVnd: number }[],
): { allocations: { topUpId: number; amountVnd: number }[]; uncoveredVnd: number } {
  let left = unusedBalanceVnd;
  const allocations: { topUpId: number; amountVnd: number }[] = [];
  for (const t of topUpsNewestFirst) {
    if (left <= 0) break;
    const amount = Math.min(left, t.amountPaidVnd);
    allocations.push({ topUpId: t.topUpId, amountVnd: amount });
    left -= amount;
  }
  return { allocations, uncoveredVnd: Math.max(0, left) };
}

export const INVOICE_RETRY_LIMIT = 3;
