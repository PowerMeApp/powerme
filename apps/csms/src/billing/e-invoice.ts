/**
 * Hàm thuần cho hoá đơn điện tử của top-up (T32 Phần 7, decisions D5): thuế suất theo thời điểm thu
 * tiền, tách phần VAT nằm trong số thực thu, số hoá đơn giả của stub.
 *
 * Vì sao tồn tại: thuế suất và cách làm tròn phải ở MỘT chỗ để `requestForTopUp` (lúc tạo dòng),
 * migration 0025 (backfill, cùng quy tắc viết bằng SQL) và Phần 9 (`adjustForRefund`, đọc `vat_rate`
 * của hoá đơn gốc) không lệch nhau. Không đọc biến môi trường.
 */

/**
 * Mốc đổi thuế suất: 2027-01-01 00:00:00 giờ Việt Nam (+07:00) = 2026-12-31T17:00:00Z.
 *
 * GIẢ ĐỊNH (decisions "Còn mở", T32 Phần 7 17/11): dịch vụ sạc xe điện thuộc nhóm hàng hoá, dịch vụ
 * chịu thuế suất 10% được giảm còn 8% theo Nghị quyết 204/2025/QH15 và Nghị định 174/2025/NĐ-CP (hết
 * hiệu lực 31/12/2026). CHƯA tra Phụ lục I–III của Nghị định 174/2025 (danh mục không được giảm). Nếu
 * dịch vụ này thuộc danh mục loại trừ thì chỉ sửa `vatRateAt` (và viết migration cho dòng đã ghi).
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
