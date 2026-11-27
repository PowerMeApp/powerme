/**
 * Red round count with white text, so pending work is seen at a glance (menu, tabs, home tile).
 * Hidden at 0; `label` is read by screen readers ("3 phiên cần xử lý").
 */
export function CountBadge({ count, label }: { count: number | undefined; label: string }) {
  if (!count) return null;
  return (
    <span className="count-badge" role="status" aria-label={`${count} ${label}`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
