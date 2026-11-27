/** Screen 25 — Station Revenue (UC-OPS-09, F-16; FE-07): the Operator's own stations only. */
import { RevenueReportView } from '../../features/revenue/RevenueReportView';
import { PageHeader } from '../../ui/PageHeader';

export function RevenuePage() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Doanh thu' }]} title="Doanh thu" />
      <RevenueReportView scope="operator" />
    </>
  );
}
