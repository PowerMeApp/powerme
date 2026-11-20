/** Screen 25 — Station Revenue (UC-OPS-09, F-16; FE-07): the Operator's own stations only. */
import { RevenueReportView } from '../../features/revenue/RevenueReportView';

export function RevenuePage() {
  return (
    <>
      <div className="page-head">
        <h1>Doanh thu</h1>
        <p>Doanh thu theo trạm, Charge Point và ngày, từ các phiên đã đối soát</p>
      </div>
      <RevenueReportView scope="operator" />
    </>
  );
}
