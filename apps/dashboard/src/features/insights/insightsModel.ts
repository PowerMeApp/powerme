/**
 * Home page statistics (screens 17 / 27) — pure helpers, no React. Days are Vietnam days
 * (Asia/Ho_Chi_Minh), as in the revenue report (revenueModel.ts) and the fault stats route.
 */
import type { FaultSeverityCounts, FaultStats, RevenueBucket, RevenueRow } from '@powerme/shared';
import { EMPTY_BUCKET, vnDay } from '../revenue/revenueModel';

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** `day` moved by `n` days (YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** First day of the month of `day`. */
const monthStart = (day: string) => `${day.slice(0, 8)}01`;

/** A period of whole days, both ends included. */
export interface Span {
  from: string;
  to: string;
}

/** Days shown by the trend charts. */
export const TREND_DAYS = 30;

/**
 * The periods of the home page, from today in Vietnam:
 *   today / yesterday, last 7 days / the 7 before, this month so far / the same days of last month,
 *   last month (whole), the last 30 days (charts), and `query`: one span covering them all.
 */
export function insightPeriods(now = Date.now()) {
  const today = vnDay(now);
  const thisMonth = monthStart(today);
  const lastMonthEnd = addDays(thisMonth, -1);
  const lastMonthStart = monthStart(lastMonthEnd);
  // Same days of last month: 1st → today's day number, cut at the end of last month.
  const sameDay = Math.min(Number(today.slice(8)), Number(lastMonthEnd.slice(8)));
  const trend: Span = { from: addDays(today, -(TREND_DAYS - 1)), to: today };
  return {
    today: { from: today, to: today },
    yesterday: { from: addDays(today, -1), to: addDays(today, -1) },
    week: { from: addDays(today, -6), to: today },
    prevWeek: { from: addDays(today, -13), to: addDays(today, -7) },
    month: { from: thisMonth, to: today },
    monthBefore: {
      from: lastMonthStart,
      to: `${lastMonthStart.slice(0, 8)}${String(sameDay).padStart(2, '0')}`,
    },
    lastMonth: { from: lastMonthStart, to: lastMonthEnd },
    trend,
    /** Revenue by day for all of the above in one request (at most 62 days). */
    query: { from: lastMonthStart < trend.from ? lastMonthStart : trend.from, to: today },
  };
}

/** Sum of the day rows whose day is in `span` (rows without a day are ignored). */
export function sumRange(rows: readonly RevenueRow[], span: Span): RevenueBucket {
  const sum = { ...EMPTY_BUCKET };
  for (const r of rows) {
    if (!r.day || r.day < span.from || r.day > span.to) continue;
    sum.csms_billed_session_count += r.csms_billed_session_count;
    sum.csms_billed_energy_wh += r.csms_billed_energy_wh;
    sum.csms_billed_revenue_vnd += r.csms_billed_revenue_vnd;
    sum.unattributed_session_count += r.unattributed_session_count;
    sum.unattributed_energy_wh += r.unattributed_energy_wh;
  }
  return sum;
}

/** Change from `prev` to `cur` in percent, rounded; null when there is nothing to compare with. */
export function deltaPct(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** One point per day of `span` (01/11 labels), from day rows; days without sessions are 0. */
export function revenueSeries(rows: readonly RevenueRow[], span: Span) {
  const byDay = new Map(rows.filter((r) => r.day).map((r) => [r.day!, r]));
  return eachDay(span).map((day) => {
    const r = byDay.get(day);
    return {
      day,
      label: shortDay(day),
      revenue: r?.csms_billed_revenue_vnd ?? 0,
      sessions: (r?.csms_billed_session_count ?? 0) + (r?.unattributed_session_count ?? 0),
      kwh: ((r?.csms_billed_energy_wh ?? 0) + (r?.unattributed_energy_wh ?? 0)) / 1000,
    };
  });
}

/** One point per day of `span` from the fault stats (only days with faults come from the API). */
export function faultSeries(days: FaultStats['days'], span: Span) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const zero: FaultSeverityCounts = { critical: 0, major: 0, minor: 0, none: 0 };
  return eachDay(span).map((day) => {
    const d = byDay.get(day);
    return {
      day,
      label: shortDay(day),
      critical: d?.critical ?? zero.critical,
      major: d?.major ?? zero.major,
      minor: d?.minor ?? zero.minor,
      none: d?.none ?? zero.none,
    };
  });
}

function eachDay(span: Span): string[] {
  const out: string[] = [];
  for (let d = span.from; d <= span.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 2026-11-05 → 05/11. */
export const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** 5 400 s → "1 giờ 30 phút"; under a minute → "< 1 phút". */
export function formatDuration(s: number): string {
  if (s < 60) return '< 1 phút';
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  if (hours > 0) return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  return `${minutes} phút`;
}

/** 1 250 000 → "1,3 tr"; for chart axes only (tooltips show the full amount). */
export function compactVnd(n: number): string {
  if (Math.abs(n) >= 1e9)
    return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`;
  if (Math.abs(n) >= 1e6)
    return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`;
  if (Math.abs(n) >= 1e3)
    return `${(n / 1e3).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} k`;
  return n.toLocaleString('vi-VN');
}
