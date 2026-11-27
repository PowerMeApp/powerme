/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04 / AD-7): every fault of the Operator. The table lives
 * in features/alerts/FaultTable (shared with Charge Point Detail, screen 20).
 */
import { FaultTable } from '../../features/alerts/FaultTable';
import { PageHeader } from '../../ui/PageHeader';

export function FaultAlertsPage() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Cảnh báo sự cố' }]} title="Cảnh báo sự cố" />
      <FaultTable />
    </>
  );
}
