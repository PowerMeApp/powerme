import { checkTariffTime, parseChargePointTime } from './tariff-clock.js';

const time = (ms: number) => new Date(Date.UTC(2026, 10, 11, 5) + ms);
const receipt = {
  receivedAt: time(60000),
  openedAt: time(30000),
  closedAt: null,
  firstOpenedAt: time(0),
  epoch: 2,
};

describe('T101 charge-point tariff clock', () => {
  it.each([
    '2026-02-30T05:00:00Z',
    '2026-11-11T24:00:00Z',
    '2026-11-11T05:00:00',
    '2026-11-11T05:00:00.0001Z',
    'invalid',
  ])('rejects invalid or ambiguous raw timestamp %s', (raw) => {
    expect(parseChargePointTime(raw)).toBeNull();
  });

  it('normalizes explicit ICT offset to the same UTC instant', () => {
    expect(parseChargePointTime('2026-11-11T12:00:00+07:00')).toEqual(time(0));
  });

  it('uses the tariff tolerance inclusively for live frames and rejects future lead', () => {
    expect(checkTariffTime(time(65000), receipt, 5000)).toBeUndefined();
    expect(checkTariffTime(time(65001), receipt, 5000)).toBe('tariff_clock_future_timestamp');
  });

  it('accepts a prior-epoch event with known history regardless of delivery delay', () => {
    expect(checkTariffTime(time(20000), receipt, 5000)).toBeUndefined();
    expect(checkTariffTime(time(20000), { ...receipt, firstOpenedAt: null }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
  });

  it('holds same-epoch lag unless the sample belongs to a validated stop batch', () => {
    expect(checkTariffTime(time(40000), receipt, 5000)).toBe('tariff_clock_ambiguous_delay');
    expect(checkTariffTime(time(40000), receipt, 5000, true)).toBeUndefined();
  });

  it('holds missing or invalid CSMS receipt evidence and receipts after close', () => {
    expect(checkTariffTime(time(60000), { ...receipt, openedAt: null }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
    expect(checkTariffTime(time(60000), { ...receipt, receivedAt: new Date(NaN) }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
    expect(checkTariffTime(time(60000), { ...receipt, closedAt: time(59999) }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
  });
});
