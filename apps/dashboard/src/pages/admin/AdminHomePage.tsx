import { RfidProtection } from '../../components/RfidProtection';
/**
 * Screen 27 — Admin Dashboard (hub, FE-14, UC-ADM-07). Greeting from /me, then:
 *   - platform statistics (20/11): revenue of the current month from T108's
 *     GET /api/admin/v1/revenue (group_by=operator, top 3 Operators), the charge point network
 *     (in service online / offline, connectors in the driver groups, open faults) and the
 *     Operators / Charging Stations — from GET /api/admin/v1/summary;
 *   - the SRS counts: user accounts by role, charge points by lifecycle, RFID cards by status.
 * A group that is 0 is hidden — never a placeholder (D36). The billing exceptions tile (FE-09) shows
 * only when there is work, highlighted, and opens screen 32. Polled every 10 s.
 *
 * Layout (redesign): the work that needs the Admin leads as alert cards — billing exceptions and
 * open faults on the network, red when something critical is in them, amber otherwise — or a teal
 * "all clear" line. Statistics and the registry counts follow, as before.
 */
import { Alert, Loader } from '@mantine/core';
import {
  IconCircleCheck,
  IconCreditCard,
  IconPlug,
  IconReportMoney,
  IconTopologyStar3,
  IconBuildingCommunity,
  IconUsers,
} from '@tabler/icons-react';
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
import { CountList } from '../../ui/CountList';
import { Notice } from '../../ui/Notice';
import { PageHeader, Section } from '../../ui/PageHeader';
import { Figure, StatCard } from '../../ui/StatCard';
import { StatusBadge } from '../../ui/StatusBadge';

export const ADMIN_SUMMARY_POLL_MS = 10_000;

type Rows<K extends string> = readonly (readonly [K, string, string])[];

