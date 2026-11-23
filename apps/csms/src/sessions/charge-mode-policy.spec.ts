import {
  chargeLimit,
  meteredCostBounds,
  modeCreditPolicy,
  scaledInteger,
  validateChargeStart,
  type ChargeStartInput,
} from './charge-mode-policy.js';
import type { ChargePolicy } from './charge-start-policy.js';

const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 1000,
  stationStaleAfterMs: 600000,
};
const identity = { connectorId: 1, vehicleId: 2 };
describe('WP3 four-mode start policy', () => {
  const modes: ChargeStartInput[] = [
    { ...identity, mode: 'full' },
    { ...identity, mode: 'timed', durationMinutes: 60 },
    { ...identity, mode: 'energy_kwh', energyLimitWh: 10000 },
    { ...identity, mode: 'amount_vnd', amountLimitVnd: 100000 },
  ];
  it.each(modes)('requires minimum credit for $mode', (input) => {
    expect(modeCreditPolicy(49999, input, 5000, 60000, policy)).toEqual({
      outcome: 'topuprequired',
    });
  });
  it('reserves available budget for full without inventing battery capacity', () => {
    expect(chargeLimit(modes[0]!)).toBeNull();
    expect(modeCreditPolicy(123456, modes[0]!, 5000, null, policy)).toEqual({
      outcome: 'eligible',
      reserveVnd: 123456,
    });
  });
  it('offers explicit minutes and VND caps and retains the energy cap', () => {
    expect(modeCreditPolicy(50000, modes[1]!, 5000, 60000, policy)).toEqual({
      outcome: 'requiresconfirmation',
      maxDurationMinutes: 10,
    });
    expect(
      modeCreditPolicy(
        50000,
        { ...modes[1]!, durationMinutes: 10 } as ChargeStartInput,
        5000,
        60000,
        policy,
      ),
    ).toEqual({ outcome: 'eligible', reserveVnd: 50000 });
    expect(modeCreditPolicy(50000, modes[3]!, 5000, null, policy)).toEqual({
      outcome: 'requiresconfirmation',
      maxAmountVnd: 50000,
    });
    expect(
      modeCreditPolicy(
        50000,
        { ...identity, mode: 'energy_kwh', energyLimitWh: 10001 },
        5000,
        null,
        policy,
      ),
    ).toEqual({ outcome: 'requiresconfirmation', maxEnergyWh: 10000 });
  });
  it('rounds the combined timed reservation upward once and rejects unknown power', () => {
    expect(
      modeCreditPolicy(50000, { ...identity, mode: 'timed', durationMinutes: 1 }, 5001, 1, policy),
    ).toEqual({ outcome: 'eligible', reserveVnd: 1 });
    expect(() => modeCreditPolicy(50000, modes[1]!, 5000, null, policy)).toThrow(
      'power_unavailable',
    );
    expect(
      modeCreditPolicy(
        50000,
        { ...identity, mode: 'timed', durationMinutes: Number.MAX_SAFE_INTEGER },
        5000,
        60000,
        policy,
      ),
    ).toEqual({ outcome: 'requiresconfirmation', maxDurationMinutes: 10 });
  });
  it.each([0, -1, true, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid limits %s',
    (limit) => {
      for (const [mode, field] of [
        ['timed', 'durationMinutes'],
        ['energy_kwh', 'energyLimitWh'],
        ['amount_vnd', 'amountLimitVnd'],
      ]) {
        expect(() =>
          validateChargeStart({
            ...identity,
            mode,
            [field!]: limit,
          } as unknown as ChargeStartInput),
        ).toThrow('invalid_input');
      }
    },
  );
  it('rejects wrong-mode fields and converts decimal readings exactly', () => {
    expect(() =>
      validateChargeStart({
        ...identity,
        mode: 'full',
        energyLimitWh: 1,
      } as unknown as ChargeStartInput),
    ).toThrow('invalid_input');
    expect(scaledInteger('1.000100', 6)).toBe(1000100n);
    expect(scaledInteger('0.0001', 3)).toBeNull();
  });
});

describe('WP3 cumulative tariff bounds', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 19, 0, minutes));
  const tariffs = [
    { id: '1', starts: at(0), ends: at(10), price: '1000' },
    { id: '2', starts: at(10), ends: at(20), price: '5000' },
  ];
  it('prices measured portions across tiers and rounds the exact total once (BR-P45)', () => {
    expect(
      meteredCostBounds(
        [
          { at: at(0), milliWh: 0n },
          { at: at(10), milliWh: 1000500n },
          { at: at(20), milliWh: 2000500n },
        ],
        tariffs,
      ),
    ).toEqual({ minVnd: 6001, maxVnd: 6001, quality: 'exact' });
  });
  it('bounds a sparse crossing without claiming the maximum tariff as actual cost', () => {
    expect(
      meteredCostBounds(
        [
          { at: at(0), milliWh: 0n },
          { at: at(20), milliWh: 2000000n },
        ],
        tariffs,
      ),
    ).toEqual({ minVnd: 2000, maxVnd: 10000, quality: 'bounded' });
  });
  it('returns unknown for gaps, conflicting equal timestamps and decreasing meters', () => {
    const points = [
      { at: at(0), milliWh: 0n },
      { at: at(20), milliWh: 2000000n },
    ];
    expect(meteredCostBounds(points, tariffs.slice(1))).toBeNull();
    expect(meteredCostBounds([points[0]!, { ...points[0]!, milliWh: 1n }], tariffs)).toBeNull();
    expect(meteredCostBounds([points[1]!, { at: at(20), milliWh: 1n }], tariffs)).toBeNull();
    expect(meteredCostBounds([points[0]!, points[0]!], tariffs)).toEqual({
      minVnd: 0,
      maxVnd: 0,
      quality: 'exact',
    });
  });
});
