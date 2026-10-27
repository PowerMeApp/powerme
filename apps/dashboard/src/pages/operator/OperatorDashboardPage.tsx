/** Screen 17 — Operator Dashboard: số trụ theo trạng thái, cảnh báo mở; trung tâm mở mọi màn hình (Fig 10). */
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';
import { Card, Loading, PageHeader, Stat } from '../../components/ui';
import { useFaultsQuery, useOperatorSummaryQuery } from '../../core/api/api';
import { useAuth } from '../../core/context/AuthContext';
import { LIVE_POLL_MS } from '../../core/realtime/polling';
import { FaultItem } from '../../features/alerts/FaultItem';

const SHORTCUTS = [
  {
    to: '/operator/pillars',
    icon: 'pillar',
    title: 'Trụ sạc',
    text: 'Trạng thái từng súng, onboard trụ mới',
  },
  {
    to: '/operator/alerts',
    icon: 'alert',
    title: 'Cảnh báo sự cố',
    text: 'Xác nhận, Reset từ xa, đóng sự cố',
  },
  {
    to: '/operator/sessions',
    icon: 'session',
    title: 'Phiên cần xử lý',
    text: 'Đối soát conflict, phiên không định danh',
  },
  {
    to: '/operator/pricing',
    icon: 'tariff',
    title: 'Biểu giá',
    text: 'Bốn khung giờ và khuyến mãi',
  },
];

export function OperatorDashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useOperatorSummaryQuery(undefined, { pollingInterval: LIVE_POLL_MS });
  const { data: faults } = useFaultsQuery('open', { pollingInterval: LIVE_POLL_MS });

  return (
    <>
      <PageHeader
        title="Tổng quan vận hành"
        subtitle={`${user?.operatorName ?? ''} · cập nhật mỗi 3 giây`}
      />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid cols-4">
            <Stat
              label={
                <>
                  <Icon name="pillar" /> Trụ
                </>
              }
              value={data.pillars}
              sub={`${data.online} online · ${data.offline} offline`}
              tone="teal"
            />
            <Stat
              label={
                <>
                  <Icon name="bolt" /> Súng đang sạc
                </>
              }
              value={data.connectors.charging}
              sub={`${data.connectors.available} sẵn sàng · ${data.connectors.other} khác`}
              tone="gold"
            />
            <Stat
              label={
                <>
                  <Icon name="alert" /> Cảnh báo mở
                </>
              }
              value={data.openAlerts.total}
              sub={`${data.openAlerts.critical} nghiêm trọng · ${data.openAlerts.major} cao`}
              tone="danger"
            />
            <Stat
              label={
                <>
                  <Icon name="session" /> Cần xử lý
                </>
              }
              value={data.sessionsToReview + data.stuckStarts}
              sub={`${data.sessionsToReview} phiên · ${data.stuckStarts} lệnh start kẹt`}
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
        </>
      )}
      <Card
        title="Cảnh báo cần xử lý"
        extra={
          <Link to="/operator/alerts" className="btn small ghost" style={{ marginLeft: 'auto' }}>
            Xem tất cả
          </Link>
        }
      >
        <div className="grid">
          {(faults ?? []).slice(0, 3).map((f) => (
            <FaultItem key={f.id} fault={f} />
          ))}
          {faults && faults.length === 0 && <div className="muted">Không có cảnh báo mở.</div>}
        </div>
      </Card>
    </>
  );
}
