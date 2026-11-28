import { buildPreview } from './tariff-preview.js';

// Biểu 7 khung của seed demo (apps/csms/demo/seed.sql): normal ×3, peak ×2, off_peak ×2.
const SEED = [
  ['00:00', '04:00', 'off_peak', 2800],
  ['04:00', '09:30', 'normal', 3800],
  ['09:30', '11:30', 'peak', 5500],
  ['11:30', '17:00', 'normal', 3800],
  ['17:00', '20:00', 'peak', 5500],
  ['20:00', '22:00', 'normal', 3800],
  ['22:00', '24:00', 'off_peak', 2800],
].map(([time_start, time_end, band, price]) => ({
  effective_from: '2026-01-01',
  time_start: time_start as string,
  time_end: time_end as string,
  band: band as 'off_peak' | 'normal' | 'peak',
  price: String(price),
}));

describe('buildPreview (BE-50)', () => {
  it('returns null when the Operator has no schedule in force', () => {
    expect(buildPreview([], '2026-11-28', '10:00:00')).toBeNull();
  });

  it('picks the current band with [start, end) boundaries, including 24:00', () => {
    const at = (t: string) => buildPreview(SEED, '2026-11-28', t)!.current;
    expect(at('16:59:59')).toMatchObject({
      band: 'normal',
      time_end: '17:00',
      price_per_kwh_vnd: 3800,
    });
    expect(at('17:00:00')).toMatchObject({
      band: 'peak',
      time_start: '17:00',
      price_per_kwh_vnd: 5500,
    });
    expect(at('00:00:00')).toMatchObject({ band: 'off_peak', time_start: '00:00' });
    expect(at('23:59:59')).toMatchObject({ band: 'off_peak', time_end: '24:00' });
  });

  it('lists every period in order (a band may repeat) and the highest price of the day', () => {
    const p = buildPreview([...SEED].reverse(), '2026-11-28', '12:00:00')!;
    expect(p).toMatchObject({
      currency: 'VND',
      unit: 'kWh',
      timezone: 'Asia/Ho_Chi_Minh',
      effective_date: '2026-11-28',
      max_price_per_kwh_vnd: 5500,
    });
    expect(p.periods.map((x) => x.time_start)).toEqual([
      '00:00',
      '04:00',
      '09:30',
      '11:30',
      '17:00',
      '20:00',
      '22:00',
    ]);
    expect(p.periods.filter((x) => x.band === 'normal')).toHaveLength(3);
  });

  it('shows only the newest schedule in force, but max follows every row the credit hold sees', () => {
    const old = [{ ...SEED[0]!, effective_from: '2025-01-01', time_end: '24:00', price: '9000' }];
    const p = buildPreview([...old, ...SEED], '2026-11-28', '12:00:00')!;
    expect(p.periods).toHaveLength(7);
    expect(p.max_price_per_kwh_vnd).toBe(9000);
  });

  it('current is null when the schedule has a gap at that time', () => {
    expect(buildPreview([SEED[1]!], '2026-11-28', '02:00:00')!.current).toBeNull();
  });
});
