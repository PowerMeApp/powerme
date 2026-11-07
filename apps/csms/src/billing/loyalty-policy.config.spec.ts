import { loadLoyaltyPolicy } from './loyalty-policy.config.js';

describe('loadLoyaltyPolicy', () => {
  it('mặc định 12 tháng như WP3', () => {
    expect(loadLoyaltyPolicy({})).toEqual({ pointsExpiryMonths: 12 });
    expect(loadLoyaltyPolicy({ CHARGE_POINTS_EXPIRY_MONTHS: '' })).toEqual({
      pointsExpiryMonths: 12,
    });
  });

  it('đọc CHARGE_POINTS_EXPIRY_MONTHS', () => {
    expect(loadLoyaltyPolicy({ CHARGE_POINTS_EXPIRY_MONTHS: '6' })).toEqual({
      pointsExpiryMonths: 6,
    });
  });

  it.each(['0', '-1', '1.5', 'abc'])('từ chối %s', (v) => {
    expect(() => loadLoyaltyPolicy({ CHARGE_POINTS_EXPIRY_MONTHS: v })).toThrow(
      'invalid_loyalty_policy',
    );
  });
});
