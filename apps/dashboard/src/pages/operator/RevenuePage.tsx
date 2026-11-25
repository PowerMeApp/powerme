/** Screen 25 — Station Revenue (UC-OPS-09, F-16; FE-07): the Operator's own stations only. */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { RevenueReportView } from '../../features/revenue/RevenueReportView';

export function RevenuePage() {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Doanh thu' }]} />
      <div className="page-head">
        <h1>Doanh thu</h1>
        <p>Doanh thu theo trạm sạc, trụ sạc và ngày, từ các phiên đã đối soát</p>
      </div>
      <RevenueReportView scope="operator" />
    </>
  );
}
