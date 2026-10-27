import { loadChargePolicy } from './charge-policy.config.js';

describe('WP3/T72 runtime charging policy', () => {
  it('loads the documented configurable proposals', () => {
    expect(loadChargePolicy({})).toMatchObject({ minimumStartVnd: 50000, cutoffReserveVnd: 10000 });
    expect(loadChargePolicy({ CHARGE_MINIMUM_START_VND: '60000' }).minimumStartVnd).toBe(60000);
  });
  it.each(['-1', 'NaN', '1.1', 'Infinity'])('rejects invalid numeric configuration %s', (raw) => {
    expect(() => loadChargePolicy({ CHARGE_COMMAND_TIMEOUT_MS: raw })).toThrow(
      'invalid_charge_policy',
    );
  });
});
