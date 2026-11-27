/**
 * Screen 27 — Admin Dashboard (hub, FE-14, UC-ADM-07). Greeting from /me, then:
 *   - platform statistics (20/11): revenue of the current month from T108's
 *     GET /api/admin/v1/revenue (group_by=operator, top 3 Operators), the charge point network
 *     (in service online / offline, connectors in the driver groups, open faults) and the
 *     Operators / Charging Stations — from GET /api/admin/v1/summary;
 *   - the SRS counts: user accounts by role, charge points by lifecycle, RFID cards by status.
 * A group that is 0 is hidden — never a placeholder (D36). The billing exceptions tile comes with
 * FE-09 (screen 32), although the API already returns its counts. Polled every 10 s.
 */
import { Link } from 'react-router';
import type { AdminSummary, ChargePointLifecycle } from '@powerme/shared';
import { CountBadge } from '../../components/CountBadge';
import {
  errorMessage,
  useAdminMeQuery,
  useAdminSummaryQuery,
  useRevenueQuery,
} from '../../core/api/api';
import { LIFECYCLE } from '../../features/chargePoints/format';
import {
  defaultPeriod,
  formatCount,
  formatDay,
  formatKwh,
  formatVnd,
} from '../../features/revenue/revenueModel';

export const ADMIN_SUMMARY_POLL_MS = 10_000;

const USER_GROUPS: [keyof AdminSummary['users'], string, string][] = [
  ['driver', 'Tài xế', ''],
  ['operator_staff', 'Nhân viên Operator', ''],
  ['admin', 'Admin', ''],
  ['suspended', 'Đang bị khoá', 'major'],
];
const CARD_GROUPS: [keyof AdminSummary['rfid_cards'], string, string][] = [
  ['active', 'Đang dùng', ''],
  ['unlinked', 'Chưa gắn tài xế', 'muted'],
  ['blocked', 'Bị chặn', 'major'],
];
const CONNECTOR_GROUPS: [keyof AdminSummary['network']['connectors'], string, string][] = [
  ['available', 'Sẵn sàng', ''],
  ['in_use', 'Đang dùng', ''],
  ['freeing_soon', 'Sắp trống', ''],
  ['unavailable', 'Không dùng được', 'major'],
  ['offline', 'Offline', 'muted'],
];
const LIFECYCLE_ORDER: ChargePointLifecycle[] = [
  'registered',
  'awaiting_connection',
  'in_service',
  'disabled',
  'decommissioned',
];

function Counts<K extends string>({
  rows,
  values,
}: {
  rows: [K, string, string][];
  values: Partial<Record<K, number>>;
}) {
  return (
    <ul className="tile-list">
      {rows
        .filter(([k]) => (values[k] ?? 0) > 0)
        .map(([k, label, tone]) => (
          <li key={k}>
            <span className={`pill ${tone}`}>{label}</span> <b>{formatCount(values[k]!)}</b>
          </li>
        ))}
    </ul>
  );
}

