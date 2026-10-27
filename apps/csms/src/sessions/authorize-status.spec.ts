/**
 * Unit test ánh xạ rfid_cards.status (STM-8) → idTagInfo.status của Authorize — không DB.
 *
 * BM02 F22: trước đây chỉ `blocked` bị từ chối, thẻ `unlinked` vẫn Accepted. BR-P06: không phiên
 * nào bắt đầu nếu idTag không Accepted. Đường có DB (tra sổ, thẻ lạ) nằm ở
 * test/session-history.integration.test.ts.
 */
import { authorizeStatusFor } from './sessions.service.js';

describe('authorizeStatusFor — STM-8 → OCPP 1.6 AuthorizationStatus', () => {
  it.each([
    ['active', 'Accepted'],
    ['blocked', 'Blocked'],
    ['unlinked', 'Invalid'],
  ] as const)('%s → %s', (status, expected) => {
    expect(authorizeStatusFor(status)).toBe(expected);
  });
});
