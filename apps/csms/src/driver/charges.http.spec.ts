import { startInput } from './charges.http.js';

const identity = { connector_id: '1', vehicle_id: '2' };
describe('WP3 discriminated charge HTTP body', () => {
  it.each([
    [{ mode: 'full' }, { mode: 'full' }],
    [
      { mode: 'timed', duration_minutes: 10 },
      { mode: 'timed', durationMinutes: 10 },
    ],
    [
      { mode: 'energy_kwh', energy_limit_wh: 10000 },
      { mode: 'energy_kwh', energyLimitWh: 10000 },
    ],
    [
      { mode: 'amount_vnd', amount_limit_vnd: 50000 },
      { mode: 'amount_vnd', amountLimitVnd: 50000 },
    ],
  ])('parses %j without unit conversion', (wire, parsed) => {
    expect(startInput({ ...identity, ...wire })).toEqual({
      connectorId: 1,
      vehicleId: 2,
      ...parsed,
    });
  });
  it.each([0, -1, true, null, NaN, Infinity, 1.2, '10', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid limit %s',
    (limit) => {
      expect(() => startInput({ ...identity, mode: 'timed', duration_minutes: limit })).toThrow(
        'invalid_input',
      );
    },
  );
  it.each([
    { mode: 'full', energy_limit_wh: 1 },
    { mode: 'timed', energy_limit_wh: 1 },
    { mode: 'amount_vnd', amount_limit_vnd: 1, duration_minutes: 1 },
    { mode: 'energy_kwh' },
    { mode: 'timed', duration_minutes: 1, duration_seconds: 60 },
    { mode: '__proto__' },
    { mode: 'toString' },
  ])('rejects wrong or extra fields %j', (body) => {
    expect(() => startInput({ ...identity, ...body })).toThrow();
  });
});
