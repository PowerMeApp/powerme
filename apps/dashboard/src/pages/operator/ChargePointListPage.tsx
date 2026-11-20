/**
 * Screen 18 — Charge Point List (UC-OPS-02, FE-03). The Operator's charge points from
 * GET /api/operator/v1/charge-points, one row each, with every connector's raw OCPP status (D21),
 * Offline overriding it (D20) and a "possibly out of date" mark when stale (D22, BR-P39). Filters:
 * online / offline and lifecycle; decommissioned is hidden unless chosen (D24). The site filter
 * waits for GET /operator/v1/sites (Ân). Polled every 5 s (D5); the map is FE-03c (D23).
 */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ChargePointLifecycle, OperatorChargePoint } from '@powerme/shared';
import {
  CHARGE_POINT_PAGE_SIZE,
  errorMessage,
  useOperatorChargePointsQuery,
} from '../../core/api/api';
import { ConnectorList, isOffline } from '../../features/chargePoints/ConnectorList';
import { ago, LIFECYCLE, useNow } from '../../features/chargePoints/format';

export const LIST_POLL_MS = 5000;

const ONLINE_FILTERS = [
  ['all', 'Tất cả'],
  ['online', 'Online'],
  ['offline', 'Offline'],
] as const;
type OnlineFilter = (typeof ONLINE_FILTERS)[number][0];

function Row({ cp, now }: { cp: OperatorChargePoint; now: number }) {
  const offline = isOffline(cp);
  return (
    <tr aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`}>
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
        <Link to={`/operator/stations/${cp.site.id}`}>{cp.site.site_name}</Link>
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

export function ChargePointListPage() {
  const [online, setOnline] = useState<OnlineFilter>('all');
  const [lifecycle, setLifecycle] = useState<ChargePointLifecycle | ''>('');
  const [page, setPage] = useState(1);
  const now = useNow();
  const { data, error, isLoading } = useOperatorChargePointsQuery(
    {
      page,
      ...(lifecycle ? { lifecycle } : {}),
      ...(online === 'all' ? {} : { online: online === 'online' }),
    },
    { pollingInterval: LIST_POLL_MS, skipPollingIfUnfocused: true },
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CHARGE_POINT_PAGE_SIZE));
  if (data && page > pages) setPage(pages);
  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? CHARGE_POINT_PAGE_SIZE) + 1;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Trụ sạc' }]} />
      <div className="page-head">
        <h1>Trụ sạc</h1>
        <p>Trạng thái từng súng theo bản tin OCPP mới nhất · cập nhật mỗi 5 giây</p>
      </div>
      <div className="filters">
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
          <p className="muted">Không có trụ sạc nào khớp bộ lọc.</p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Trụ sạc</th>
                  <th scope="col">Trạm sạc</th>
                  <th scope="col">Vòng đời</th>
                  <th scope="col">Kết nối</th>
                  <th scope="col">Súng</th>
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
