/** Screen 24 Maintenance Tickets và 25 Revenue Analytics — «Should» trong SRS: khung xem được. */
import { Card, Loading, PageHeader, Pill, ShouldBanner } from '../../components/ui';
import { useRevenueQuery, useTicketsQuery } from '../../core/api/api';
import { formatDateTime, formatVnd } from '../../utils/format';

export function TicketsPage() {
  const { data, isLoading } = useTicketsQuery();
  return (
    <>
      <PageHeader title="Phiếu bảo trì" subtitle="Mở từ sự cố và báo lỗi của tài xế (UC-OPS-08)" />
      <ShouldBanner />
      {isLoading ? (
        <Loading />
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>Phiếu</th>
                <th>Sự cố</th>
                <th>Trụ</th>
                <th>Giao cho</th>
                <th>Mở lúc</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="mono">#{t.ticketNo}</td>
                  <td>#{t.faultEventNo}</td>
                  <td className="mono">{t.serial}</td>
                  <td>{t.assignedTo ?? '—'}</td>
                  <td>{formatDateTime(t.openedAt)}</td>
                  <td>
                    <Pill tone={t.status === 'closed' ? 'teal' : 'gold'}>{t.status}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

export function AnalyticsPage() {
  const { data, isLoading } = useRevenueQuery();
  const max = Math.max(1, ...(data ?? []).map((r) => r.revenueVnd));
  const total = (data ?? []).reduce((a, r) => a + r.revenueVnd, 0);
  const unattributed = (data ?? []).reduce((a, r) => a + r.unattributedSessions, 0);
  return (
    <>
      <PageHeader
        title="Doanh thu"
        subtitle="Theo trụ, 30 ngày gần nhất · phiên không định danh là dòng riêng (UC-OPS-09)"
      />
      <ShouldBanner />
      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          <Card title="Doanh thu theo trụ" extra={<small>Tổng {formatVnd(total)}</small>}>
            <div className="bars">
              {(data ?? []).map((r) => (
                <div className="bar-row" key={r.serial}>
                  <span className="mono">{r.serial}</span>
                  <span className="bar">
                    <span style={{ width: `${(r.revenueVnd / max) * 100}%` }} />
                  </span>
                  <span className="num">{formatVnd(r.revenueVnd)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Sử dụng" extra={<small>{unattributed} phiên không định danh</small>}>
            <table className="table">
              <thead>
                <tr>
                  <th>Trụ</th>
                  <th className="num">Phiên</th>
                  <th className="num">kWh</th>
                  <th className="num">Tỉ lệ sử dụng</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((r) => (
                  <tr key={r.serial}>
                    <td className="mono">{r.serial}</td>
                    <td className="num">{r.sessions}</td>
                    <td className="num">{r.energyKwh.toLocaleString('vi-VN')}</td>
                    <td className="num">{r.utilisationPercent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}
