/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04 / AD-7): every fault of the Operator. The table lives
 * in features/alerts/FaultTable (shared with Charge Point Detail, screen 20).
 */
import { FaultTable } from '../../features/alerts/FaultTable';

export function FaultAlertsPage() {
  return (
    <>
      <div className="page-head">
        <h1>Cảnh báo sự cố</h1>
        <p>
          Faulted, Charge Point offline và tài xế báo lỗi · Mới → Đã xác nhận → Đang reset → Đã xử
          lý
        </p>
      </div>
      <FaultTable />
    </>
  );
}
