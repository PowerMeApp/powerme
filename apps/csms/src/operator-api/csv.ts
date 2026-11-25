/**
 * CSV rules shared by `revenue.csv` (T108a) and `transactions.csv` (T108b) — contract §4 K9:
 *   - UTF-8 with BOM (Excel on Windows reads Vietnamese), comma, CRLF, RFC 4180 quoting.
 *   - Integers without thousands separators; empty cell for null.
 *   - CSV injection: a text cell starting with = + - @ tab or CR gets a leading `'` (site and
 *     Operator names are typed by users).
 *   - Instants in UTC+7 with offset; the JSON keeps UTC `Z`.
 */

export function cell(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header + rows → the file body: BOM, CRLF after every line. */
export function csvDocument(lines: string[]): string {
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** `2026-11-20T02:15:00.123Z` → `2026-11-20T09:15:00+07:00` (Vietnam has no DST). */
export function vietnamTime(iso: string): string {
  return `${new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 19)}+07:00`;
}
