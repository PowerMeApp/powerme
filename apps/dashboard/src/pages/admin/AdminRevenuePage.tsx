/**
 * Screen 35 — Transactions & Revenue (UC-ADM-10, F-16; FE-07): revenue of the whole platform, by
 * Operator first, then the transaction list (GET /admin/v1/transactions, T108b) for the same period.
 */
import { RevenueReportView } from '../../features/revenue/RevenueReportView';
import { TransactionList } from '../../features/revenue/TransactionList';
import { PageHeader } from '../../ui/PageHeader';

export function AdminRevenuePage() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Giao dịch & doanh thu' }]} title="Giao dịch & doanh thu" />
      <RevenueReportView scope="admin" />
      <TransactionList />
    </>
  );
}
