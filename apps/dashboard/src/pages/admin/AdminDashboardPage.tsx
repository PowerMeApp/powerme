/** Screen 27 — Admin Dashboard: số người dùng, trụ đã đăng ký, thẻ RFID, ngoại lệ thanh toán mở (Fig 11). */
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { Card, Loading, PageHeader, Stat } from '../../components/ui';
import { useAdminSummaryQuery } from '../../core/api/api';
import { LIVE_POLL_MS } from '../../core/realtime/polling';

const SHORTCUTS = [
  {
    to: '/admin/users',
    icon: 'users',
    title: 'Người dùng & vai trò',
    text: 'Tài khoản và phân quyền',
  },
  {
    to: '/admin/devices',
    icon: 'device',
    title: 'Sổ thiết bị',
    text: 'Đăng ký serial trước khi onboard',
  },
  {
    to: '/admin/cards',
    icon: 'card',
    title: 'Thẻ RFID & free vend',
    text: 'Thẻ online / ví, tag free vend',
  },
  {
    to: '/admin/billing',
    icon: 'billing',
    title: 'Ngoại lệ thanh toán',
    text: 'Hoàn tiền, hoá đơn lỗi',
  },
];

export function AdminDashboardPage() {
  const { data, isLoading } = useAdminSummaryQuery(undefined, { pollingInterval: LIVE_POLL_MS });
  if (isLoading || !data) return <Loading />;
  const b = data.billingExceptions;
  const openBilling = b.topUps + b.latePayments + b.invoices + b.closedAccounts;
  return (
    <>
      <PageHeader title="Tổng quan nền tảng" subtitle="Admin Console · toàn bộ operator" />
      <div className="grid cols-4">
        <Stat
          label={
            <>
              <Icon name="users" /> Người dùng
            </>
          }
          value={data.users}
          sub={`${data.drivers} tài xế`}
          tone="teal"
        />
        <Stat
          label={
            <>
              <Icon name="device" /> Trụ đã đăng ký
            </>
          }
          value={data.pillars}
          sub={`${data.pillarsAwaitingOnboarding} chờ operator onboard`}
          tone="gold"
        />
        <Stat
          label={
            <>
              <Icon name="card" /> Thẻ RFID
            </>
          }
          value={data.rfidCards}
        />
        <Stat
          label={
            <>
              <Icon name="billing" /> Ngoại lệ thanh toán
            </>
          }
          value={openBilling}
          sub={`${b.invoices} hoá đơn · ${b.latePayments} thanh toán trễ`}
          tone="danger"
        />
      </div>
      <div className="grid cols-4">
        {SHORTCUTS.map((s) => (
          <Link key={s.to} to={s.to} className="card shortcut">
            <span className="ico">
              <Icon name={s.icon} size={22} />
            </span>
            <span>
              <b>{s.title}</b>
              <p>{s.text}</p>
            </span>
          </Link>
        ))}
      </div>
      <Card title="Ngoại lệ thanh toán đang mở">
        <div className="grid cols-4">
          <Stat label="Top-up để hoàn" value={b.topUps} />
          <Stat label="Thanh toán trễ" value={b.latePayments} />
          <Stat label="Hoá đơn cần xử lý" value={b.invoices} />
          <Stat label="Tài khoản đã đóng" value={b.closedAccounts} />
        </div>
      </Card>
    </>
  );
}
