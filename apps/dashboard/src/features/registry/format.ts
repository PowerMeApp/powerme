/** Device registry: field limits and error text. */
import { errorMessage, type ApiError } from '../../core/api/api';

export const MAX_MODEL = 20;

export function registryError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'serial_already_registered':
      return 'Serial đã có trong sổ đăng ký';
    case 'invalid_input':
      return `Dữ liệu không hợp lệ (serial 3–25 ký tự, model tối đa ${MAX_MODEL} ký tự)`;
  }
  return errorMessage(err);
}
