/** Screen 28: labels and error text (FE-19). */
import type { UserAccount } from '@powerme/shared';
import { errorMessage, type ApiError } from '../../core/api/api';

export const ROLE: Record<UserAccount['role'], string> = {
  driver: 'Tài xế',
  operator_staff: 'Nhân viên Operator',
  admin: 'Admin',
};
export const STAFF_ROLE = { manager: 'Quản lý', technician: 'Kỹ thuật viên' } as const;
export const STATUS: Record<UserAccount['account_status'], [string, string]> = {
  active: ['Đang hoạt động', ''],
  suspended: ['Đang bị khoá', 'major'],
  closed: ['Đã đóng', 'muted'],
};

/** The form field a server refusal is about (shown under it); null = form-level. */
export function userErrorField(err: unknown): 'email' | 'phone_number' | 'operator_id' | null {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'email_taken':
      return 'email';
    case 'phone_taken':
      return 'phone_number';
    case 'operator_not_found':
      return 'operator_id';
  }
  return null;
}

export function userError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'email_taken':
      return 'Email đã được dùng cho tài khoản khác';
    case 'phone_taken':
      return 'Số điện thoại đã được dùng cho tài khoản khác';
    case 'operator_not_found':
      return 'Không tìm thấy Operator này';
    case 'role_change_not_allowed':
      return 'Không đổi được vai trò của tài xế';
    case 'cannot_change_own_role':
      return 'Không tự đổi vai trò của chính mình';
    case 'cannot_lock_self':
      return 'Không tự khoá tài khoản của chính mình';
    case 'invalid_transition':
      return 'Tài khoản đã đổi trạng thái, danh sách đã được làm mới';
    case 'not_found':
      return 'Không tìm thấy tài khoản này';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ';
  }
  return errorMessage(err);
}
