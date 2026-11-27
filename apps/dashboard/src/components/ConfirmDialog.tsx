/**
 * Modal confirmation (Mantine Modal, role="dialog"): Escape or "Huỷ" cancels unless busy; focus is
 * trapped inside, starts on the confirm button and returns to the opener on close.
 */
import { Button, Group, Modal, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  danger,
  size = 480,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  /** Destructive action (lock, block, force reset): red confirm button. */
  danger?: boolean;
  size?: number | string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      opened
      onClose={onCancel}
      title={title}
      size={size}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      withCloseButton={false}
      classNames={{ title: 'dialog-title', body: 'dialog-body' }}
    >
      <Stack gap="md">
        {children}
        <Group justify="flex-end" gap="sm" mt="xs">
          <Button variant="subtle" color="slate" disabled={busy} onClick={onCancel}>
            Huỷ
          </Button>
          <Button
            color={danger ? 'danger' : 'teal'}
            disabled={busy}
            onClick={onConfirm}
            data-autofocus
          >
            {busy ? 'Đang gửi…' : confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
