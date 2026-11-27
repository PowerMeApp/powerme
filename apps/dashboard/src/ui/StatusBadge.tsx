/**
 * Status pill (Mantine Badge) in one of the shared tones. The text sits in an inner span that keeps
 * the old `pill <tone>` hook and the tooltip, so `getByText` lands on the element that carries them.
 */
import { Badge, type BadgeProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { toneColor } from './tones';

export function StatusBadge({
  tone = '',
  title,
  children,
  size = 'md',
  variant = 'light',
  leftSection,
}: {
  tone?: string;
  title?: string;
  children: ReactNode;
  size?: BadgeProps['size'];
  variant?: BadgeProps['variant'];
  leftSection?: ReactNode;
}) {
  return (
    <Badge
      color={toneColor(tone)}
      size={size}
      variant={variant}
      leftSection={leftSection}
      className="status-badge"
    >
      <span className={tone ? `pill ${tone}` : 'pill'} title={title}>
        {children}
      </span>
    </Badge>
  );
}
