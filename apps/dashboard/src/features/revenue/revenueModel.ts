/**
 * Revenue report (FE-07, screens 25 / 35) — pure helpers, no React. Days and periods follow
 * Asia/Ho_Chi_Minh (UTC+7, no daylight saving), as the T108 report does (contract §4, K3).
 */
import type { RevenueBucket, RevenueGroupBy, RevenueRow } from '@powerme/shared';

const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;
/** Contract: a period is at most 366 days. */
export const MAX_PERIOD_DAYS = 366;

export const GROUP_LABEL: Record<RevenueGroupBy, string> = {
  operator: 'Operator',
  site: 'Charging Station',
  charge_point: 'Charge Point',
  day: 'Ngày',
};

/** Reasons a reconciled session was not debited (T108 `unsettled.by_reason`); unknown codes show as is. */
export const REASON_LABEL: Record<string, string> = {
  promotion: 'Có khuyến mãi',
  rfid_card: 'Thẻ RFID chờ T115',
  rfid_pending: 'Thẻ RFID chờ T115',
};
export const reasonLabel = (code: string) => REASON_LABEL[code] ?? code;

export const EMPTY_BUCKET: RevenueBucket = {
  csms_billed_session_count: 0,
  csms_billed_energy_wh: 0,
  csms_billed_revenue_vnd: 0,
  unattributed_session_count: 0,
  unattributed_energy_wh: 0,
};

/** YYYY-MM-DD of `ms` in Vietnam. */
export function vnDay(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Default period: the current month in Vietnam, day 1 to today. */
export function defaultPeriod(now = Date.now()): { from: string; to: string } {
  const to = vnDay(now);
  return { from: `${to.slice(0, 8)}01`, to };
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isDay = (s: string | null) => s !== null && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dayMs(s));

/** Days in [from, to], both included; null if the period is invalid or longer than the contract allows. */
export function periodDays(from: string, to: string): number | null {
  if (!isDay(from) || !isDay(to)) return null;
  const n = (dayMs(to) - dayMs(from)) / DAY_MS + 1;
  return n >= 1 && n <= MAX_PERIOD_DAYS ? n : null;
}

/**
 * `group_by=day`: the report only has days with sessions (T108); add a zero row for every other
 * day of the period so the table shows the whole period in order. Existing rows are kept as is.
 */
export function fillDays(rows: readonly RevenueRow[], from: string, to: string): RevenueRow[] {
  const n = periodDays(from, to);
  if (n === null) return [...rows];
  const byDay = new Map(rows.map((r) => [r.day ?? r.key, r]));
  const out: RevenueRow[] = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(dayMs(from) + i * DAY_MS).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { key: day, day, ...EMPTY_BUCKET });
  }
  // Rows outside the period (should not happen) are kept at the end rather than dropped.
  for (const r of rows) if (!out.includes(r)) out.push(r);
  return out;
}

/** Name shown for a row in the given grouping. */
export function rowLabel(row: RevenueRow, groupBy: RevenueGroupBy): string {
  switch (groupBy) {
    case 'operator':
      return row.operator_name ?? row.key;
    case 'site':
      return row.site_name ?? row.key;
    case 'charge_point':
      return row.serial_number ?? row.key;
    case 'day':
      return formatDay(row.day ?? row.key);
  }
}

/** 2026-11-05 → 05/11/2026. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return y && m && d ? `${d}/${m}/${y}` : day;
}

const VND = new Intl.NumberFormat('vi-VN');
export const formatVnd = (n: number) => `${VND.format(n)} ₫`;
export const formatCount = (n: number) => VND.format(n);
export const formatKwh = (wh: number) =>
  `${(wh / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kWh`;

/** "tính đến lúc 20/11/2026 09:15" in Vietnam time. */
export function formatGenerated(iso: string): string {
  const ms = Date.parse(iso);
  if (isNaN(ms)) return iso;
  const t = new Date(ms + VN_OFFSET_MS).toISOString();
  return `${formatDay(t.slice(0, 10))} ${t.slice(11, 16)}`;
}
