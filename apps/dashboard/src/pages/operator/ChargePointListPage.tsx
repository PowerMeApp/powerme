/**
 * Screen 18 — Charge Point List (UC-OPS-02, FE-03). The Operator's charge points from
 * GET /api/operator/v1/charge-points, one row each, with every connector's raw OCPP status (D21),
 * Offline overriding it (D20) and a "possibly out of date" mark when stale (D22, BR-P39). Filters:
 * online / offline and lifecycle; decommissioned is hidden unless chosen (D24). The site filter
 * waits for GET /operator/v1/sites (Ân). Polled every 5 s (D5).
 *
 * FE-03c: "Danh sách / Bản đồ" switch kept in `?view=map`. The map shows one pin per Charging
 * Station on a Vietmap base map (up to 100 charge points, same filters); the selected station's
 * charge points are listed beside it with links to screen 20.
 */
import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ChargePointLifecycle, OperatorChargePoint } from '@powerme/shared';
import {
  CHARGE_POINT_MAP_SIZE,
  CHARGE_POINT_PAGE_SIZE,
  errorMessage,
  useOperatorChargePointsQuery,
} from '../../core/api/api';
import { vietmapTileKey } from '../../core/config/env';
import { ago, connectorTone, LIFECYCLE, useNow } from '../../features/chargePoints/format';
import {
  groupBySite,
  isOffline,
  TONE_LABEL,
  TONE_ORDER,
  type MapSite,
} from '../../features/chargePoints/mapModel';

const ChargePointMap = lazy(() => import('../../features/chargePoints/ChargePointMap'));

export const LIST_POLL_MS = 5000;

const ONLINE_FILTERS = [
  ['all', 'Tất cả'],
  ['online', 'Online'],
  ['offline', 'Offline'],
] as const;
type OnlineFilter = (typeof ONLINE_FILTERS)[number][0];

