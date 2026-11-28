/**
 * Hàm thuần cho hoá đơn điện tử của top-up (T32 Phần 7, decisions D5): thuế suất theo thời điểm thu
 * tiền, tách phần VAT nằm trong số thực thu, số hoá đơn giả của stub; Phần 9b: thuế của điều chỉnh
 * giảm (thuế suất gốc), kiểm trần / chờ gốc issued trước khi gửi, số điều chỉnh giả.
 *
 * Vì sao tồn tại: thuế suất và cách làm tròn phải ở MỘT chỗ để `requestForTopUp` (lúc tạo dòng),
 * migration 0025 (backfill, cùng quy tắc viết bằng SQL) và Phần 9 (`adjustForRefund`, đọc `vat_rate`
 * của hoá đơn gốc) không lệch nhau. Không đọc biến môi trường.
 */

/**
 * Mốc đổi thuế suất: 2027-01-01 00:00:00 giờ Việt Nam (+07:00) = 2026-12-31T17:00:00Z.
 *
 * Dịch vụ sạc xe điện thuộc nhóm hàng hoá, dịch vụ chịu thuế suất 10% được giảm còn 8% theo Nghị
 * quyết 204/2025/QH15 và Nghị định 174/2025/NĐ-CP (hết hiệu lực 31/12/2026); từ mốc trở về 10% (Luật
 * Thuế GTGT 48/2024/QH15). Đã đối chiếu Phụ lục I–II NĐ 174/2025 (17/11): dịch vụ sạc không thuộc danh
 * mục loại trừ; căn cứ ở decisions D5. Thuế suất đổi / được gia hạn thì sửa ở đây (và test hai phía
 * mốc), không qua biến môi trường.
 */
export const VAT_RATE_CHANGE_AT = new Date('2027-01-01T00:00:00+07:00');

/** Thuế suất được giảm, áp dụng trước `VAT_RATE_CHANGE_AT`. */
export const REDUCED_VAT_RATE = 8;
/** Thuế suất phổ thông, áp dụng từ `VAT_RATE_CHANGE_AT`. */
export const STANDARD_VAT_RATE = 10;

/** Các mức hợp lệ (CHECK `e_invoices_vat_rate_check`, 0025). */
export const VAT_RATES: readonly number[] = [0, 5, 8, 10];

/**
 * Thuế suất GTGT (%) theo **thời điểm thu tiền** (`top_ups.completed_at`, ghi cùng transaction cộng
 * tiền), không theo lúc gọi nhà cung cấp: retry có thể vắt qua 31/12.
 */
export function vatRateAt(collectedAt: Date): number {
  const t = collectedAt.getTime();
  if (!Number.isFinite(t)) throw new RangeError('vatRateAt: thời điểm không hợp lệ');
  return t < VAT_RATE_CHANGE_AT.getTime() ? REDUCED_VAT_RATE : STANDARD_VAT_RATE;
}

/**
 * Phần thuế nằm trong tổng đã gồm VAT: round(amount × r / (100 + r)), làm tròn nửa lên, tính bằng
 * BigInt (tiền là VND nguyên, không dùng số thực).
 *
 * @param amountVnd số thực thu, đã gồm VAT (`top_ups.amount_paid_vnd`), nguyên ≥ 0
 * @param rate thuế suất %, một trong `VAT_RATES`
 */
export function splitVat(amountVnd: number, rate: number): number {
  if (!Number.isSafeInteger(amountVnd) || amountVnd < 0)
    throw new RangeError(`splitVat: amountVnd phải là số nguyên ≥ 0, nhận ${amountVnd}`);
  if (!VAT_RATES.includes(rate)) throw new RangeError(`splitVat: thuế suất không hợp lệ ${rate}`);
  const a = BigInt(amountVnd);
  const r = BigInt(rate);
  const d = 100n + r;
  return Number((2n * a * r + d) / (2n * d));
}

/**
 * Số hoá đơn giả của stub: `STUB-` + base36 (chữ hoa) của khoá idempotent (`e_invoices.id`). Ổn định
 * theo khoá (gọi lại cùng khoá → cùng số), duy nhất vì id duy nhất, tối đa 18 ký tự
 * (`invoice_no varchar(20)`).
 */
