/** T150 / BR-P52 — hàm thuần của OfflineAuthCheckService (không cần DB). */
import {
  hasSmartCharging,
  parseConfiguration,
  riskReasonOf,
} from './offline-auth-check.service.js';

const v = (value: string, readonly = false) => ({ value, readonly });

describe('T150 parseConfiguration', () => {
  it('lấy key cần đọc, bỏ key lạ, key không trả = null', () => {
    const out = parseConfiguration({
      configurationKey: [
        { key: 'LocalAuthorizeOffline', value: 'true', readonly: true },
        { key: 'HeartbeatInterval', value: '60', readonly: false },
        { key: 'LocalPreAuthorize' },
      ],
      unknownKey: ['AllowOfflineTxForUnknownId'],
    });
    expect(out['LocalAuthorizeOffline']).toEqual(v('true', true));
    expect(out['LocalPreAuthorize']).toEqual({ value: null, readonly: false });
    expect(out['AllowOfflineTxForUnknownId']).toBeNull();
    expect(out).not.toHaveProperty('HeartbeatInterval');
  });
  it('phản hồi rỗng / sai dạng → mọi key null', () => {
    expect(Object.values(parseConfiguration({ configurationKey: 'x' }))).toEqual(
      Array(6).fill(null),
    );
  });
});

describe('T150 riskReasonOf', () => {
  const allTrue = {
    LocalAuthorizeOffline: v('true'),
    LocalPreAuthorize: v('TRUE'),
    AllowOfflineTxForUnknownId: v('true'),
  };
  it('đọc được false (không phân biệt hoa thường) hoặc Accepted → không rủi ro', () => {
    expect(
      riskReasonOf(
        { ...allTrue, LocalPreAuthorize: v('False') },
        { LocalAuthorizeOffline: 'Accepted', AllowOfflineTxForUnknownId: 'Accepted' },
      ),
    ).toBeNull();
  });
  it.each([
    ['Rejected', 'rejected'],
    ['NotSupported', 'not_supported'],
    ['RebootRequired', 'reboot_required'],
    ['timeout', 'no_response'],
    ['error', 'change_failed'],
  ] as const)('%s → %s', (change, reason) => {
    expect(
      riskReasonOf(allTrue, {
        LocalAuthorizeOffline: 'Accepted',
        LocalPreAuthorize: change,
        AllowOfflineTxForUnknownId: 'Accepted',
      }),
    ).toBe(reason);
  });
  it('key không có + NotSupported → key_missing', () => {
    expect(
      riskReasonOf(
        { ...allTrue, AllowOfflineTxForUnknownId: null },
        {
          LocalAuthorizeOffline: 'Accepted',
          LocalPreAuthorize: 'Accepted',
          AllowOfflineTxForUnknownId: 'NotSupported',
        },
      ),
    ).toBe('key_missing');
  });
});

it('T150 hasSmartCharging đọc danh sách CSL', () => {
  expect(hasSmartCharging('Core, SmartCharging')).toBe(true);
  expect(hasSmartCharging('Core,SmartChargingX')).toBe(false);
  expect(hasSmartCharging(null)).toBe(false);
});
