/**
 * Feedback after an action, or a warning on a page: a Mantine Alert with an icon in the tone's
 * colour. Errors are `role="alert"`, the rest `role="status"`. The text keeps the old
 * `queue-note <tone>` hook so the message element is the one tests and styles find.
 */
import { Alert } from '@mantine/core';
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { toneColor } from './tones';

export type NoticeTone = 'ok' | 'warn' | 'error' | 'info';
export type Note = { tone: NoticeTone; text: string } | null;

const ICON = {
  ok: IconCircleCheck,
  warn: IconAlertTriangle,
  error: IconAlertOctagon,
  info: IconInfoCircle,
} as const;

export function Notice({
  tone,
  title,
  children,
  className = 'queue-note',
  role,
  label,
  onClose,
}: {
  tone: NoticeTone;
  title?: ReactNode;
  children: ReactNode;
  /** Hook class on the message (`queue-note`, `note`); the tone is appended. */
  className?: string;
  role?: 'alert' | 'status' | 'note';
  /** Accessible name of the notice (e.g. a named warning on a detail page). */
  label?: string;
  onClose?: () => void;
}) {
  const Icon = ICON[tone];
  return (
    <Alert
      color={tone === 'info' ? 'slate' : toneColor(tone)}
      icon={<Icon size={20} aria-hidden="true" />}
      title={title}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-label={label}
      withCloseButton={!!onClose}
      onClose={onClose}
      closeButtonLabel="Đóng thông báo"
      className="notice"
      classNames={{ message: `${className} ${tone}` }}
    >
      {children}
    </Alert>
  );
}

/** The `[note, setNote]` pair every page with actions keeps. */
export const useNote = () => useState<Note>(null);