export function stubInvoiceNo(idempotencyKey: string): string {
  if (!/^[1-9]\d{0,18}$/.test(idempotencyKey) || BigInt(idempotencyKey) > 2n ** 63n - 1n)
    throw new RangeError(`stubInvoiceNo: khoá phải là id bigint dương, nhận '${idempotencyKey}'`);
  return `STUB-${BigInt(idempotencyKey).toString(36).toUpperCase()}`;
}

// -------------------------------------------------------------------------------------------------
// Hoá đơn điều chỉnh khi hoàn tiền (T32 Phần 9b, D5)
// -------------------------------------------------------------------------------------------------

/**
 * Phần thuế (âm) của một điều chỉnh giảm `amountVnd` (âm, đã gồm VAT), theo thuế suất của **hoá đơn
 * gốc** (`e_invoices.vat_rate`), không tính lại theo ngày hoàn. Cùng cách làm tròn với `splitVat`.
 * Viết `0 - x` để số 0 không thành `-0`.
 */
export function adjustmentVat(amountVnd: number, rate: number): number {
  if (!Number.isSafeInteger(amountVnd) || amountVnd > 0)
    throw new RangeError(`adjustmentVat: amountVnd phải là số nguyên ≤ 0, nhận ${amountVnd}`);
  return 0 - splitVat(-amountVnd, rate);
}

/** Lỗi phát hiện trước khi gọi nhà cung cấp; cùng dạng lỗi của nhà cung cấp (STM-7 #3). */
export type AdjustmentPrecheckError =
  | { kind: 'data'; message: 'adjustment_exceeds_original' | 'adjustment_not_decrease' }
  | { kind: 'transient'; message: 'original_not_issued' };

/**
 * Kiểm một điều chỉnh có gửi được chưa, lúc tới lượt gửi (không chặn lúc tạo: refund done không bao
 * giờ rollback vì hoá đơn). Thứ tự: lỗi vĩnh viễn trước.
 *   1. `amountVnd >= 0` → data `adjustment_not_decrease` (9b chỉ tạo điều chỉnh giảm);
 *   2. Σ |điều chỉnh khác của cùng hoá đơn, mọi trạng thái| + |dòng này| > số hoá đơn gốc → data
 *      `adjustment_exceeds_original` (mỗi dòng ứng với một refund đã done, tiền đã trả lại thật);
 *   3. hoá đơn gốc chưa `issued` → transient `original_not_issued` (chờ gốc có số, theo lịch retry).
 * `null` = gửi được.
 */
export function checkAdjustmentSendable(input: {
  originalStatus: string;
  originalAmountVnd: number;
  otherAdjustmentsAbsVnd: number;
  amountVnd: number;
}): AdjustmentPrecheckError | null {
  if (input.amountVnd >= 0) return { kind: 'data', message: 'adjustment_not_decrease' };
  if (input.otherAdjustmentsAbsVnd + -input.amountVnd > input.originalAmountVnd)
    return { kind: 'data', message: 'adjustment_exceeds_original' };
  if (input.originalStatus !== 'issued')
    return { kind: 'transient', message: 'original_not_issued' };
  return null;
}

/** Khoá lớn nhất `stubAdjustmentNo` nhận: `STUBADJ-` (8) + 12 ký tự base36 = 20 = `varchar(20)`. */
export const STUB_ADJUSTMENT_KEY_MAX = 36n ** 12n - 1n;

/**
 * Số điều chỉnh giả của stub: `STUBADJ-` + base36 (chữ hoa) của khoá idempotent
 * (`invoice_adjustments.id`). Ổn định theo khoá, ≤ 20 ký tự (`provider_adjustment_no varchar(20)`).
 * Khoá > `STUB_ADJUSTMENT_KEY_MAX` (~4,7 × 10^18, id thật không tới) → RangeError.
 */
export function stubAdjustmentNo(idempotencyKey: string): string {
  if (!/^[1-9]\d{0,18}$/.test(idempotencyKey) || BigInt(idempotencyKey) > STUB_ADJUSTMENT_KEY_MAX)
    throw new RangeError(
      `stubAdjustmentNo: khoá phải là id dương ≤ 36^12 − 1, nhận '${idempotencyKey}'`,
    );
  return `STUBADJ-${BigInt(idempotencyKey).toString(36).toUpperCase()}`;
}
