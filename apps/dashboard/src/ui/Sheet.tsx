/**
 * A side sheet for longer forms (onboarding, tariff editor): Mantine Drawer from the right, with a
 * focus trap and focus returned on close. `closeOnEscape` is the caller's (busy, or a one-time
 * credential on screen that must not be lost).
 */
import { Drawer } from '@mantine/core';
import type { ReactNode } from 'react';

export function Sheet({
  title,
  onClose,
  closeOnEscape = true,
  size = 620,
  className,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  closeOnEscape?: boolean;
  size?: number | string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Drawer
      opened
      onClose={onClose}
      title={title}
      size={size}
      closeOnEscape={closeOnEscape}
      closeOnClickOutside={false}
      withCloseButton={false}
      className={className}
      classNames={{ body: 'sheet-body', title: 'sheet-title' }}
    >
      {children}
    </Drawer>
  );
}
