/**
 * The one table recipe: a Graphite card, horizontal scroll on narrow screens, a capped height
 * (about 12 rows) that scrolls inside the card, Mantine Table with a sticky header (and sticky
 * footer row), and an optional pager below. Rows set `data-tone` (critical / major / muted) for
 * the accent bar and tint (see global.css).
 */
import { Card, Table, type TableProps } from '@mantine/core';
import type { CSSProperties, ReactNode } from 'react';

export function DataTable({
  label,
  minWidth = 760,
  className,
  footer,
  toolbar,
  maxHeight,
  children,
  ...table
}: {
  /** Accessible name of the table, when the page has more than one. */
  label?: string;
  minWidth?: number;
  className?: string;
  /** Under the table, inside the card (the pager). */
  footer?: ReactNode;
  /** Above the table, inside the card (filters). */
  toolbar?: ReactNode;
  /**
   * Height cap of the scrolling body, in px (default 640, about 12 one-line rows; see
   * `.table-scroll`); 'none' lets the table grow. The header stays sticky inside it.
   */
  maxHeight?: number | 'none';
  children: ReactNode;
} & Omit<TableProps, 'children'>) {
  return (
    <Card padding={0} className={`table-card${className ? ` ${className}` : ''}`}>
      {toolbar && <div className="table-toolbar">{toolbar}</div>}
      <Table.ScrollContainer
        minWidth={minWidth}
        type="native"
        className="table-scroll"
        style={
          maxHeight === undefined
            ? undefined
            : ({
                '--table-max-h': maxHeight === 'none' ? 'none' : `${maxHeight}px`,
              } as CSSProperties)
        }
      >
        <Table className="data-table" aria-label={label} stickyHeader {...table}>
          {children}
        </Table>
      </Table.ScrollContainer>
      {footer}
    </Card>
  );
}

/** The card shown in place of a table when there is nothing to list. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Card className="empty-state">
      <p className="muted">{children}</p>
    </Card>
  );
}
