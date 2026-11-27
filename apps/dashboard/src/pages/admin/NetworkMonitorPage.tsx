/**
 * Screen 31 — Charge Point Network Monitor (FE-18, UC-ADM-07, Admin only). Every Operator's charge
 * points on one screen, read-only: GET /api/admin/v1/network/charge-points (same live fields as
 * screen 18: raw connector status, Offline override (D20), "possibly out of date" (BR-P39)) plus the
 * Operator and its open faults. Network totals come from GET /admin/v1/summary (screen 27).
 * Filters: Operator, online / offline, lifecycle, charge point and station search. Polled every 10 s.
 * Uptime / utilisation (BR-P43) wait for the metrics API (Trí), as on screen 20.
 */
import { Loader, Table } from '@mantine/core';
import { useState } from 'react';
import type { ChargePointLifecycle, NetworkChargePoint } from '@powerme/shared';
import { CountBadge } from '../../components/CountBadge';
import {
  errorMessage,
  NETWORK_PAGE_SIZE,
  useAdminNetworkQuery,
  useAdminOperatorsQuery,
  useAdminSummaryQuery,
} from '../../core/api/api';
import { useDebounced } from '../../core/search/search';
import { ConnectorList, isOffline, OnlineCell } from '../../features/chargePoints/ConnectorList';
import { LIFECYCLE, useNow } from '../../features/chargePoints/format';
import { formatCount } from '../../features/revenue/revenueModel';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '../../ui/FilterBar';
import { Notice } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { Figure, StatCard } from '../../ui/StatCard';
import { StatusBadge } from '../../ui/StatusBadge';
import {
  LIFECYCLE_FILTERS,
  ONLINE_FILTERS,
  type OnlineFilter,
} from '../operator/ChargePointListPage';

export const NETWORK_POLL_MS = 10_000;

const SEVERITY = {
  critical: 'Nghiêm trọng',
  major: 'Nặng',
  minor: 'Nhẹ',
  none: 'Không rõ',
} as const;

