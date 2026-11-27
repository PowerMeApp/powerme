/** Screen 24: labels, pills and error text (FE-06). */
import type { Promotion, TariffBand } from '@powerme/shared';
import { errorMessage, type ApiError } from '../../core/api/api';

export const BAND: Record<TariffBand, [string, string]> = {
  peak: ['Cao điểm', 'major'],
  normal: ['Bình thường', ''],
  off_peak: ['Thấp điểm', 'muted'],
};

export const vnd = (n: number) => `${n.toLocaleString('vi-VN')} ₫`;

/** Đang chạy / Sắp chạy / Đã kết thúc. */
export function promotionStatus(p: Promotion, now = Date.now()): [string, string] {
  if (p.active) return ['Đang chạy', ''];
  return new Date(p.valid_from).getTime() > now ? ['Sắp chạy', 'muted'] : ['Đã kết thúc', 'muted'];
}

export const promotionEnded = (p: Promotion, now = Date.now()) =>
  new Date(p.valid_to).getTime() <= now;

/** ISO → value of <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pricingError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'tariff_gap_or_overlap':
      return 'Các khung giờ phải phủ kín 00:00–24:00 và không chồng nhau';
    case 'effective_from_in_past':
      return 'Ngày áp dụng không được ở quá khứ';
    case 'schedule_in_use':
      return 'Biểu giá bắt đầu hôm nay đã có phiên sạc dùng, hãy chọn từ ngày mai';
    case 'promotion_code_taken':
      return 'Mã khuyến mãi đã được dùng';
    case 'promotion_expired':
      return 'Khuyến mãi đã kết thúc, danh sách đã được làm mới';
    case 'not_found':
      return 'Không tìm thấy khuyến mãi này';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ';
  }
  return errorMessage(err);
}
