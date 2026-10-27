/** Luật thuần mà UI và mock dùng chung: STM-6, bảng mã lỗi, BR-P21, biểu giá 4 khung. */
import {
  canApplyFault,
  FAULT_STATUSES,
  FAULT_TRIGGERS,
  nextFaultStatus,
} from '../src/features/alerts/faultStateMachine';
import { ERROR_CODE_GUIDE, guideFor } from '../src/features/alerts/errorCodeGuide';
import { canRefundTopUp, splitClosureRefund } from '../src/features/billing/rules';
import { validateBands } from '../src/features/tariffs/validateBands';
import type { TariffPeriod } from '../src/types/domain';

describe('STM-6 phía dashboard — khớp FaultStateMachine của csms (FE-04)', () => {
  it.each([
    ['raised', 'ACKNOWLEDGE', 'acknowledged'],
    ['raised', 'CONNECTOR_AVAILABLE', 'resolved'],
    ['acknowledged', 'RESET_SENT', 'resetting'],
    ['resetting', 'CONNECTOR_AVAILABLE', 'resolved'],
    ['resetting', 'RESET_FAILED', 'acknowledged'],
    ['acknowledged', 'CONNECTOR_AVAILABLE', 'resolved'],
    ['acknowledged', 'OPERATOR_CLOSE', 'resolved'],
  ] as const)('%s --%s--> %s', (from, trigger, to) => {
    expect(nextFaultStatus(from, trigger)).toBe(to);
  });

  it('quét 4 × 6 = 24 cặp: 7 hợp lệ, 3 no-op (SIGNAL khi mở), 14 bị từ chối', () => {
    let valid = 0;
    let noop = 0;
    let rejected = 0;
    for (const s of FAULT_STATUSES) {
      for (const t of FAULT_TRIGGERS) {
        const to = nextFaultStatus(s, t);
        if (to === null) rejected += 1;
        else if (t === 'SIGNAL') noop += 1;
        else valid += 1;
        expect(canApplyFault(s, t)).toBe(to !== null);
      }
    }
    expect([valid, noop, rejected]).toEqual([7, 3, 14]);
  });
});

describe('ErrorCodeGuide', () => {
  it('đủ 16 mã OCPP 1.6; mã lạ → OtherError', () => {
    expect(Object.keys(ERROR_CODE_GUIDE)).toHaveLength(16);
    expect(guideFor('RH-E42')).toBe(ERROR_CODE_GUIDE['OtherError']);
    expect(guideFor('GroundFailure').severity).toBe('critical');
  });
});

describe('Billing (UC-ADM-08)', () => {
  it('chỉ hoàn toàn bộ khi số dư ≥ số top-up (STM-4 #7, BR-P21)', () => {
    expect(canRefundTopUp(230_000, 200_000)).toBe(true);
    expect(canRefundTopUp(200_000, 200_000)).toBe(true);
    expect(canRefundTopUp(120_000, 300_000)).toBe(false);
  });

  it('đóng tài khoản: hoàn về top-up mới nhất trước, không vượt số đã thu', () => {
    expect(
      splitClosureRefund(140_000, [
        { topUpId: 3, amountPaidVnd: 100_000 },
        { topUpId: 2, amountPaidVnd: 100_000 },
        { topUpId: 1, amountPaidVnd: 100_000 },
      ]),
    ).toEqual({
      allocations: [
        { topUpId: 3, amountVnd: 100_000 },
        { topUpId: 2, amountVnd: 40_000 },
      ],
      uncoveredVnd: 0,
    });
    expect(splitClosureRefund(50_000, [{ topUpId: 1, amountPaidVnd: 20_000 }]).uncoveredVnd).toBe(
      30_000,
    );
  });
});

describe('Biểu giá bốn khung giờ', () => {
  const ok: TariffPeriod[] = [
    { band: 'Off-peak', start: '00:00', end: '06:00', pricePerKwhVnd: 2400 },
    { band: 'Shoulder', start: '06:00', end: '10:00', pricePerKwhVnd: 3200 },
    { band: 'Peak', start: '10:00', end: '17:00', pricePerKwhVnd: 4100 },
    { band: 'Sharp', start: '17:00', end: '24:00', pricePerKwhVnd: 4800 },
  ];

  it('phủ đủ 24 h, không chồng, đủ 4 khung → hợp lệ', () => {
    expect(validateBands(ok)).toEqual([]);
  });

  it('chồng giờ, hở giờ, giá 0, thiếu khung → báo lỗi', () => {
    const bad = ok.map((p) => ({ ...p }));
    bad[1] = { ...bad[1]!, start: '05:00' };
    expect(validateBands(bad)).toContain('Các khung giờ đang chồng lên nhau');
    expect(validateBands(ok.slice(0, 3))).toEqual(
      expect.arrayContaining([
        'Còn khoảng giờ chưa thuộc khung nào (phải phủ đủ 24 h)',
        'Thiếu khung Sharp',
      ]),
    );
    expect(validateBands([{ ...ok[0]!, pricePerKwhVnd: 0, end: '24:00' }])).toContain(
      'Dòng 1: giá phải lớn hơn 0',
    );
    expect(validateBands([{ ...ok[0]!, start: '7h' }])).toContain('Dòng 1: giờ phải có dạng HH:MM');
  });
});