function Row({ cp, now }: { cp: NetworkChargePoint; now: number }) {
  const faults = cp.open_faults;
  const tone =
    faults.total > 0 && faults.top_severity
      ? faults.top_severity
      : isOffline(cp)
        ? 'muted'
        : undefined;
  return (
    <Table.Tr aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`} data-tone={tone}>
      <Table.Td>
        <span className="cell-title">{cp.display_code ?? cp.serial_number}</span>
        <div className="muted small">
          {cp.serial_number}
          {cp.model ? ` · ${cp.model}` : ''}
        </div>
      </Table.Td>
      <Table.Td>
        {cp.operator.legal_name}
        <div className="muted small">
          {cp.site.site_code} · {cp.site.site_name}
        </div>
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
      <Table.Td className="nowrap">
        {faults.total > 0 && faults.top_severity ? (
          <>
            <StatusBadge
              tone={faults.top_severity}
              variant={faults.top_severity === 'critical' ? 'filled' : 'light'}
            >
              {SEVERITY[faults.top_severity]}
            </StatusBadge>{' '}
            <CountBadge count={faults.total} label="sự cố đang mở" />
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

/** Network totals of screen 27 (only groups with data, D36); open faults lead as an alert card. */
function Totals() {
  const { data: s } = useAdminSummaryQuery(undefined, {
    pollingInterval: NETWORK_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const net = s?.network;
  if (!net) return null;
  const inService = net.in_service_online + net.in_service_offline;
  if (inService === 0 && net.open_faults.total === 0) return null;
  const faults = net.open_faults;
  return (
    <div className="tiles">
      <StatCard
        label="Sự cố đang mở"
        tone={faults.critical > 0 ? 'critical' : faults.major > 0 ? 'major' : undefined}
      >
        <Figure value={formatCount(faults.total)} />
        {faults.critical > 0 && (
          <p>
            <StatusBadge tone="critical">Nghiêm trọng</StatusBadge>{' '}
            <b>{formatCount(faults.critical)}</b>
          </p>
        )}
      </StatCard>
      <StatCard label="Trụ đang hoạt động">
        <Figure
          value={formatCount(net.in_service_online)}
          note={`/ ${formatCount(inService)} đang kết nối`}
        />
        {net.in_service_offline > 0 && (
          <p>
            <StatusBadge tone="muted">Mất kết nối</StatusBadge>{' '}
            <b>{formatCount(net.in_service_offline)}</b>
          </p>
        )}
      </StatCard>
    </div>
  );
}

export function NetworkMonitorPage() {
  const [operatorId, setOperatorId] = useState('');
  const [online, setOnline] = useState<OnlineFilter>('all');
  const [lifecycle, setLifecycle] = useState<ChargePointLifecycle | ''>('');
  const [cpSearch, setCpSearch] = useState('');
  const [siteSearch, setSiteSearch] = useState('');
  const [page, setPage] = useState(1);
  const now = useNow();
  const cpQ = useDebounced(cpSearch);
  const siteQ = useDebounced(siteSearch);
  const operators = useAdminOperatorsQuery();
  const { data, error, isLoading } = useAdminNetworkQuery(
    {
      page,
      ...(operatorId ? { operator_id: operatorId } : {}),
      ...(online !== 'all' ? { online: online === 'online' } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(cpQ.trim() ? { charge_point_q: cpQ } : {}),
      ...(siteQ.trim() ? { site_q: siteQ } : {}),
    },
    { pollingInterval: NETWORK_POLL_MS, skipPollingIfUnfocused: true },
  );
  const total = data?.total ?? 0;
  const pages = pageCount(total, NETWORK_PAGE_SIZE);
  if (data && page > pages) setPage(pages);
  const filtered = !!(operatorId || online !== 'all' || lifecycle || cpQ.trim() || siteQ.trim());
  const reset = () => setPage(1);
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? NETWORK_PAGE_SIZE) + 1;

  return (
    <>
      <PageHeader crumbs={[{ label: 'Giám sát mạng lưới' }]} title="Giám sát mạng lưới" />
      <Totals />
      <FilterBar>
        <SelectFilter
          label="Đơn vị vận hành"
          value={operatorId}
          options={[
            ['', 'Tất cả'],
            ...(operators.data?.items ?? []).map((o) => [o.id, o.legal_name] as const),
          ]}
          onChange={(v) => {
            setOperatorId(v);
            reset();
          }}
        />
        <SearchInput
          label="Tìm trụ sạc"
          value={cpSearch}
          placeholder="Mã, số seri hoặc ID trụ"
          onChange={(v) => {
            setCpSearch(v);
            reset();
          }}
        />
        <SearchInput
          label="Tìm trạm sạc"
          value={siteSearch}
          placeholder="Mã, tên hoặc ID trạm"
          onChange={(v) => {
            setSiteSearch(v);
            reset();
          }}
        />
        <SelectFilter
          label="Kết nối"
          value={online}
          options={ONLINE_FILTERS}
          onChange={(v) => {
            setOnline(v);
            reset();
          }}
        />
        <SelectFilter
          label="Vòng đời"
          value={lifecycle}
          options={LIFECYCLE_FILTERS}
          onChange={(v) => {
            setLifecycle(v);
            reset();
          }}
        />
      </FilterBar>
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{errorMessage(error)}</Notice>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>
          {filtered ? 'Không có trụ nào khớp bộ lọc.' : 'Chưa có trụ sạc nào trên nền tảng.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={980}
          footer={
            <Pager
              first={first}
              last={first + data.items.length - 1}
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
              <Table.Th scope="col">Đơn vị vận hành · trạm sạc</Table.Th>
              <Table.Th scope="col">Vòng đời</Table.Th>
              <Table.Th scope="col">Kết nối</Table.Th>
              <Table.Th scope="col">Súng</Table.Th>
              <Table.Th scope="col">Sự cố đang mở</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.items.map((cp) => (
              <Row key={cp.id} cp={cp} now={now} />
            ))}
          </Table.Tbody>
        </DataTable>
      )}
      <p className="muted small">
        Uptime và tỉ lệ sử dụng (BR-P43) sẽ hiện khi có API số liệu theo trụ.
      </p>
    </>
  );
}
