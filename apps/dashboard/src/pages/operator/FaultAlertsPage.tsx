/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04 / AD-7): every fault of the Operator. The table lives
 * in features/alerts/FaultTable (shared with Charge Point Detail, screen 20).
 */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { FaultTable } from '../../features/alerts/FaultTable';

export function FaultAlertsPage() {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Cảnh báo sự cố' }]} />
      <div className="page-head">
        <h1>Cảnh báo sự cố</h1>
        <p>
          Faulted, trụ sạc offline và tài xế báo lỗi · Mới → Đã xác nhận → Đang reset → Đã xử lý
        </p>
      </div>
      <FaultTable />
    </>
  );
}
