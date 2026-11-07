import { loadChargePolicy } from './charge-policy.config.js';

describe('WP3/T72 runtime charging policy', () => {
  it('loads the documented configurable proposals', () => {
    expect(loadChargePolicy({})).toMatchObject({ minimumStartVnd: 50000, cutoffReserveVnd: 10000 });
    expect(loadChargePolicy({ CHARGE_MINIMUM_START_VND: '60000' }).minimumStartVnd).toBe(60000);
  });
  it('loads the BE-17 RemoteStop retry defaults and overrides', () => {
    expect(loadChargePolicy({})).toMatchObject({
      remoteStopRetryMax: 3,
      remoteStopRetryIntervalMs: 30000,
    });
    expect(
      loadChargePolicy({ REMOTE_STOP_RETRY_MAX: '0', REMOTE_STOP_RETRY_INTERVAL_S: '5' }),
    ).toMatchObject({ remoteStopRetryMax: 0, remoteStopRetryIntervalMs: 5000 });
    expect(() => loadChargePolicy({ REMOTE_STOP_RETRY_INTERVAL_S: '0' })).toThrow(
      'invalid_charge_policy',
    );
  });
  it.each(['-1', 'NaN', '1.1', 'Infinity'])('rejects invalid numeric configuration %s', (raw) => {
    expect(() => loadChargePolicy({ CHARGE_COMMAND_TIMEOUT_MS: raw })).toThrow(
      'invalid_charge_policy',
    );
  });
});
