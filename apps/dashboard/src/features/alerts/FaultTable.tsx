/**
 * The fault table of screen 21, also the fault history of screen 20 (FE-05, filtered by charge
 * point). One table in the server's order (open → severity → newest, D39), filtered by status and
 * paged on the server (FAULT_PAGE_SIZE rows). Polling (D5): 3 s, 1 s while a fault on the page is
 * resetting so t5 / t6 show quickly. Realtime push is a known gap (W2).
 */
import { Loader, Table } from '@mantine/core';
import { useState } from 'react';
import type { FaultListStatus } from '@powerme/shared';
import { errorMessage, FAULT_PAGE_SIZE, useOperatorFaultsQuery } from '../../core/api/api';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SelectFilter } from '../../ui/FilterBar';
import { Notice } from '../../ui/Notice';
import { Pager, pageCount } from '../../ui/Pager';
import { FaultRow } from './FaultRow';

export const POLL_MS = 3000;
export const FAST_POLL_MS = 1000;

const FILTERS: readonly (readonly [FaultListStatus, string])[] = [
  ['open', 'Đang mở'],
  ['raised', 'Mới'],
  ['acknowledged', 'Đã xác nhận'],
  ['resetting', 'Đang khởi động lại'],
  ['resolved', 'Đã xử lý'],
  ['all', 'Tất cả'],
];

export function FaultTable({
  chargePointId,
  defaultStatus = 'open',
}: {
  /** Screen 20: only this charge point's faults (its fault history). */
  chargePointId?: string;
  defaultStatus?: FaultListStatus;
}) {
  const [status, setStatus] = useState<FaultListStatus>(defaultStatus);
  const [page, setPage] = useState(1);
  const [fast, setFast] = useState(false);
  const { data, error, isLoading } = useOperatorFaultsQuery(
    { status, page, ...(chargePointId ? { chargePointId } : {}) },
    { pollingInterval: fast ? FAST_POLL_MS : POLL_MS, skipPollingIfUnfocused: true },
  );
  const faults = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = pageCount(total, FAULT_PAGE_SIZE);
  const resetting = faults.some((f) => f.status === 'resetting');
  if (resetting !== fast) setFast(resetting);
  // Rows can leave the filter while polling; never stay on a page past the end.
  if (data && page > pages) setPage(pages);

  // Range from the response, not `page`: the old rows stay on screen while the next page loads.
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? FAULT_PAGE_SIZE) + 1;
  const last = first + faults.length - 1;

  return (
    <>
      <FilterBar>
        <SelectFilter
          label="Trạng thái"
          value={status}
          options={FILTERS}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
      </FilterBar>
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{errorMessage(error)}</Notice>
      ) : faults.length === 0 ? (
        <EmptyState>
          {status === 'open'
            ? chargePointId
              ? 'Trụ sạc này không có sự cố đang mở.'
              : 'Không có cảnh báo. Mọi súng đang hoạt động bình thường.'
            : 'Không có sự cố ở trạng thái này.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={980}
          footer={
            <Pager
              first={first}
              last={last}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">#</Table.Th>
              <Table.Th scope="col">Sự cố</Table.Th>
              <Table.Th scope="col">Trụ sạc</Table.Th>
              <Table.Th scope="col">Mức độ</Table.Th>
              <Table.Th scope="col">Trạng thái</Table.Th>
              <Table.Th scope="col">Phát sinh</Table.Th>
              <Table.Th scope="col">Thao tác</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {faults.map((f) => (
              <FaultRow key={f.id} fault={f} />
            ))}
          </Table.Tbody>
        </DataTable>
      )}
    </>
  );
}
