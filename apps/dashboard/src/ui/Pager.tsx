/**
 * Server-side paging under a table: "Hiển thị 21–40 / 57" and ‹ Trước · Trang 2 / 3 · Sau ›.
 * `usePageClamp` keeps the page inside the range when rows leave a filter while polling.
 */
import { Button, Group, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

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
