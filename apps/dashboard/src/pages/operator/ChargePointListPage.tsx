/**
 * Screen 18 — Charge Point List (UC-OPS-02, FE-03). The Operator's charge points from
 * GET /api/operator/v1/charge-points, one row each, with every connector's raw OCPP status (D21),
 * Offline overriding it (D20) and a "possibly out of date" mark when stale (D22, BR-P39). Filters:
 * online / offline and lifecycle; decommissioned is hidden unless chosen (D24). Polled every 5 s
 * (D5). "Đưa trụ vào vận hành" opens screen 19 (FE-02, OnboardingSheet).
 *
 * Map (FE-03c, D23): "Danh sách / Bản đồ" switch kept in `?view=map`. The map shows one pin per
 * Charging Station on a Vietmap base map (up to 100 charge points, same filters); the selected
 * station's charge points are listed beside it with links to screen 20.
 */
import { Button, Card, Loader, Table } from '@mantine/core';
import { IconChevronLeft, IconPlus } from '@tabler/icons-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ChargePointLifecycle, OperatorChargePoint } from '@powerme/shared';
import {
  CHARGE_POINT_MAP_SIZE,
  CHARGE_POINT_PAGE_SIZE,
  errorMessage,
  useOperatorChargePointsQuery,
} from '../../core/api/api';
import { ConnectorList, isOffline, OnlineCell } from '../../features/chargePoints/ConnectorList';
import { OnboardingSheet } from '../../features/chargePoints/OnboardingSheet';
import { ago, LIFECYCLE, OFFLINE_CARD_RISK, useNow } from '../../features/chargePoints/format';
import {
  groupBySite,
  TONE_LABEL,
  TONE_ORDER,
  type MapSite,
} from '../../features/chargePoints/mapModel';
import { useDebounced } from '../../core/search/search';
import { vietmapTileKey } from '../../core/config/env';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '../../ui/FilterBar';
import { Notice } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { QueueSwitch } from '../../ui/QueueSwitch';
import { StatusBadge } from '../../ui/StatusBadge';
import { onlineBadge } from '../../ui/tones';

const ChargePointMap = lazy(() => import('../../features/chargePoints/ChargePointMap'));
type MapFailure = import('../../features/chargePoints/ChargePointMap').MapFailure;

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

/** Beside the map: the chosen station's charge points, or every placed station to choose from. */
function SitePanel({
  sites,
  selected,
  onSelect,
  now,
}: {
  sites: MapSite[];
  selected: MapSite | null;
  onSelect: (id: string | null) => void;
  now: number;
}) {
  if (!selected)
    return (
      <Card component="aside" className="site-panel" aria-label="Trạm sạc trên bản đồ">
        <h2>Trạm sạc ({sites.length})</h2>
        <p className="muted small">Chọn một ghim hoặc một trạm để xem các trụ sạc.</p>
        <ul className="site-choices">
          {sites.map((s) => (
            <li key={s.id}>
              <button type="button" className="site-choice" onClick={() => onSelect(s.id)}>
                <span className={`map-dot tone-${s.tone}`} aria-hidden="true" />
                <span>
                  {s.site_name}
                  <span className="muted small">
                    {' '}
                    · {s.chargePoints.length} trụ · {TONE_LABEL[s.tone]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    );
  return (
    <Card component="aside" className="site-panel" aria-label={`Trạm sạc ${selected.site_name}`}>
      <div className="site-panel-head">
        <div>
          <h2>
            <Link to={`/operator/stations/${selected.id}`}>{selected.site_name}</Link>
          </h2>
          <div className="muted small">
            {selected.site_code} · {TONE_LABEL[selected.tone]}
          </div>
        </div>
        <Button
          size="xs"
          variant="subtle"
          color="slate"
          leftSection={<IconChevronLeft size={14} aria-hidden="true" />}
          onClick={() => onSelect(null)}
        >
          Tất cả trạm
        </Button>
      </div>
      <ul className="site-cps">
        {selected.chargePoints.map((cp) => {
          const [label, tone] = onlineBadge(isOffline(cp));
          return (
            <li key={cp.id}>
              <div className="site-cp-head">
                <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
                  {cp.display_code ?? cp.serial_number}
                </Link>
                <StatusBadge tone={tone} size="sm">
                  {label}
                </StatusBadge>
              </div>
              <div className="muted small">
                {LIFECYCLE[cp.lifecycle]} · {ago(cp.last_message_at, now)}
              </div>
              <ConnectorList cp={cp} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function MapView({
  items,
  total,
  now,
}: {
  items: OperatorChargePoint[];
  total: number;
  now: number;
}) {
  const tileKey = vietmapTileKey();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState<MapFailure | null>(null);
  const { sites, unplaced } = useMemo(() => groupBySite(items), [items]);
  const selected = sites.find((s) => s.id === selectedId) ?? null;
  return (
    <>
      {total > items.length && (
        <Notice tone="warn">
          Bản đồ chỉ hiện {items.length} / {total} trụ sạc đầu tiên — thu hẹp bằng ô tìm hoặc bộ
          lọc.
        </Notice>
      )}
      {unplaced > 0 && (
        <p className="muted small" role="status">
          {unplaced} trạm sạc chưa có toạ độ nên không có trên bản đồ.
        </p>
      )}
      <div className="map-layout">
        <Card padding={0} className="map-card">
          {!tileKey ? (
            <p className="map-message" role="status">
              Chưa cấu hình khoá bản đồ Vietmap. Danh sách trạm vẫn xem được bên cạnh.
            </p>
          ) : mapFailed ? (
            <p className="map-message" role="alert">
              {mapFailed === 'webgl'
                ? 'Trình duyệt không bật được WebGL nên không vẽ được bản đồ (thường gặp trên máy ảo). Bật tăng tốc phần cứng hoặc dùng trình duyệt khác; danh sách trạm vẫn xem được bên cạnh.'
                : 'Không tải được bản đồ Vietmap (khoá sai, hết hạn mức hoặc mất mạng).'}
            </p>
          ) : (
            <Suspense fallback={<p className="map-message muted">Đang tải bản đồ…</p>}>
              <ChargePointMap
                tileKey={tileKey}
                sites={sites}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onError={setMapFailed}
              />
            </Suspense>
          )}
          <ul className="map-legend" aria-label="Chú giải">
            {TONE_ORDER.filter((t) => t !== 'empty').map((t) => (
              <li key={t}>
                <span className={`map-dot tone-${t}`} aria-hidden="true" /> {TONE_LABEL[t]}
              </li>
            ))}
          </ul>
        </Card>
        <SitePanel sites={sites} selected={selected} onSelect={setSelectedId} now={now} />
      </div>
    </>
  );
}

const VIEWS = [
  { key: 'list', label: 'Danh sách' },
  { key: 'map', label: 'Bản đồ' },
] as const;

export function ChargePointListPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'map' ? 'map' : 'list';
  const setView = (next: 'list' | 'map') =>
    setParams(
      (p) => {
        if (next === 'map') p.set('view', 'map');
        else p.delete('view');
        return p;
      },
      { replace: true },
    );
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
      ...(view === 'map' ? { page: 1, pageSize: CHARGE_POINT_MAP_SIZE } : { page }),
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
  if (view === 'list' && data && page > pages) setPage(pages);
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
        <QueueSwitch label="Cách xem" value={view} onChange={setView} items={VIEWS} />
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
      ) : view === 'map' ? (
        <MapView items={items} total={total} now={now} />
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