const USER_GROUPS: Rows<keyof AdminSummary['users']> = [
  ['driver', 'Tài xế', ''],
  ['operator_staff', 'Nhân viên đơn vị vận hành', ''],
  ['admin', 'Quản trị viên', ''],
  ['suspended', 'Đang bị khoá', 'major'],
];
const CARD_GROUPS: Rows<keyof AdminSummary['rfid_cards']> = [
  ['active', 'Đang dùng', ''],
  ['unlinked', 'Chưa gắn tài xế', 'muted'],
  ['blocked', 'Bị chặn', 'major'],
];
const BILLING_GROUPS: Rows<keyof AdminSummary['billing_exceptions']> = [
  ['late_payments', 'Trả muộn chờ hoàn', 'major'],
  ['invoices_needs_review', 'Hoá đơn cần xem lại', 'major'],
  ['failed_refunds', 'Hoàn tiền thất bại', 'critical'],
];
const CONNECTOR_GROUPS: Rows<keyof AdminSummary['network']['connectors']> = [
  ['available', 'Sẵn sàng', ''],
  ['in_use', 'Đang dùng', ''],
  ['freeing_soon', 'Sắp trống', ''],
  ['unavailable', 'Không dùng được', 'major'],
  ['offline', 'Mất kết nối', 'muted'],
];
const SEVERITIES: Rows<keyof AdminSummary['network']['open_faults']> = [
  ['critical', 'Nghiêm trọng', 'critical'],
  ['major', 'Nặng', 'major'],
  ['minor', 'Nhẹ', ''],
  ['none', 'Khác', 'muted'],
];
const LIFECYCLE_ORDER: ChargePointLifecycle[] = [
  'registered',
  'awaiting_connection',
  'in_service',
  'disabled',
  'decommissioned',
];

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
    <StatCard
      label="Doanh thu tháng này"
      icon={<IconReportMoney size={18} />}
      to="/admin/revenue"
      wide
    >
      {error && !data ? (
        <p role="alert">{errorMessage(error)}</p>
      ) : !data ? (
        <p className="muted">Đang tải…</p>
      ) : (
        <>
          <Figure value={formatVnd(data.totals.csms_billed_revenue_vnd)} />
          <p className="muted small">
            {formatDay(from)} – {formatDay(to)} ·{' '}
            {formatCount(data.totals.csms_billed_session_count)} phiên tính tiền ·{' '}
            {formatKwh(data.totals.csms_billed_energy_wh)}
            {data.totals.unattributed_session_count > 0 &&
              ` · ${formatCount(data.totals.unattributed_session_count)} phiên không định danh`}
          </p>
          {top.length > 0 && (
            <ol className="top-list" aria-label="Đơn vị vận hành dẫn đầu">
              {top.map((r) => (
                <li key={r.key}>
                  {r.operator_name ?? r.key} <b>{formatVnd(r.csms_billed_revenue_vnd)}</b>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </StatCard>
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
  const billing = s
    ? s.billing_exceptions.late_payments +
      s.billing_exceptions.invoices_needs_review +
      s.billing_exceptions.failed_refunds
    : 0;
  const net = s?.network;
  const inService = net ? net.in_service_online + net.in_service_offline : 0;
  const faults = net?.open_faults;
  const empty = s ? users + chargePoints + cards === 0 && s.operators.total === 0 : false;
  const allClear = s && !empty && billing === 0 && (faults?.total ?? 0) === 0;

  return (
    <>
      <PageHeader
        title="Tổng quan nền tảng"
        subtitle={
          me.isLoading ? (
            'Đang tải…'
          ) : me.error ? (
            <span role="alert">{errorMessage(me.error)}</span>
          ) : me.data ? (
            `Xin chào ${me.data.full_name}. Bạn đang quản trị toàn bộ nền tảng PowerMe.`
          ) : null
        }
      />
      {summary.isLoading && <Loader size="sm" aria-label="Đang tải số liệu" />}
      {summary.error && !s && <Notice tone="error">{errorMessage(summary.error)}</Notice>}
      {empty && (
        <p className="muted">
          Nền tảng chưa có tài khoản, trụ sạc hay thẻ RFID nào.{' '}
          <Link to="/admin/charge-points">Đăng ký trụ sạc đầu tiên →</Link>
        </p>
      )}
      {allClear && (
        <Alert
          className="all-clear"
          color="teal"
          variant="light"
          role="note"
          icon={<IconCircleCheck size={20} aria-hidden="true" />}
        >
          Không có ngoại lệ thanh toán và không có sự cố đang mở trên mạng lưới.
        </Alert>
      )}
      <RfidProtection data={s?.rfid_credit_protection} />
      {s && !empty && (
        <>
          {(billing > 0 || (faults?.total ?? 0) > 0) && (
            <div className="tiles alert-band">
              {billing > 0 && (
                <StatCard
                  label="Ngoại lệ thanh toán"
                  tone={s.billing_exceptions.failed_refunds > 0 ? 'critical' : 'major'}
                  urgent
                  to="/admin/billing"
                >
                  <Figure value={formatCount(billing)} />
                  <CountList rows={BILLING_GROUPS} values={s.billing_exceptions} />
                </StatCard>
              )}
              {faults && faults.total > 0 && (
                <StatCard
                  label="Sự cố đang mở trên mạng lưới"
                  title="Sự cố đang mở"
                  tone={faults.critical > 0 ? 'critical' : 'major'}
                  urgent
                  to="/admin/network"
                >
                  <Figure value={`${formatCount(faults.total)} đang mở`} />
                  <CountList rows={SEVERITIES} values={faults} />
                </StatCard>
              )}
            </div>
          )}
          <Section label="Thống kê chung">
            <div className="tiles">
              <MonthRevenue />
              {inService > 0 && net && (
                <StatCard
                  label="Mạng lưới trụ sạc"
                  icon={<IconTopologyStar3 size={18} />}
                  to="/admin/network"
                >
                  <Figure
                    value={formatCount(net.in_service_online)}
                    note={`/ ${formatCount(inService)} trụ đang hoạt động, đang kết nối`}
                  />
                  {net.in_service_offline > 0 && (
                    <p>
                      <StatusBadge tone="major">Mất kết nối</StatusBadge>{' '}
                      <b>{formatCount(net.in_service_offline)}</b> trụ
                    </p>
                  )}
                  <CountList rows={CONNECTOR_GROUPS} values={net.connectors} />
                  <p className="small">
                    {net.open_faults.total > 0 ? (
                      <>
                        Sự cố đang mở{' '}
                        <CountBadge count={net.open_faults.total} label="sự cố đang mở" />{' '}
                        {net.open_faults.critical > 0 && (
                          <StatusBadge tone="critical">
                            {formatCount(net.open_faults.critical)} nghiêm trọng
                          </StatusBadge>
                        )}
                      </>
                    ) : (
                      <span className="muted">Không có sự cố đang mở.</span>
                    )}
                  </p>
                </StatCard>
              )}
              {s.operators.total > 0 && (
                <StatCard
                  label="Đơn vị vận hành và trạm sạc"
                  title="Đơn vị vận hành & trạm sạc"
                  icon={<IconBuildingCommunity size={18} />}
                >
                  <Figure value={formatCount(s.operators.total)} note="đơn vị vận hành" />
                  <ul className="count-list">
                    {s.operators.total > s.operators.active && (
                      <li>
                        <StatusBadge tone="major">Ngừng hoạt động</StatusBadge>{' '}
                        <b>{formatCount(s.operators.total - s.operators.active)}</b>
                      </li>
                    )}
                    <li>
                      <StatusBadge>Trạm sạc</StatusBadge> <b>{formatCount(s.sites)}</b>
                    </li>
                  </ul>
                </StatCard>
              )}
            </div>
          </Section>

          {users + chargePoints + cards > 0 && (
            <Section label="Tài khoản, trụ sạc, thẻ">
              <div className="tiles">
                {users > 0 && (
                  <StatCard label="Tài khoản" icon={<IconUsers size={18} />} to="/admin/users">
                    <Figure value={formatCount(users)} />
                    <CountList rows={USER_GROUPS} values={s.users} />
                  </StatCard>
                )}
                {chargePoints > 0 && (
                  <StatCard
                    label="Trụ sạc đã đăng ký"
                    icon={<IconPlug size={18} />}
                    to="/admin/charge-points"
                  >
                    <Figure value={formatCount(chargePoints)} />
                    <CountList
                      rows={lifecycles.map(
                        (l) => [l, LIFECYCLE[l], l === 'decommissioned' ? 'muted' : ''] as const,
                      )}
                      values={s.charge_points.by_lifecycle}
                    />
                  </StatCard>
                )}
                {cards > 0 && (
                  <StatCard
                    label="Thẻ RFID"
                    icon={<IconCreditCard size={18} />}
                    to="/admin/rfid-cards"
                  >
                    <Figure value={formatCount(cards)} />
                    <CountList rows={CARD_GROUPS} values={s.rfid_cards} />
                  </StatCard>
                )}
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}
