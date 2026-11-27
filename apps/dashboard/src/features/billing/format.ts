/** Screens 32 / 33: labels and error text (FE-09, WF-02 D10). */
import type { RecheckResult, TopUpExceptionKind } from '@powerme/shared';
import { errorMessage, type ApiError } from '../../core/api/api';

export const vnd = (n: number) => `${n.toLocaleString('vi-VN')} ₫`;
export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export const EXCEPTION_KIND: Record<TopUpExceptionKind, string> = {
  unresolved_04: 'VNPay mã 04: chưa rõ kết quả',
  unresolved_07: 'VNPay mã 07: giao dịch bị nghi ngờ',
  loyalty_error: 'Lỗi trừ điểm thưởng',
};

export const ERROR_KIND = { transient: 'Lỗi tạm thời', data: 'Dữ liệu bị từ chối' } as const;

export function recheckText(r: RecheckResult): string {
  switch (r.result) {
    case 'late_payment_recorded':
      return 'VNPay xác nhận đã trả: đã ghi nhận thành khoản trả muộn';
    case 'already_recorded':
      return 'Khoản trả muộn này đã được ghi nhận trước đó';
    case 'conflicting_result':
      return 'Kết quả mâu thuẫn: đã đưa vào mục Trả mâu thuẫn';
    case 'not_paid':
      return 'VNPay xác nhận chưa thanh toán';
    case 'still_unresolved':
      return `Chưa có kết quả rõ ràng. Thử lại sau khoảng ${r.retry_after_minutes ?? 15} phút.`;
  }
}

export function billingError(err: unknown): string {
  const e = err as (Partial<ApiError> & { reason?: string }) | undefined;
  switch (e?.code) {
    case 'invalid_state':
      return 'Hoá đơn không còn ở trạng thái cần xem lại, danh sách đã được làm mới';
    case 'not_eligible':
      return 'Top-up không còn đủ điều kiện kiểm tra lại (có thể đã được đánh dấu đã xem)';
    case 'no_exception':
      return 'Top-up không còn ngoại lệ, danh sách đã được làm mới';
    case 'already_reviewed':
      return 'Mục này đã được xử lý, danh sách đã được làm mới';
    case 'payment_unconfigured':
      return 'Máy chủ chưa cấu hình VNPay';
    case 'not_found':
      return 'Không tìm thấy mục này, danh sách đã được làm mới';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ';
  }
  return errorMessage(err);
}
