/** Status groups with their count, hiding the groups that are 0 (D36). Replaces `Counts`. */
import { formatCount } from '../features/revenue/revenueModel';
import { StatusBadge } from './StatusBadge';

export function CountList<K extends string>({
  rows,
  values,
}: {
  /** [key, label, tone] */
  rows: readonly (readonly [K, string, string])[];
  values: Partial<Record<K, number>>;
}) {
  const shown = rows.filter(([k]) => (values[k] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="count-list">
      {shown.map(([k, label, tone]) => (
        <li key={k}>
          <StatusBadge tone={tone}>{label}</StatusBadge> <b>{formatCount(values[k]!)}</b>
        </li>
      ))}
    </ul>
  );
}
