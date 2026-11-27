/**
 * Switch between the queues of one screen (sessions, billing exceptions, pricing): a segmented
 * group of toggle buttons (`aria-pressed`), each with its red pending count.
 */
import { Button } from '@mantine/core';
import type { ReactNode } from 'react';
import { CountBadge } from '../components/CountBadge';

export function QueueSwitch<K extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: K;
  onChange: (key: K) => void;
  items: readonly { key: K; label: ReactNode; count?: number | undefined; countLabel?: string }[];
}) {
  return (
    <div className="queue-switch" role="group" aria-label={label}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Button
            key={it.key}
            type="button"
            size="sm"
            variant={on ? 'filled' : 'subtle'}
            color={on ? 'teal' : 'slate'}
            aria-pressed={on}
            onClick={() => onChange(it.key)}
            rightSection={
              it.countLabel ? <CountBadge count={it.count} label={it.countLabel} /> : undefined
            }
          >
            {it.label}
          </Button>
        );
      })}
    </div>
  );
}
