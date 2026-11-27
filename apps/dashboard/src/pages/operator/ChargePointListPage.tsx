/**
 * Screen 18 — Charge Point List (UC-OPS-02, FE-03). The Operator's charge points from
 * GET /api/operator/v1/charge-points, one row each, with every connector's raw OCPP status (D21),
 * Offline overriding it (D20) and a "possibly out of date" mark when stale (D22, BR-P39). Filters:
 * online / offline and lifecycle; decommissioned is hidden unless chosen (D24). Polled every 5 s
 * (D5); the map is FE-03c (D23). "Đưa trụ vào vận hành" opens screen 19 (FE-02, OnboardingSheet).
 */
import { Button, Loader, Table } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ChargePointLifecycle, OperatorChargePoint } from '@powerme/shared';
import {
  CHARGE_POINT_PAGE_SIZE,
  errorMessage,
  useOperatorChargePointsQuery,
} from '../../core/api/api';
import { ConnectorList, isOffline, OnlineCell } from '../../features/chargePoints/ConnectorList';
import { OnboardingSheet } from '../../features/chargePoints/OnboardingSheet';
import { LIFECYCLE, OFFLINE_CARD_RISK, useNow } from '../../features/chargePoints/format';
import { useDebounced } from '../../core/search/search';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '../../ui/FilterBar';
import { Notice } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';

export const LIST_POLL_MS = 5000;

export const ONLINE_FILTERS = [
  ['all', 'Tất cả'],
  ['online', 'Đang kết nối'],
  ['offline', 'Mất kết nối'],
] as const;
export type OnlineFilter = (typeof ONLINE_FILTERS)[number][0];

/** Lifecycle filter: decommissioned is hidden unless chosen (D24). */
export const LIFECYCLE_FILTERS: readonly (readonly [ChargePointLifecycle | '', string])[] = [
  ['', 'Tất cả (trừ đã gỡ)'],
  ...(Object.keys(LIFECYCLE) as ChargePointLifecycle[]).map((l) => [l, LIFECYCLE[l]] as const),
];

function Row({ cp, now }: { cp: OperatorChargePoint; now: number }) {
  const offline = isOffline(cp);
  return (
    <Table.Tr
      aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`}
      data-tone={offline ? 'muted' : undefined}
    >
      <Table.Td>
        <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
          {cp.display_code ?? cp.serial_number}
        </Link>
        <div className="muted small">
          {cp.serial_number}
          {cp.model ? ` · ${cp.model}` : ''}
        </div>
        {cp.offline_card_risk && (
          <div>
            <StatusBadge
              tone="major"
              size="sm"
              title={`Rủi ro thẻ khi mất kết nối: ${OFFLINE_CARD_RISK[cp.offline_card_risk_reason ?? 'not_checked']}`}
            >
              Rủi ro thẻ khi mất kết nối
            </StatusBadge>
          </div>
        )}
      </Table.Td>
      <Table.Td>
        <Link to={`/operator/stations/${cp.site.id}`}>{cp.site.site_name}</Link>
        <div className="muted small">{cp.site.site_code}</div>
      </Table.Td>
      <Table.Td>
        <StatusBadge>{LIFECYCLE[cp.lifecycle]}</StatusBadge>
      </Table.Td>
      <Table.Td className="nowrap">
        <OnlineCell cp={cp} now={now} />
      </Table.Td>
      <Table.Td>
        <ConnectorList cp={cp} />
      </Table.Td>
    </Table.Tr>
  );
}

export function ChargePointListPage() {
  const [online, setOnline] = useState<OnlineFilter>('all');
  const [lifecycle, setLifecycle] = useState<ChargePointLifecycle | ''>('');
  const [page, setPage] = useState(1);
  const [onboarding, setOnboarding] = useState(false);
  const [cpSearch, setCpSearch] = useState('');
  const [siteSearch, setSiteSearch] = useState('');
  const chargePointQ = useDebounced(cpSearch.trim());
  const siteQ = useDebounced(siteSearch.trim());
  const searching = chargePointQ || siteQ;
  const now = useNow();
  const { data, error, isLoading } = useOperatorChargePointsQuery(
    {
      page,
      ...(chargePointQ ? { chargePointQ } : {}),
      ...(siteQ ? { siteQ } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(online === 'all' ? {} : { online: online === 'online' }),
    },
    { pollingInterval: LIST_POLL_MS, skipPollingIfUnfocused: true },
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = pageCount(total, CHARGE_POINT_PAGE_SIZE);
  if (data && page > pages) setPage(pages);
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? CHARGE_POINT_PAGE_SIZE) + 1;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Trụ sạc' }]}
        title="Trụ sạc"
        actions={
          <Button
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => setOnboarding(true)}
          >
            Đưa trụ vào vận hành
          </Button>
        }
      />
      <FilterBar>
        <SearchInput
          label="Tìm trụ sạc"
          value={cpSearch}
          placeholder="Mã, số seri hoặc ID trụ"
          onChange={(v) => {
            setCpSearch(v);
            setPage(1);
          }}
        />
        <SearchInput
          label="Tìm trạm sạc"
          value={siteSearch}
          placeholder="Mã, tên hoặc ID trạm"
          onChange={(v) => {
            setSiteSearch(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Kết nối"
          value={online}
          options={ONLINE_FILTERS}
          onChange={(v) => {
            setOnline(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Vòng đời"
          value={lifecycle}
          options={LIFECYCLE_FILTERS}
          onChange={(v) => {
            setLifecycle(v);
            setPage(1);
          }}
        />
      </FilterBar>
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{errorMessage(error)}</Notice>
      ) : items.length === 0 ? (
        <EmptyState>
          {searching
            ? 'Không có trụ sạc nào khớp ô tìm kiếm và bộ lọc.'
            : 'Không có trụ sạc nào khớp bộ lọc.'}
        </EmptyState>
      ) : (
        <DataTable
          footer={
            <Pager
              first={first}
              last={first + items.length - 1}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Trụ sạc</Table.Th>
              <Table.Th scope="col">Trạm sạc</Table.Th>
              <Table.Th scope="col">Vòng đời</Table.Th>
              <Table.Th scope="col">Kết nối</Table.Th>
              <Table.Th scope="col">Súng</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((cp) => (
              <Row key={cp.id} cp={cp} now={now} />
            ))}
          </Table.Tbody>
        </DataTable>
      )}
      {onboarding && <OnboardingSheet onClose={() => setOnboarding(false)} />}
    </>
  );
}
