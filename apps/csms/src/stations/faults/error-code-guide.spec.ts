/**
 * Unit test ErrorCodeGuide — đủ 16 mã ChargePointErrorCode của OCPP 1.6, NoError không phải lỗi,
 * mã lạ rơi về OtherError, và bốn mã chờ WP1 được đánh dấu.
 */
import {
  CHARGE_POINT_ERROR_CODES,
  compareSeverity,
  ERROR_CODE_GUIDE,
  guideFor,
  isChargePointErrorCode,
} from './error-code-guide.js';

describe('ErrorCodeGuide', () => {
  it('có đúng 16 mã của OCPP 1.6 mục 7.6, mỗi mã một mục', () => {
    expect(CHARGE_POINT_ERROR_CODES).toHaveLength(16);
    expect(Object.keys(ERROR_CODE_GUIDE).sort()).toEqual([...CHARGE_POINT_ERROR_CODES].sort());
  });

  it.each(CHARGE_POINT_ERROR_CODES.filter((c) => c !== 'NoError'))(
    '%s có severity khác none và gợi ý không rỗng',
    (code) => {
      const g = ERROR_CODE_GUIDE[code];
      expect(g.severity).not.toBe('none');
      expect(g.hint.length).toBeGreaterThan(10);
    },
  );

  it('NoError không phải lỗi', () => {
    expect(ERROR_CODE_GUIDE.NoError.severity).toBe('none');
  });

  it('mã lạ (vendor tự đặt) hoặc null → OtherError', () => {
    expect(isChargePointErrorCode('RH-E42')).toBe(false);
    expect(guideFor('RH-E42')).toBe(ERROR_CODE_GUIDE.OtherError);
    expect(guideFor(null)).toBe(ERROR_CODE_GUIDE.OtherError);
    expect(guideFor('GroundFailure')).toBe(ERROR_CODE_GUIDE.GroundFailure);
  });

  it('bốn mã có hướng xử lý riêng trong SRS phần cứng đang chờ WP1 (WF-04 câu hỏi 1)', () => {
    // Đổi danh sách này khi WP1 gửi hướng xử lý chính thức — test fail để nhắc cập nhật gợi ý.
    expect(CHARGE_POINT_ERROR_CODES.filter((c) => ERROR_CODE_GUIDE[c].pendingWp1 === true)).toEqual(
      ['GroundFailure', 'HighTemperature', 'OverCurrentFailure', 'PowerMeterFailure'],
    );
  });

  it('sắp xếp severity: critical < major < minor < none', () => {
    const sorted = (['none', 'minor', 'critical', 'major'] as const).slice().sort(compareSeverity);
    expect(sorted).toEqual(['critical', 'major', 'minor', 'none']);
  });
});
