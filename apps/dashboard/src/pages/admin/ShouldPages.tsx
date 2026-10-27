/** Screen 32 Policy Templates và 33 System Health — «Should» trong SRS: khung xem được. */
import { Card, Loading, PageHeader, Pill, ShouldBanner, Stat } from '../../components/ui';
import { usePolicyTemplatesQuery, useSystemHealthQuery } from '../../core/api/api';
import { formatDateTime } from '../../utils/format';

export function PolicyTemplatesPage() {
  const { data, isLoading } = usePolicyTemplatesQuery();
  return (
    <>
      <PageHeader
        title="Mẫu chính sách"
        subtitle="Mẫu biểu giá và tích điểm dùng lại (UC-ADM-06)"
      />
      <ShouldBanner />
      {isLoading ? (
        <Loading />
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Loại</th>
                <th>Cập nhật</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <Pill tone={p.kind === 'tariff' ? 'teal' : 'gold'}>{p.kind}</Pill>
                  </td>
                  <td>{formatDateTime(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

export function SystemHealthPage() {
  const { data, isLoading } = useSystemHealthQuery();
  return (
    <>
      <PageHeader title="Sức khoẻ hệ thống" subtitle="Toàn nền tảng (UC-ADM-07)" />
      <ShouldBanner />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="grid cols-4">
          <Stat label="CSMS" value={data.csms === 'ok' ? 'OK' : 'Lỗi'} tone="teal" />
          <Stat label="Cơ sở dữ liệu" value={data.database === 'ok' ? 'OK' : 'Lỗi'} tone="teal" />
          <Stat label="Kết nối OCPP" value={data.ocppConnections} tone="gold" />
          <Stat
            label="Conflict đối soát"
            value={data.reconciliationConflicts}
            sub={`${data.messagesLastHour.toLocaleString('vi-VN')} bản tin / giờ`}
            tone="danger"
          />
        </div>
      )}
    </>
  );
}
