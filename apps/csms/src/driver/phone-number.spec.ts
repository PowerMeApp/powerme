/**
 * BE-30 — quy tắc chuẩn hoá số điện thoại (phone-number.ts). Migration 0017 viết lại cùng quy tắc
 * bằng SQL; test `migration-0017` chạy CHÍNH các ca dưới đây qua SQL để hai bản không lệch nhau.
 */
import { PHONE_CASES } from '../../test/helpers/phone-cases.js';
import { normalizePhoneNumber } from './phone-number.js';

describe('normalizePhoneNumber (BE-30)', () => {
  it.each(PHONE_CASES)('%j → %j', (raw, expected) => {
    expect(normalizePhoneNumber(raw)).toBe(expected);
  });

  it('kết quả luôn là E.164 vừa cột varchar(16)', () => {
    for (const [raw] of PHONE_CASES) {
      const out = normalizePhoneNumber(raw);
      if (out !== null) {
        expect(out).toMatch(/^\+[1-9][0-9]{6,14}$/);
        expect(out.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('chuẩn hoá lại một số đã chuẩn hoá cho đúng số đó (idempotent)', () => {
    for (const [raw] of PHONE_CASES) {
      const out = normalizePhoneNumber(raw);
      if (out !== null) expect(normalizePhoneNumber(out)).toBe(out);
    }
  });
});
