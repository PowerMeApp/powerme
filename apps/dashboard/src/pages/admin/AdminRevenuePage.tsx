/**
 * Screen 35 — Transactions & Revenue (UC-ADM-10, F-16; FE-07): revenue of the whole platform, by
 * Operator first. The transaction list (GET /admin/v1/transactions, T108 part 2) comes in a later PR.
 */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { RevenueReportView } from '../../features/revenue/RevenueReportView';

export function AdminRevenuePage() {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Giao dịch & doanh thu' }]} />
      <div className="page-head">
        <h1>Giao dịch &amp; doanh thu</h1>
        <p>Doanh thu toàn nền tảng theo Operator, trạm sạc, trụ sạc và ngày</p>
      </div>
      <RevenueReportView scope="admin" />
      <p className="muted small revenue-later">
        Danh sách giao dịch từng phiên sẽ có khi API giao dịch của T108 sẵn sàng.
      </p>
    </>
  );
}
