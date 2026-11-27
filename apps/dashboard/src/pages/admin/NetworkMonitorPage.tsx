/**
 * Screen 31 — Charge Point Network Monitor (FE-18, UC-ADM-07, Admin only). Every Operator's charge
 * points on one screen, read-only: GET /api/admin/v1/network/charge-points (same live fields as
 * screen 18: raw connector status, Offline override (D20), "possibly out of date" (BR-P39)) plus the
 * Operator and its open faults. Network totals come from GET /admin/v1/summary (screen 27).
 * Filters: Operator, online / offline, lifecycle, charge point and station search. Polled every 10 s.
 * Uptime / utilisation (BR-P43) wait for the metrics API (Trí), as on screen 20.
 */
import { useState } from 'react';
import type { ChargePointLifecycle, NetworkChargePoint } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { CountBadge } from '../../components/CountBadge';
import {
  errorMessage,
  NETWORK_PAGE_SIZE,
  useAdminNetworkQuery,
  useAdminOperatorsQuery,
  useAdminSummaryQuery,
} from '../../core/api/api';
import { MAX_SEARCH, useDebounced } from '../../core/search/search';
import { ConnectorList, isOffline } from '../../features/chargePoints/ConnectorList';
import { ago, LIFECYCLE, useNow } from '../../features/chargePoints/format';
import { formatCount } from '../../features/revenue/revenueModel';

export const NETWORK_POLL_MS = 10_000;

const SEVERITY = {
  critical: 'Nghiêm trọng',
  major: 'Nặng',
  minor: 'Nhẹ',
  none: 'Không rõ',
} as const;
const ONLINE_FILTERS = [
  ['all', 'Tất cả'],
  ['online', 'Đang kết nối'],
  ['offline', 'Mất kết nối'],
] as const;
type OnlineFilter = (typeof ONLINE_FILTERS)[number][0];

function Row({ cp, now }: { cp: NetworkChargePoint; now: number }) {
  const offline = isOffline(cp);
  const faults = cp.open_faults;
  return (
    <tr aria-label={`Trụ sạc ${cp.display_code ?? cp.serial_number}`}>
      <td>
        <span className="cell-title">{cp.display_code ?? cp.serial_number}</span>
        <div className="muted small">
          {cp.serial_number}
          {cp.model ? ` · ${cp.model}` : ''}
        </div>
      </td>
      <td>
        {cp.operator.legal_name}
        <div className="muted small">
          {cp.site.site_code} · {cp.site.site_name}
        </div>
      </td>
      <td>
        <span className="pill">{LIFECYCLE[cp.lifecycle]}</span>
      </td>
      <td className="nowrap">
        <span className={`pill ${offline ? 'muted' : ''}`}>
          {offline ? 'Mất kết nối' : 'Đang kết nối'}
        </span>
        <div className="muted small">{ago(cp.last_message_at, now)}</div>
      </td>
      <td>
        <ConnectorList cp={cp} />
      </td>
      <td className="nowrap">
        {faults.total > 0 && faults.top_severity ? (
          <>
            <span className={`pill ${faults.top_severity}`}>{SEVERITY[faults.top_severity]}</span>{' '}
            <CountBadge count={faults.total} label="sự cố đang mở" />
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

/** Network totals of screen 27 (only groups with data, D36). */
function Totals() {
  const { data: s } = useAdminSummaryQuery(undefined, {
    pollingInterval: NETWORK_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const net = s?.network;
  if (!net) return null;
  const inService = net.in_service_online + net.in_service_offline;
  if (inService === 0 && net.open_faults.total === 0) return null;
  return (
    <div className="tiles">
      <section className="card tile" aria-label="Trụ đang hoạt động">
        <h2>Trụ đang hoạt động</h2>
        <p className="tile-number">
          {formatCount(net.in_service_online)}
          <span className="muted"> / {formatCount(inService)} đang kết nối</span>
        </p>
        {net.in_service_offline > 0 && (
          <p>
            <span className="pill muted">Mất kết nối</span>{' '}
            <b>{formatCount(net.in_service_offline)}</b>
          </p>
        )}
      </section>
      <section className="card tile" aria-label="Sự cố đang mở">
        <h2>Sự cố đang mở</h2>
        <p className="tile-number">{formatCount(net.open_faults.total)}</p>
        {net.open_faults.critical > 0 && (
          <p>
            <span className="pill critical">Nghiêm trọng</span>{' '}
            <b>{formatCount(net.open_faults.critical)}</b>
          </p>
        )}
      </section>
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
  const pages = Math.max(1, Math.ceil(total / NETWORK_PAGE_SIZE));
  if (data && page > pages) setPage(pages);
  const filtered = !!(operatorId || online !== 'all' || lifecycle || cpQ.trim() || siteQ.trim());
  const reset = () => setPage(1);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Giám sát mạng lưới' }]} />
      <div className="page-head">
        <h1>Giám sát mạng lưới</h1>
      </div>
      <Totals />
      <div className="filters">
        <label className="field">
          Đơn vị vận hành
          <select
            className="input"
            value={operatorId}
            onChange={(e) => {
              setOperatorId(e.target.value);
              reset();
            }}
          >
            <option value="">Tất cả</option>
            {(operators.data?.items ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.legal_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field search-field">
          Tìm trụ sạc
          <input
            className="input"
            type="search"
            value={cpSearch}
            maxLength={MAX_SEARCH}
            placeholder="Mã, số seri hoặc ID trụ"
            onChange={(e) => {
              setCpSearch(e.target.value);
              reset();
            }}
          />
        </label>
        <label className="field search-field">
          Tìm trạm sạc
          <input
            className="input"
            type="search"
            value={siteSearch}
            maxLength={MAX_SEARCH}
            placeholder="Mã, tên hoặc ID trạm"
            onChange={(e) => {
              setSiteSearch(e.target.value);
              reset();
            }}
          />
        </label>
        <label className="field">
          Kết nối
          <select
            className="input"
            value={online}
            onChange={(e) => {
              setOnline(e.target.value as OnlineFilter);
              reset();
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
              reset();
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
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered ? 'Không có trụ nào khớp bộ lọc.' : 'Chưa có trụ sạc nào trên nền tảng.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Trụ sạc</th>
                  <th scope="col">Đơn vị vận hành · trạm sạc</th>
                  <th scope="col">Vòng đời</th>
                  <th scope="col">Kết nối</th>
                  <th scope="col">Súng</th>
                  <th scope="col">Sự cố đang mở</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((cp) => (
                  <Row key={cp.id} cp={cp} now={now} />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              {total} trụ · Trang {page} / {pages}
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
      <p className="muted small">
        Uptime và tỉ lệ sử dụng (BR-P43) sẽ hiện khi có API số liệu theo trụ.
      </p>
    </>
  );
}
