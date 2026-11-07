import { ChargePolicy, startCreditPolicy, validateChargePolicy } from './charge-start-policy.js';

const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 1000,
  stationStaleAfterMs: 600000,
};

describe('WP3/T31 start credit policy (synthetic configuration)', () => {
  it('DS01 reserves the requested energy at the supplied upper tariff', () => {
    expect(startCreditPolicy(200000, 10000, 5000, policy)).toEqual({
      outcome: 'eligible',
      reserveVnd: 50000,
    });
  });
  it('DS02 returns topuprequired below the configured minimum', () => {
    expect(startCreditPolicy(30000, 10000, 5000, policy)).toEqual({ outcome: 'topuprequired' });
  });
  it('uses available credit and a configurable minimum, including the exact boundary', () => {
    expect(
      startCreditPolicy(30000, 1000, 5000, { ...policy, minimumStartVnd: 30000 }).outcome,
    ).toBe('eligible');
    expect(startCreditPolicy(-1, 1000, 5000, policy).outcome).toBe('topuprequired');
    expect(startCreditPolicy(50000, 10001, 5000, policy)).toEqual({
      outcome: 'requiresconfirmation',
      maxEnergyWh: 10000,
    });
  });
  it('rounds reservation upward without floating point money', () => {
    expect(startCreditPolicy(50000, 1, 5001, policy)).toEqual({
      outcome: 'eligible',
      reserveVnd: 6,
    });
  });
  it.each([0, -1, NaN, Infinity, 1.1])('rejects invalid energy %s', (energy) => {
    expect(() => startCreditPolicy(200000, energy, 5000, policy)).toThrow('invalid_start_input');
  });
  it('rejects invalid policy rather than guessing', () => {
    expect(() => validateChargePolicy({ ...policy, pointsExpiryMonths: 0 })).toThrow(
      'invalid_charge_policy',
    );
  });
});