/** Revenue of the current month, all Operators, with the top three (T108 report). */
function MonthRevenue() {
  const { from, to } = defaultPeriod();
  const { data, error } = useRevenueQuery(
    { scope: 'admin', from, to, group_by: 'operator' },
    { pollingInterval: 60_000, skipPollingIfUnfocused: true },
  );
  const top = data
    ? [...data.rows]
        .filter((r) => r.csms_billed_revenue_vnd > 0)
        .sort((a, b) => b.csms_billed_revenue_vnd - a.csms_billed_revenue_vnd)
        .slice(0, 3)
    : [];
  return (
    <section className="card tile" aria-label="Doanh thu tháng này">
      <h2>Doanh thu tháng này</h2>
      {error && !data ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : !data ? (
        <p className="muted">Đang tải…</p>
      ) : (
        <>
          <p className="tile-number">{formatVnd(data.totals.csms_billed_revenue_vnd)}</p>
          <p className="muted small">
            {formatDay(from)} – {formatDay(to)} ·{' '}
            {formatCount(data.totals.csms_billed_session_count)} phiên tính tiền ·{' '}
            {formatKwh(data.totals.csms_billed_energy_wh)}
            {data.totals.unattributed_session_count > 0 &&
              ` · ${formatCount(data.totals.unattributed_session_count)} phiên không định danh`}
          </p>
          {top.length > 0 && (
            <ol className="tile-list top-list" aria-label="Operator dẫn đầu">
              {top.map((r) => (
                <li key={r.key}>
                  {r.operator_name ?? r.key} <b>{formatVnd(r.csms_billed_revenue_vnd)}</b>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <Link className="tile-link" to="/admin/revenue">
        Xem chi tiết →
      </Link>
    </section>
  );
}

export function AdminHomePage() {
  const me = useAdminMeQuery();
  const summary = useAdminSummaryQuery(undefined, {
    pollingInterval: ADMIN_SUMMARY_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const s = summary.data;
  const users = s ? s.users.driver + s.users.operator_staff + s.users.admin : 0;
  const lifecycles = s
    ? LIFECYCLE_ORDER.filter((l) => (s.charge_points.by_lifecycle[l] ?? 0) > 0)
    : [];
  const chargePoints = s ? lifecycles.reduce((n, l) => n + s.charge_points.by_lifecycle[l]!, 0) : 0;
  const cards = s ? s.rfid_cards.active + s.rfid_cards.blocked + s.rfid_cards.unlinked : 0;
  const net = s?.network;
  const inService = net ? net.in_service_online + net.in_service_offline : 0;
  const empty = s ? users + chargePoints + cards === 0 && s.operators.total === 0 : false;

  return (
    <>
      <div className="page-head">
        <h1>Tổng quan nền tảng</h1>
      </div>
      <div className="card">
        {me.isLoading && <p className="muted">Đang tải…</p>}
        {me.error && <p role="alert">{errorMessage(me.error)}</p>}
        {me.data && <p>Xin chào {me.data.full_name}. Bạn đang quản trị toàn nền tảng PowerMe.</p>}
      </div>
      {summary.error && !s && <p role="alert">{errorMessage(summary.error)}</p>}
      {empty && (
        <p className="muted">
          Nền tảng chưa có tài khoản, trụ sạc hay thẻ RFID nào.{' '}
          <Link to="/admin/charge-points">Đăng ký trụ sạc đầu tiên →</Link>
        </p>
      )}
      {s && !empty && (
        <>
          <h2 className="section-title">Thống kê chung</h2>
          <div className="tiles">
            <MonthRevenue />
            {inService > 0 && net && (
              <section className="card tile" aria-label="Mạng lưới trụ sạc">
                <h2>Mạng lưới trụ sạc</h2>
                <p className="tile-number">
                  {formatCount(net.in_service_online)}
                  <span className="muted">
                    {' '}
                    / {formatCount(inService)} trụ đang hoạt động online
                  </span>
                </p>
                {net.in_service_offline > 0 && (
                  <p>
                    <span className="pill muted">Offline</span>{' '}
                    <b>{formatCount(net.in_service_offline)}</b> trụ
                  </p>
                )}
                <Counts rows={CONNECTOR_GROUPS} values={net.connectors} />
                <p className="small">
                  {net.open_faults.total > 0 ? (
                    <>
                      Sự cố đang mở{' '}
                      <CountBadge count={net.open_faults.total} label="sự cố đang mở" />
                      {net.open_faults.critical > 0 && (
                        <span className="pill critical">
                          {formatCount(net.open_faults.critical)} nghiêm trọng
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="muted">Không có sự cố đang mở.</span>
                  )}
                </p>
                <Link className="tile-link" to="/admin/network">
                  Xem chi tiết →
                </Link>
              </section>
            )}
            {s.operators.total > 0 && (
              <section className="card tile" aria-label="Operator và trạm sạc">
                <h2>Operator &amp; trạm sạc</h2>
                <p className="tile-number">
                  {formatCount(s.operators.total)}
                  <span className="muted"> Operator</span>
                </p>
                <ul className="tile-list">
                  {s.operators.total > s.operators.active && (
                    <li>
                      <span className="pill major">Ngừng hoạt động</span>{' '}
                      <b>{formatCount(s.operators.total - s.operators.active)}</b>
                    </li>
                  )}
                  <li>
                    <span className="pill">Trạm sạc</span> <b>{formatCount(s.sites)}</b>
                  </li>
                </ul>
              </section>
            )}
          </div>

          {users + chargePoints + cards > 0 && (
            <>
              <h2 className="section-title">Tài khoản, trụ sạc, thẻ</h2>
              <div className="tiles">
                {users > 0 && (
                  <section className="card tile" aria-label="Tài khoản">
                    <h2>Tài khoản</h2>
                    <p className="tile-number">{formatCount(users)}</p>
                    <Counts rows={USER_GROUPS} values={s.users} />
                  </section>
                )}
                {chargePoints > 0 && (
                  <section className="card tile" aria-label="Trụ sạc đã đăng ký">
                    <h2>Trụ sạc đã đăng ký</h2>
                    <p className="tile-number">{formatCount(chargePoints)}</p>
                    <Counts
                      rows={lifecycles.map((l) => [
                        l,
                        LIFECYCLE[l],
                        l === 'decommissioned' ? 'muted' : '',
                      ])}
                      values={s.charge_points.by_lifecycle}
                    />
                    <Link className="tile-link" to="/admin/charge-points">
                      Xem chi tiết →
                    </Link>
                  </section>
                )}
                {cards > 0 && (
                  <section className="card tile" aria-label="Thẻ RFID">
                    <h2>Thẻ RFID</h2>
                    <p className="tile-number">{formatCount(cards)}</p>
                    <Counts rows={CARD_GROUPS} values={s.rfid_cards} />
                    <Link className="tile-link" to="/admin/rfid-cards">
                      Xem chi tiết →
                    </Link>
                  </section>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
