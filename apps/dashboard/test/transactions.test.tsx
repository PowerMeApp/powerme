/** Screen 35 transaction list (UC-ADM-10) against a fake T108b API. */
import { screen, waitFor, within } from '@testing-library/react';
import type { RevenueReport, TransactionPage, TransactionRow } from '@powerme/shared';
import { afterEach, vi } from 'vitest';
import { EMPTY_BUCKET } from '../src/features/revenue/revenueModel';
import { ADMIN, fakeCsms, renderApp, session } from './render';

afterEach(() => vi.restoreAllMocks());

const REV = 'GET /api/admin/v1/revenue';
const TX = 'GET /api/admin/v1/transactions';
const TX_CSV = 'GET /api/admin/v1/transactions.csv';
const PERIOD = '?from=2026-11-01&to=2026-11-05';
const ok = (body: unknown) => ({ status: 200, body });

const tx = (over: Partial<TransactionRow>): TransactionRow => ({
  session_id: '101',
  transaction_no: 5001,
  kind: 'csms_billed',
  session_status: 'reconciled',
  payment_mode: 'csms_billed',
  origin: 'app_qr',
  operator_id: '3',
  operator_name: 'SaiGon EV',
  site_id: '5',
  site_code: 'Q1',
  site_name: 'Trạm Q1',
  charge_point_id: '11',
  serial_number: 'RH-1',
  connector_no: 1,
  started_at: '2026-11-03T08:00:00Z',
  stopped_at: '2026-11-03T09:00:00Z',
  period_at: '2026-11-03T09:00:00Z',
  period_day: '2026-11-03',
  energy_wh: 30_000,
  amount_vnd: 120_000,
  unsettled_reason: null,
  driver_id: '1',
  promotion_code: null,
  delivered_offline: false,
  ...over,
});
const txPage = (over: Partial<TransactionPage> = {}): TransactionPage => ({
  from: '2026-11-01',
  to: '2026-11-05',
  currency: 'VND',
  total: 3,
  items: [
    tx({}),
    tx({
      session_id: '102',
      kind: 'unattributed',
      payment_mode: 'unattributed',
      origin: 'free_vend',
      energy_wh: null,
      amount_vnd: null,
      driver_id: null,
      delivered_offline: true,
    }),
    tx({ session_id: '103', kind: 'unsettled', amount_vnd: null, unsettled_reason: 'ineligible' }),
  ],
  totals: {
    ...EMPTY_BUCKET,
    csms_billed_session_count: 1,
    csms_billed_energy_wh: 30_000,
    csms_billed_revenue_vnd: 120_000,
  },
  pending_reconciliation: { session_count: 0 },
  unsettled: { session_count: 1, by_reason: { ineligible: 1 } },
  generated_at: '2026-11-20T02:15:00Z',
  page: 1,
  page_size: 50,
  ...over,
});
const revenue: RevenueReport = {
  from: '2026-11-01',
  to: '2026-11-05',
  group_by: 'operator',
  operator_id: null,
  currency: 'VND',
  rows: [
    {
      key: '3',
      operator_id: '3',
      operator_name: 'SaiGon EV',
      site_id: null,
      site_name: null,
      charge_point_id: null,
      serial_number: null,
      day: null,
      ...EMPTY_BUCKET,
    },
  ],
  totals: EMPTY_BUCKET,
  pending_reconciliation: { session_count: 0 },
  unsettled: { session_count: 0, by_reason: {} },
  generated_at: '2026-11-20T02:15:00Z',
};
const txCalls = (seen: { path: string; search: string }[]) =>
  seen.filter((r) => r.path === '/api/admin/v1/transactions').map((r) => r.search);

