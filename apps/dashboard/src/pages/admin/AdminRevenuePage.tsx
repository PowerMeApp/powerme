/**
 * Screen 35 — Transactions & Revenue (UC-ADM-10, F-16; FE-07): revenue of the whole platform, by
 * Operator first, then the transaction list (GET /admin/v1/transactions, T108b) for the same period.
 */
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { RevenueReportView } from '../../features/revenue/RevenueReportView';
import { TransactionList } from '../../features/revenue/TransactionList';

export function AdminRevenuePage() {
  return (
    <>
      <Breadcrumbs items={[{ label: 'Giao dịch & doanh thu' }]} />
      <div className="page-head">
        <h1>Giao dịch &amp; doanh thu</h1>
      </div>
      <RevenueReportView scope="admin" />
      <TransactionList />
    </>
  );
}