function ConnectorList({ cp }: { cp: OperatorChargePoint }) {
  if (cp.connectors.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="connector-list">
      {cp.connectors.map((c) => (
        <li key={c.connector_id}>
          <span className="muted small">Connector {c.connector_no}</span>{' '}
          <span className={`pill ${connectorTone(c)}`}>
            {c.status_quality === 'offline' ? 'Offline' : c.status}
            {c.status === 'Faulted' && c.error_code ? ` · ${c.error_code}` : ''}
          </span>
          {c.status_quality === 'stale' && (
            <span className="muted small" title="Không có bản tin quá 2 nhịp Heartbeat">
              {' '}
              · có thể đã cũ
            </span>
          )}
          {c.active_session_id && (
            <span className="muted small"> · phiên {c.active_session_id}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({ cp, now }: { cp: OperatorChargePoint; now: number }) {
  const offline = isOffline(cp);
  return (
    <tr aria-label={`Charge Point ${cp.display_code ?? cp.serial_number}`}>
      <td>
        <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
          {cp.display_code ?? cp.serial_number}
        </Link>
        <div className="muted small">
          {cp.serial_number}
          {cp.model ? ` · ${cp.model}` : ''}
        </div>
      </td>
      <td>
        <div>{cp.site.site_name}</div>
        <div className="muted small">{cp.site.site_code}</div>
      </td>
      <td>
        <span className="pill">{LIFECYCLE[cp.lifecycle]}</span>
      </td>
      <td className="nowrap">
        <span className={`pill ${offline ? 'muted' : ''}`}>{offline ? 'Offline' : 'Online'}</span>
        <div className="muted small">{ago(cp.last_message_at, now)}</div>
      </td>
      <td>
        <ConnectorList cp={cp} />
      </td>
    </tr>
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
      <aside className="card site-panel" aria-label="Charging Station trên bản đồ">
        <h2>Charging Station ({sites.length})</h2>
        <p className="muted small">Chọn một ghim hoặc một trạm để xem Charge Point.</p>
        <ul className="site-choices">
          {sites.map((s) => (
            <li key={s.id}>
              <button type="button" className="site-choice" onClick={() => onSelect(s.id)}>
                <span className={`map-dot tone-${s.tone}`} aria-hidden="true" />
                <span>
                  {s.site_name}
                  <span className="muted small">
                    {' '}
                    · {s.chargePoints.length} Charge Point · {TONE_LABEL[s.tone]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    );
  return (
    <aside className="card site-panel" aria-label={`Charging Station ${selected.site_name}`}>
      <div className="site-panel-head">
        <div>
          <h2>{selected.site_name}</h2>
          <div className="muted small">
            {selected.site_code} · {TONE_LABEL[selected.tone]}
          </div>
        </div>
        <button type="button" className="btn small ghost" onClick={() => onSelect(null)}>
          ‹ Tất cả trạm
        </button>
      </div>
      <ul className="site-cps">
        {selected.chargePoints.map((cp) => {
          const offline = isOffline(cp);
          return (
            <li key={cp.id}>
              <div className="site-cp-head">
                <Link className="cell-title" to={`/operator/charge-points/${cp.id}`}>
                  {cp.display_code ?? cp.serial_number}
                </Link>
                <span className={`pill ${offline ? 'muted' : ''}`}>
                  {offline ? 'Offline' : 'Online'}
                </span>
              </div>
              <div className="muted small">
                {LIFECYCLE[cp.lifecycle]} · {ago(cp.last_message_at, now)}
              </div>
              <ConnectorList cp={cp} />
            </li>
          );
        })}
      </ul>
    </aside>
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
  const [mapFailed, setMapFailed] = useState(false);
  const { sites, unplaced } = groupBySite(items);
  const selected = sites.find((s) => s.id === selectedId) ?? null;
  return (
    <>
      {total > items.length && (
        <p className="notice" role="status">
          Bản đồ chỉ hiện {items.length} / {total} Charge Point đầu — thu hẹp bằng bộ lọc.
        </p>
      )}
      {unplaced > 0 && (
        <p className="muted small" role="status">
          {unplaced} Charging Station chưa có toạ độ nên không có trên bản đồ.
        </p>
      )}
      <div className="map-layout">
        <div className="card map-card">
          {!tileKey ? (
            <p className="map-message" role="status">
              Chưa cấu hình key bản đồ Vietmap (VITE_VIETMAP_TILE_KEY). Danh sách trạm vẫn xem được
              bên cạnh.
            </p>
          ) : mapFailed ? (
            <p className="map-message" role="alert">
              Không tải được bản đồ Vietmap (key sai, hết hạn mức hoặc mất mạng).
            </p>
          ) : (
            <Suspense fallback={<p className="map-message muted">Đang tải bản đồ…</p>}>
              <ChargePointMap
                tileKey={tileKey}
                sites={sites}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onError={() => setMapFailed(true)}
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
        </div>
        <SitePanel sites={sites} selected={selected} onSelect={setSelectedId} now={now} />
      </div>
    </>
  );
}

export function ChargePointListPage() {
  const [online, setOnline] = useState<OnlineFilter>('all');
  const [lifecycle, setLifecycle] = useState<ChargePointLifecycle | ''>('');
  const [page, setPage] = useState(1);
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
  const now = useNow();
  const filters = {
    ...(lifecycle ? { lifecycle } : {}),
    ...(online === 'all' ? {} : { online: online === 'online' }),
  };
  const { data, error, isLoading } = useOperatorChargePointsQuery(
    view === 'map'
      ? { page: 1, pageSize: CHARGE_POINT_MAP_SIZE, ...filters }
      : { page, ...filters },
    { pollingInterval: LIST_POLL_MS, skipPollingIfUnfocused: true },
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CHARGE_POINT_PAGE_SIZE));
  if (view === 'list' && data && page > pages) setPage(pages);
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? CHARGE_POINT_PAGE_SIZE) + 1;

  return (
    <>
      <div className="page-head">
        <h1>Charge Point</h1>
        <p>Trạng thái từng Connector theo bản tin OCPP mới nhất · cập nhật mỗi 5 giây</p>
      </div>
      <div className="filters">
        <div className="segmented" role="group" aria-label="Cách xem">
          {(
            [
              ['list', 'Danh sách'],
              ['map', 'Bản đồ'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn small ${view === id ? '' : 'ghost'}`}
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="field">
          Kết nối
          <select
            className="input"
            value={online}
            onChange={(e) => {
              setOnline(e.target.value as OnlineFilter);
              setPage(1);
            }}
          >
            {ONLINE_FILTERS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Vòng đời
          <select
            className="input"
            value={lifecycle}
            onChange={(e) => {
              setLifecycle(e.target.value as ChargePointLifecycle | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả (trừ đã gỡ)</option>
            {(Object.keys(LIFECYCLE) as ChargePointLifecycle[]).map((l) => (
              <option key={l} value={l}>
                {LIFECYCLE[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : items.length === 0 ? (
        <div className="card">
          <p className="muted">Không có Charge Point nào khớp bộ lọc.</p>
        </div>
      ) : view === 'map' ? (
        <MapView items={items} total={total} now={now} />
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Charge Point</th>
                  <th scope="col">Charging Station</th>
                  <th scope="col">Vòng đời</th>
                  <th scope="col">Kết nối</th>
                  <th scope="col">Connector</th>
                </tr>
              </thead>
              <tbody>
                {items.map((cp) => (
                  <Row key={cp.id} cp={cp} now={now} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              Hiển thị {first}–{first + items.length - 1} / {total}
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn small ghost"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                ‹ Trước
              </button>
              <span className="pager-page">
                Trang {page} / {pages}
              </span>
              <button
                type="button"
                className="btn small ghost"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Sau ›
              </button>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
