/**
 * BE-30 — chuẩn hoá số điện thoại tài xế về E.164 (dùng chung cho register và login).
 *
 * Vì sao tồn tại: tài xế đăng nhập được bằng số điện thoại (BE-30), nên cùng một số phải luôn ra
 * cùng một chuỗi trong DB, dù app gửi `0901234567`, `+84 901 234 567` hay `84901234567`. UNIQUE
 * `users_phone_number_key` (migration 0017) chỉ chặn trùng đúng khi mọi số đã cùng một dạng.
 *
 * Quy tắc (ghi lại ở docs/api/DRIVER-API-HOP-DONG.md mục BE-30; migration 0017 dùng cùng quy tắc
 * cho dữ liệu cũ, viết lại bằng SQL):
 * 1. Bỏ dấu cách (mọi khoảng trắng), `.`, `-`, `(`, `)`. Chuỗi gốc dài quá 32 ký tự → từ chối.
 * 2. Phần còn lại phải là `+` (tuỳ chọn, chỉ ở đầu) rồi toàn chữ số.
 * 3. Số Việt Nam — số quốc gia (NSN) 9–10 chữ số, không bắt đầu bằng 0:
 *    `0` + NSN · `84` + NSN (không có `+`) · `+84` + NSN · `+84 0` + NSN (số 0 trung kế thừa)
 *    → `+84` + NSN.
 * 4. Số nước khác: bắt đầu bằng `+`, mã nước không phải 84, tổng 7–15 chữ số, chữ số đầu khác 0
 *    → giữ nguyên dạng E.164 (tối đa 16 ký tự, vừa cột varchar(16)). Không kiểm độ dài theo từng
 *    nước (không có thư viện số điện thoại; ngoài phạm vi).
 * 5. Còn lại (số không `+` và không bắt đầu bằng `0`/`84`, `+84` sai độ dài, chữ cái…) → null.
 */
const SEPARATORS = /[\s.\-()]/g;
const MAX_RAW_LENGTH = 32;
/** NSN Việt Nam: di động 9 chữ số (9x, 8x, 7x, 5x, 3x), cố định 10 chữ số (2xx…). */
const VN_NSN = /^[1-9][0-9]{8,9}$/;
const E164_DIGITS = /^[1-9][0-9]{6,14}$/;

/** Trả E.164 (`+84901234567`) hoặc null nếu không nhận ra là số điện thoại hợp lệ. */
export function normalizePhoneNumber(raw: string): string | null {
  if (raw.length > MAX_RAW_LENGTH) return null;
  const compact = raw.replace(SEPARATORS, '');
  if (!/^\+?[0-9]+$/.test(compact)) return null;
  if (compact.startsWith('+')) {
    const digits = compact.slice(1);
    if (digits.startsWith('84')) {
      const nsn = digits.slice(2).replace(/^0/, '');
      return VN_NSN.test(nsn) ? `+84${nsn}` : null;
    }
    return E164_DIGITS.test(digits) ? `+${digits}` : null;
  }
  if (compact.startsWith('0')) {
    const nsn = compact.slice(1);
    return VN_NSN.test(nsn) ? `+84${nsn}` : null;
  }
  if (compact.startsWith('84')) {
    const nsn = compact.slice(2);
    return VN_NSN.test(nsn) ? `+84${nsn}` : null;
  }
  return null;
}
