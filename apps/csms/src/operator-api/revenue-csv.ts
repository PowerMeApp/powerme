/**
 * `revenue.csv` (contract §4, K9; T108a): the same `RevenueReport` as the JSON route, as CSV.
 *   - UTF-8 with BOM (Excel on Windows reads Vietnamese), comma, CRLF, RFC 4180 quoting.
 *   - Header = `RevenueRow` fields then `RevenueBucket` fields, then `generated_at`; rows in the
 *     JSON order; last line `TOTAL` = `totals`, the only line with `generated_at` ("tính đến lúc").
 *   - Integers without thousands separators; empty cell for null.
 *   - CSV injection: a text cell starting with = + - @ tab or CR gets a leading `'` (site and
 *     Operator names are typed by users).
 *   - `generated_at` in UTC+7 with offset (K9); the JSON keeps UTC `Z`.
 * The cell / BOM / time rules live in csv.ts (shared with transactions.csv, T108b).
 */
import { cell, csvDocument, vietnamTime } from './csv.js';
import type { RevenueReport } from './revenue-report.js';

const COLUMNS = [
  'key',
  'operator_id',
  'operator_name',
  'site_id',
  'site_name',
  'charge_point_id',
  'serial_number',
  'day',
  'csms_billed_session_count',
  'csms_billed_energy_wh',
  'csms_billed_revenue_vnd',
  'unattributed_session_count',
  'unattributed_energy_wh',
  'generated_at',
] as const;

export function toRevenueCsv(report: RevenueReport): string {
  const lines = [COLUMNS.join(',')];
  for (const row of report.rows) {
    const values: Record<string, string | number | null> = { ...row };
    lines.push(COLUMNS.map((c) => cell(values[c] ?? null)).join(','));
  }
  const total: Record<string, string | number | null> = {
    ...report.totals,
    key: 'TOTAL',
    generated_at: vietnamTime(report.generated_at),
  };
  lines.push(COLUMNS.map((c) => cell(total[c] ?? null)).join(','));
  return csvDocument(lines);
}