describe('Danh sách giao dịch (màn 35, Admin)', () => {
  it('lists stopped sessions for the period of the page, with Vietnamese labels', async () => {
    const seen = fakeCsms({ [REV]: ok(revenue), [TX]: ok(txPage()) });
    renderApp(`/admin/revenue${PERIOD}`, session(ADMIN));
    const billed = within(await screen.findByRole('row', { name: 'Phiên #101' }));
    expect(billed.getByText('Đã tính tiền')).toBeInTheDocument();
    expect(billed.getByText('Ứng dụng (QR)')).toBeInTheDocument();
    expect(billed.getByText('120.000 ₫')).toBeInTheDocument();
    expect(billed.getByText('30 kWh')).toBeInTheDocument();
    expect(billed.getByText('03/11/2026 16:00')).toBeInTheDocument();

    const free = within(screen.getByRole('row', { name: 'Phiên #102' }));
    expect(free.getByText('Không định danh')).toBeInTheDocument();
    expect(free.getByText('Free vend')).toBeInTheDocument();
    expect(free.getByText('Thiếu số đo')).toBeInTheDocument(); // null is not 0 Wh
    expect(free.getByText('—')).toBeInTheDocument();
    expect(free.getByText('Trụ gửi bù sau khi nối lại')).toBeInTheDocument();

    const unsettled = within(screen.getByRole('row', { name: 'Phiên #103' }));
    expect(unsettled.getByText('Chưa đủ điều kiện trừ tiền')).toBeInTheDocument();
    // No internal codes in the list (the revenue tiles above are another PR's text).
    const list = screen.getByRole('region', { name: 'Danh sách giao dịch' });
    expect(list.textContent).not.toMatch(/T115|BR-P|UC-ADM|csms_billed|free_vend/);
    expect(screen.queryByText(/bản cập nhật sau/)).toBeNull();

    expect(screen.getByLabelText('Tổng giao dịch')).toHaveTextContent('120.000 ₫');
    expect(txCalls(seen)).toEqual([`${PERIOD}&page=1&page_size=50`]);
  });

  it('filters go to the API and back to page 1; paging asks the next page', async () => {
    const seen = fakeCsms({ [REV]: ok(revenue), [TX]: ok(txPage({ total: 120 })) });
    const { user } = renderApp(`/admin/revenue${PERIOD}`, session(ADMIN));
    await screen.findByRole('row', { name: 'Phiên #101' });
    expect(screen.getByText(/Trang 1 \/ 3/)).toBeInTheDocument();

    const pager = within(screen.getByRole('navigation', { name: 'Phân trang giao dịch' }));
    await user.click(pager.getByRole('button', { name: 'Sau ›' }));
    await waitFor(() => expect(txCalls(seen)).toContain(`${PERIOD}&page=2&page_size=50`));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Loại' }), 'unattributed');
    await waitFor(() =>
      expect(txCalls(seen)).toContain(`${PERIOD}&kind=unattributed&page=1&page_size=50`),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operator' }), '3');
    await waitFor(() =>
      expect(txCalls(seen)).toContain(
        `${PERIOD}&operator_id=3&kind=unattributed&page=1&page_size=50`,
      ),
    );
  });

  it('"Tải CSV giao dịch" asks transactions.csv with the same filters and no paging', async () => {
    const seen = fakeCsms({
      [REV]: ok(revenue),
      [TX]: ok(txPage()),
      [TX_CSV]: ok('session_id,amount_vnd'),
    });
    URL.createObjectURL = vi.fn(() => 'blob:tx');
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { user } = renderApp(`/admin/revenue${PERIOD}&tx_origin=rfid`, session(ADMIN));
    await user.click(await screen.findByRole('button', { name: 'Tải CSV giao dịch' }));
    await waitFor(() => expect(names).toEqual(['transactions_2026-11-01_2026-11-05.csv']));
    expect(seen.find((r) => r.path.endsWith('transactions.csv'))?.search).toBe(
      `${PERIOD}&origin=rfid`,
    );
  });

  it('a CSV larger than the export limit shows a plain message', async () => {
    fakeCsms({
      [REV]: ok(revenue),
      [TX]: ok(txPage()),
      [TX_CSV]: { status: 400, body: { error: 'export_too_large', detail: 'export_too_large' } },
    });
    const { user } = renderApp(`/admin/revenue${PERIOD}`, session(ADMIN));
    await user.click(await screen.findByRole('button', { name: 'Tải CSV giao dịch' }));
    expect(await screen.findByText(/Quá 100 000 dòng/)).toBeInTheDocument();
  });

  it('an empty result says so', async () => {
    fakeCsms({ [REV]: ok(revenue), [TX]: ok(txPage({ total: 0, items: [] })) });
    renderApp(`/admin/revenue${PERIOD}`, session(ADMIN));
    expect(
      await screen.findByText('Không có giao dịch nào khớp bộ lọc trong kỳ.'),
    ).toBeInTheDocument();
  });
});
