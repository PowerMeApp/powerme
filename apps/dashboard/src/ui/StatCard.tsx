/**
 * One summary card (home pages, network totals, revenue totals): a named region with a title, a
 * figure, optional status groups and a "Xem chi tiết →" link. `tone` turns it into an alert card
 * (danger or warning tint, accent bar, icon) for work that needs someone now.
 */
import { Anchor, Card, Group, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconAlertOctagon } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function StatCard({
  label,
  title = label,
  icon,
  tone,
  urgent,
  to,
  linkText = 'Xem chi tiết →',
  wide,
  className,
  children,
}: {
  /** Accessible name of the region (tests and screen readers). */
  label: string;
  /** Visible title, when it differs from the region name. */
  title?: string;
  icon?: ReactNode;
  /** Alert card: critical = red, major = amber. */
  tone?: 'critical' | 'major' | undefined;
  /** Pending work, ordered first (old `.tile-urgent` hook). */
  urgent?: boolean;
  to?: string | undefined;
  linkText?: string;
  /** Spans two grid columns. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = ['card', 'tile'];
  if (urgent) classes.push('tile-urgent');
  if (wide) classes.push('tile-wide');
  if (className) classes.push(className);
  const alertIcon =
    tone === 'critical' ? <IconAlertOctagon size={18} /> : <IconAlertTriangle size={18} />;
  return (
    <Card component="section" aria-label={label} className={classes.join(' ')} data-tone={tone}>
      <Group gap="xs" wrap="nowrap" className="tile-head">
        {tone ? (
          <ThemeIcon
            size="md"
            radius="sm"
            variant="light"
            color={tone === 'critical' ? 'danger' : 'warning'}
            aria-hidden="true"
          >
            {alertIcon}
          </ThemeIcon>
        ) : (
          icon && (
            <ThemeIcon size="md" radius="sm" variant="light" color="slate" aria-hidden="true">
              {icon}
            </ThemeIcon>
          )
        )}
        <Title order={2} className="tile-title">
          {title}
        </Title>
      </Group>
      <div className="tile-body">{children}</div>
      {to && (
        <Anchor component={Link} to={to} className="tile-link">
          {linkText}
        </Anchor>
      )}
    </Card>
  );
}

/** The big number of a card; `note` is the dimmed text after it ("/ 3 đang kết nối"). */
export function Figure({ value, note }: { value: ReactNode; note?: ReactNode }) {
  return (
    <p className="tile-number">
      {value}
      {note !== undefined && <span className="muted"> {note}</span>}
    </p>
  );
}
