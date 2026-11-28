/**
 * Server-side paging under a table: "Hiển thị 21–40 / 57" and ‹ Trước · Trang 2 / 3 · Sau ›.
 * `useClientPage` pages a list the API returned whole (20 rows a page).
 */
import { Button, Group, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';

export function Pager({
  label = 'Phân trang',
  first,
  last,
  total,
  page,
  pages,
  onPage,
  note,
}: {
  label?: string;
  /** Appended to the range text ("(lọc từ 45)"). */
  note?: string | undefined;
  first: number;
  last: number;
  total: number;
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="pager" aria-label={label}>
      <Text size="sm" c="dimmed">
        Hiển thị {first}–{last} / {total}
        {note ? ` ${note}` : ''}
      </Text>
      <Group gap="xs" wrap="nowrap">
        <Button
          size="compact-sm"
          variant="subtle"
          color="slate"
          leftSection={<IconChevronLeft size={16} aria-hidden="true" />}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="‹ Trước"
        >
          Trước
        </Button>
        <Text size="sm" className="pager-page">
          Trang {page} / {pages}
        </Text>
        <Button
          size="compact-sm"
          variant="subtle"
          color="slate"
          rightSection={<IconChevronRight size={16} aria-hidden="true" />}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Sau ›"
        >
          Sau
        </Button>
      </Group>
    </nav>
  );
}

/** Number of pages for `total` rows (at least 1). */
export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size));

/** Rows per page of a list paged in the browser (the API returned it whole). */
export const CLIENT_PAGE_SIZE = 20;

/**
 * Pages `rows` in the browser: the rows of the current page and the props of the `<Pager>` under
 * them. The page is clamped when rows leave (polling, search), and `reset` goes back to page 1.
 */
export function useClientPage<T>(rows: readonly T[], size = CLIENT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const pages = pageCount(rows.length, size);
  const shown = Math.min(page, pages);
  const start = (shown - 1) * size;
  const pageRows = rows.slice(start, start + size);
  return {
    pageRows,
    /** More than one page: show the pager. */
    paged: rows.length > size,
    reset: () => setPage(1),
    pagerProps: {
      first: rows.length === 0 ? 0 : start + 1,
      last: start + pageRows.length,
      total: rows.length,
      page: shown,
      pages,
      onPage: setPage,
    },
  };
}
