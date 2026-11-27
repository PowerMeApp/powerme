/**
 * Red round count with white text, so pending work is seen at a glance (menu, tabs, home tile).
 * Hidden at 0; `label` is read by screen readers ("3 phiên cần xử lý").
 */
import { Badge, type BadgeProps } from '@mantine/core';

export function CountBadge({
  count,
  label,
  size = 'md',
}: {
  count: number | undefined;
  label: string;
  size?: BadgeProps['size'];
}) {
  if (!count) return null;
  return (
    <Badge
      component="span"
      className="count-badge"
      role="status"
      aria-label={`${count} ${label}`}
      color="danger"
      variant="filled"
      radius="xl"
      size={size}
    >
      {count > 99 ? '99+' : count}
    </Badge>
  );
}
