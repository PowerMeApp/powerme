/**
 * Unit test bảng chuyển connector — T13 mục 2.1: chuyển bất thường được GHI và GẮN CỜ, không
 * bị từ chối, nên ở đây chỉ kiểm hàm phân loại `isExpectedTransition`.
 */
import {
  CONNECTOR_STATUSES,
  ConnectorStatus,
  isConnectorStatus,
  isExpectedTransition,
  VALID_CONNECTOR_TRANSITIONS,
} from './valid-transitions.js';

type Case = [from: ConnectorStatus, to: ConnectorStatus, note: string];

const VALID_CASES: Case[] = [
  ['Unavailable', 'Available', 'H1 — StatusNotification(Available) đầu tiên sau boot'],
  ['Available', 'Preparing', 'A2 — cắm súng / quẹt thẻ'],
  ['Preparing', 'Charging', 'B3 — StartTransaction'],
  ['Charging', 'SuspendedEV', 'C5'],
  ['SuspendedEV', 'Charging', 'D3'],
  ['Charging', 'Finishing', 'C6 — StopTransaction'],
  ['Finishing', 'Available', 'F1 — rút súng'],
  ['Available', 'Reserved', 'A7 — ReserveNow'],
  ['Reserved', 'Preparing', 'G2'],
  ['Charging', 'Faulted', 'C9'],
  ['Faulted', 'Unavailable', 'I8 — T13 2.3 #14'],
  ['Available', 'Unavailable', 'A8 — ChangeAvailability(Inoperative)'],
];

const UNEXPECTED_CASES: Case[] = [
  ['Available', 'Finishing', 'không có A6'],
  ['Finishing', 'Charging', 'không có F3'],
  ['Reserved', 'Charging', 'không có G3'],
  ['Unavailable', 'Finishing', 'không có H6'],
  ['Preparing', 'Reserved', 'không có B7'],
  ['SuspendedEVSE', 'Reserved', 'không có E7'],
];

describe('valid-transitions (connector, OCPP 1.6 mục 4.9)', () => {
  it('đủ 9 giá trị ChargePointStatus, mỗi giá trị có dòng trong bảng', () => {
    expect(CONNECTOR_STATUSES).toHaveLength(9);
    for (const s of CONNECTOR_STATUSES) expect(VALID_CONNECTOR_TRANSITIONS[s]).toBeDefined();
  });

  it.each(VALID_CASES)('%s → %s hợp lệ (%s)', (from, to) => {
    expect(isExpectedTransition(from, to)).toBe(true);
  });

  it.each(UNEXPECTED_CASES)('%s → %s bất thường (%s) — vẫn ghi, chỉ gắn cờ', (from, to) => {
    expect(isExpectedTransition(from, to)).toBe(false);
  });

  it('cùng trạng thái (trụ gửi lại sau reboot) không coi là bất thường — quy ước PowerMe', () => {
    expect(isExpectedTransition('Available', 'Available')).toBe(true);
    expect(isExpectedTransition('Charging', 'Charging')).toBe(true);
  });

  it('trạng thái trước chưa biết (null) thì không gắn cờ', () => {
    expect(isExpectedTransition(null, 'Charging')).toBe(true);
  });

  it('isConnectorStatus từ chối giá trị ngoài enum', () => {
    expect(isConnectorStatus('Charging')).toBe(true);
    expect(isConnectorStatus('charging')).toBe(false);
    expect(isConnectorStatus('Occupied')).toBe(false);
  });

  it('bảng EXP-01: toàn bộ chuỗi StatusNotification của hai súng đều hợp lệ (0 cờ)', () => {
    const c1 = [
      'Available',
      'Available',
      'Preparing',
      'Charging',
      'Finishing',
      'Available',
      'Preparing',
      'Charging',
      'Finishing',
      'Available',
    ] as const;
    const c2 = [
      'Available',
      'Available',
      'Preparing',
      'Charging',
      'Finishing',
      'Available',
      'Preparing',
      'Charging',
    ] as const;
    for (const seq of [c1, c2]) {
      let prev: (typeof seq)[number] | 'Unavailable' = 'Unavailable';
      for (const next of seq) {
        expect(isExpectedTransition(prev, next)).toBe(true);
        prev = next;
      }
    }
  });
});
