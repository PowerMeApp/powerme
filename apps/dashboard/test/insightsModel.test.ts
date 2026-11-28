/** Home page statistics — period math, sums, deltas and day series (features/insights). */
import type { RevenueRow } from '@powerme/shared';
import {
  addDays,
  compactVnd,
  deltaPct,
  faultSeries,
  formatDuration,
  insightPeriods,
  revenueSeries,
  sumRange,
} from '../src/features/insights/insightsModel';
import { EMPTY_BUCKET } from '../src/features/revenue/revenueModel';

const row = (day: string, vnd: number, sessions = 1): RevenueRow => ({
  key: day,
  operator_id: null,
  operator_name: null,
  site_id: null,
  site_name: null,
  charge_point_id: null,
  serial_number: null,
  day,
  ...EMPTY_BUCKET,
  csms_billed_revenue_vnd: vnd,
  csms_billed_session_count: sessions,
  csms_billed_energy_wh: 10_000,
});

describe('insightPeriods', () => {
  it('uses the Vietnam day: 27/11 01:00 in Vietnam is still 26/11 in UTC', () => {
    const p = insightPeriods(Date.parse('2026-11-26T18:00:00Z'));
    expect(p.today).toEqual({ from: '2026-11-27', to: '2026-11-27' });
    expect(p.yesterday.from).toBe('2026-11-26');
    expect(p.week).toEqual({ from: '2026-11-21', to: '2026-11-27' });
    expect(p.prevWeek).toEqual({ from: '2026-11-14', to: '2026-11-20' });
    expect(p.month).toEqual({ from: '2026-11-01', to: '2026-11-27' });
    expect(p.monthBefore).toEqual({ from: '2026-10-01', to: '2026-10-27' });
    expect(p.lastMonth).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(p.trend).toEqual({ from: '2026-10-29', to: '2026-11-27' });
    // One request covers last month and the 30-day trend.
    expect(p.query).toEqual({ from: '2026-10-01', to: '2026-11-27' });
  });

  it('cuts the same days of last month at its end (31/03 → 01–28/02)', () => {
    const p = insightPeriods(Date.parse('2027-03-31T05:00:00Z'));
    expect(p.monthBefore).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(p.lastMonth).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    // Early in a month the trend reaches further back than last month.
    const early = insightPeriods(Date.parse('2026-12-02T05:00:00Z'));
    expect(early.query.from).toBe('2026-11-01');
    expect(early.trend.from).toBe('2026-11-03');
  });

  it('crosses the year', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    const p = insightPeriods(Date.parse('2027-01-05T05:00:00Z'));
    expect(p.lastMonth).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('sums and deltas', () => {
  const rows = [row('2026-11-01', 100), row('2026-11-02', 200), row('2026-11-05', 50)];
  it('sums the rows inside the span only', () => {
    const s = sumRange(rows, { from: '2026-11-02', to: '2026-11-05' });
    expect(s.csms_billed_revenue_vnd).toBe(250);
    expect(s.csms_billed_session_count).toBe(2);
    expect(sumRange(rows, { from: '2026-12-01', to: '2026-12-31' })).toEqual(EMPTY_BUCKET);
  });
  it('gives the change in percent, or null without a previous figure', () => {
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(50, 100)).toBe(-50);
    expect(deltaPct(10, 0)).toBeNull();
  });
});

describe('day series', () => {
  it('has one point per day, zero on days without sessions', () => {
    const s = revenueSeries([row('2026-11-02', 200, 3)], { from: '2026-11-01', to: '2026-11-03' });
    expect(s.map((d) => [d.label, d.revenue, d.sessions, d.kwh])).toEqual([
      ['01/11', 0, 0, 0],
      ['02/11', 200, 3, 10],
      ['03/11', 0, 0, 0],
    ]);
  });
  it('fills the fault days the API leaves out', () => {
    const s = faultSeries(
      [{ day: '2026-11-02', critical: 1, major: 0, minor: 2, none: 0, total: 3 }],
      { from: '2026-11-01', to: '2026-11-02' },
    );
    expect(s).toEqual([
      { day: '2026-11-01', label: '01/11', critical: 0, major: 0, minor: 0, none: 0 },
      { day: '2026-11-02', label: '02/11', critical: 1, major: 0, minor: 2, none: 0 },
    ]);
  });
});

describe('formats', () => {
  it('durations', () => {
    expect(formatDuration(30)).toBe('< 1 phút');
    expect(formatDuration(5400)).toBe('1 giờ 30 phút');
    expect(formatDuration(7200)).toBe('2 giờ');
    expect(formatDuration(90_000)).toBe('1 ngày 1 giờ');
  });
  it('compact amounts for axes', () => {
    expect(compactVnd(1_250_000)).toBe('1,3 tr');
    expect(compactVnd(2_000_000_000)).toBe('2 tỷ');
    expect(compactVnd(45_000)).toBe('45 k');
  });
});
