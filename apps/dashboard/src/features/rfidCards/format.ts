/** Screen 30 (RFID Cards): labels, the actions each card allows (T161 point 3) and error text. */
import type { RfidCard, RfidCardKind, RfidCardStatus } from '@powerme/shared';
import { errorMessage, type ApiError } from '../../core/api/api';

export const KIND: Record<RfidCardKind, string> = { online: 'Online', free_vend: 'Free vend' };

/** Same words as the RFID tile of screen 27; [label, pill tone]. */
export const STATUS: Record<RfidCardStatus, [string, string]> = {
  active: ['Đang dùng', ''],
  unlinked: ['Chưa gắn tài xế', 'muted'],
  blocked: ['Bị chặn', 'major'],
};

export type CardAction = 'link' | 'unlink' | 'block' | 'unblock';

/**
 * Only the valid actions (T161 point 3): unlinked → link, block; active → unlink, block; blocked →
 * unblock. A free-vend card never has a driver (contract §3.8a), so it only blocks / unblocks.
 */
export function cardActions(card: RfidCard): CardAction[] {
  if (card.status === 'blocked') return ['unblock'];
  if (card.card_kind === 'free_vend') return ['block'];
  return card.status === 'active' ? ['unlink', 'block'] : ['link', 'block'];
}

/**
 * Unblocking an online card with no driver needs a driver in the same request: the API answers 400
 * to `status=active` alone there (contract §3.8a).
 */
export const unblockNeedsDriver = (card: RfidCard) =>
  card.card_kind === 'online' && card.driver === null;

/** At most 20 characters (Unicode scalars, as the API counts), not blank. */
export const MAX_CARD_ID = 20;
export const validCardId = (raw: string) => {
  const v = raw.trim();
  return v.length > 0 && [...v].length <= MAX_CARD_ID;
};

/**
 * Text for each API error code (T161 point 4), never the raw error. Both the codes in T161 and the
 * ones the merged API (T146, #233) answers are mapped.
 */
export function rfidError(err: unknown): string {
  switch ((err as Partial<ApiError> | undefined)?.code) {
    case 'card_already_registered':
    case 'card_identifier_taken':
      return 'Mã thẻ đã được đăng ký';
    case 'tag_conflicts_with_card':
      return 'Mã thẻ trùng free-vend tag của một trụ sạc';
    case 'driver_not_eligible':
      return 'Tài xế bị khoá hoặc đã đóng tài khoản';
    case 'driver_not_found':
      return 'Không tìm thấy tài xế này';
    case 'card_kind_has_no_driver':
      return 'Thẻ free vend không gắn tài xế';
    case 'invalid_card_transition':
      return 'Thẻ đã đổi trạng thái, danh sách đã được tải lại';
    case 'not_found':
      return 'Không tìm thấy thẻ này, danh sách đã được tải lại';
    case 'invalid_input':
      return 'Dữ liệu không hợp lệ (mã thẻ 1–20 ký tự)';
  }
  return errorMessage(err);
}
