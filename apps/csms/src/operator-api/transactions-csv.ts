/**
 * `transactions.csv` (contract §4.1, K9, K10; T108b): the same rows as the JSON list, every page.
 *   - Rules of csv.ts: BOM, comma, CRLF, RFC 4180, CSV injection guard, empty cell for null.
 *   - Header = the 24 `TransactionRow` fields in contract order, then `generated_at`; rows in the
 *     JSON order (period_at DESC, session_id DESC) with `generated_at` empty.
 *   - `started_at`, `stopped_at`, `period_at`, `generated_at` in UTC+7 with offset; JSON keeps `Z`.
 *   - Last line `TOTAL`: session_id = TOTAL, amount_vnd = totals.csms_billed_revenue_vnd,
 *     energy_wh = Σ energy_wh of every row in the file (any kind, nulls skipped), generated_at set,
 *     every other cell empty.
 */
import type { TransactionExport, TransactionRow } from './admin-transactions.js';
import { cell, csvDocument, vietnamTime } from './csv.js';

export const TRANSACTION_COLUMNS = [
  'session_id',
  'transaction_no',
  'kind',
  'session_status',
  'payment_mode',
  'origin',
  'operator_id',
  'operator_name',
  'site_id',
  'site_code',
  'site_name',
  'charge_point_id',
  'serial_number',
  'connector_no',
  'started_at',
  'stopped_at',
  'period_at',
  'period_day',
  'energy_wh',
  'amount_vnd',
  'unsettled_reason',
  'driver_id',
  'promotion_code',
  'delivered_offline',
] as const satisfies readonly (keyof TransactionRow)[];

type Cell = string | number | boolean | null;
const COLUMNS = [...TRANSACTION_COLUMNS, 'generated_at'] as const;

export function toTransactionsCsv(data: TransactionExport): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const row of data.items) {
    const values: Record<string, Cell> = {
      ...row,
      started_at: vietnamTime(row.started_at),
      stopped_at: row.stopped_at === null ? null : vietnamTime(row.stopped_at),
      period_at: vietnamTime(row.period_at),
    };
    lines.push(COLUMNS.map((c) => cell(values[c] ?? null)).join(','));
  }
  const total: Record<string, Cell> = {
    session_id: 'TOTAL',
    energy_wh: data.all_energy_wh,
    amount_vnd: data.totals.csms_billed_revenue_vnd,
    generated_at: vietnamTime(data.generated_at),
  };
  lines.push(COLUMNS.map((c) => cell(total[c] ?? null)).join(','));
  return csvDocument(lines);
}
