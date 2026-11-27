/** Screen 27 — Admin Dashboard (FE-14) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { AdminSummary, RevenueReport, RevenueRow } from '@powerme/shared';
import { defaultPeriod } from '../src/features/revenue/revenueModel';
import { ADMIN, fakeCsms, renderApp, session } from './render';

const SUMMARY: AdminSummary = {
  operators: { total: 3, active: 2 },
  sites: 7,
  network: {
    in_service_online: 9,
    in_service_offline: 1,
    connectors: { available: 12, in_use: 5, freeing_soon: 0, unavailable: 1, offline: 2 },
    open_faults: { total: 4, critical: 1, major: 3, minor: 0, none: 0 },
  },
  users: { driver: 120, operator_staff: 6, admin: 2, suspended: 0 },
  charge_points: { by_lifecycle: { registered: 3, in_service: 10 }, online: 9 },
  rfid_cards: { active: 40, blocked: 1, unlinked: 0 },
  billing_exceptions: { late_payments: 2, invoices_needs_review: 1, failed_refunds: 0 },
};
const op = (key: string, name: string, vnd: number): RevenueRow => ({
  key,
  operator_id: key,
  operator_name: name,
  site_id: null,
  site_name: null,
  charge_point_id: null,
  serial_number: null,
  day: null,
  csms_billed_session_count: 10,
  csms_billed_energy_wh: 100_000,
  csms_billed_revenue_vnd: vnd,
  unattributed_session_count: 0,
  unattributed_energy_wh: 0,
});
const REVENUE: RevenueReport = {
  ...defaultPeriod(),
  group_by: 'operator',
  operator_id: null,
  currency: 'VND',
  rows: [
    op('1', 'A Operator', 300_000),
    op('2', 'B Operator', 900_000),
    op('3', 'C Operator', 0),
    op('4', 'D Operator', 500_000),
  ],
  totals: {
    csms_billed_session_count: 40,
    csms_billed_energy_wh: 400_000,
    csms_billed_revenue_vnd: 1_700_000,
    unattributed_session_count: 2,
    unattributed_energy_wh: 9_000,
  },
  pending_reconciliation: { session_count: 0 },
  unsettled: { session_count: 0, by_reason: {} },
  generated_at: new Date().toISOString(),
};
const routes = (summary: AdminSummary) => ({
  'GET /api/admin/v1/me': { status: 200, body: ADMIN },
  'GET /api/admin/v1/summary': { status: 200, body: summary },
  'GET /api/admin/v1/revenue': { status: 200, body: REVENUE },
});

describe('Tổng quan nền tảng (màn 27)', () => {
  it('shows accounts, charge points, RFID cards and billing work; zero groups stay hidden', async () => {
    fakeCsms(routes(SUMMARY));
    renderApp('/admin', session(ADMIN));
    const users = within(await screen.findByRole('region', { name: 'Tài khoản' }));
    expect(users.getByText('128')).toBeInTheDocument();
    expect(users.getByText('Tài xế')).toBeInTheDocument();
    expect(users.getByText('120')).toBeInTheDocument();
    expect(users.queryByText('Đang bị khoá')).toBeNull();
    const cps = within(screen.getByRole('region', { name: 'Trụ sạc đã đăng ký' }));
    expect(cps.getByText('13')).toBeInTheDocument();
    expect(cps.getByText('Đã đăng ký')).toBeInTheDocument();
    expect(cps.queryByText('Đã gỡ')).toBeNull();
    expect(cps.getByRole('link', { name: 'Xem chi tiết →' })).toHaveAttribute(
      'href',
      '/admin/charge-points',
    );
    const cards = within(screen.getByRole('region', { name: 'Thẻ RFID' }));
    expect(cards.getByText('Bị chặn')).toBeInTheDocument();
    expect(cards.queryByText('Chưa gắn tài xế')).toBeNull();
    // T161: the tile opens screen 30.
    expect(cards.getByRole('link', { name: 'Xem chi tiết →' })).toHaveAttribute(
      'href',
      '/admin/rfid-cards',
    );
    // FE-09: the billing tile shows when there is work; only groups with a count (D36).
    const billing = within(screen.getByRole('region', { name: 'Ngoại lệ thanh toán' }));
    expect(billing.getByText('3')).toBeInTheDocument();
    expect(billing.getByText('Trả muộn chờ hoàn')).toBeInTheDocument();
    expect(billing.queryByText('Hoàn tiền thất bại')).toBeNull();
    expect(billing.getByRole('link', { name: 'Xem chi tiết →' })).toHaveAttribute(
      'href',
      '/admin/billing',
    );
  });

  it('shows suspended accounts when there are some', async () => {
    fakeCsms(routes({ ...SUMMARY, users: { ...SUMMARY.users, suspended: 3 } }));
    renderApp('/admin', session(ADMIN));
    const users = within(await screen.findByRole('region', { name: 'Tài khoản' }));
    expect(users.getByText('Đang bị khoá')).toBeInTheDocument();
  });

  it('an empty platform says so instead of zero tiles', async () => {
    fakeCsms(
      routes({
        operators: { total: 0, active: 0 },
        sites: 0,
        network: {
          in_service_online: 0,
          in_service_offline: 0,
          connectors: { available: 0, in_use: 0, freeing_soon: 0, unavailable: 0, offline: 0 },
          open_faults: { total: 0, critical: 0, major: 0, minor: 0, none: 0 },
        },
        users: { driver: 0, operator_staff: 0, admin: 0, suspended: 0 },
        charge_points: { by_lifecycle: {}, online: 0 },
        rfid_cards: { active: 0, blocked: 0, unlinked: 0 },
        billing_exceptions: { late_payments: 0, invoices_needs_review: 0, failed_refunds: 0 },
      }),
    );
    renderApp('/admin', session(ADMIN));
    expect(
      await screen.findByText('Nền tảng chưa có tài khoản, trụ sạc hay thẻ RFID nào.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('platform statistics: month revenue with top Operators, network, Operators and stations', async () => {
    const seen = fakeCsms(routes(SUMMARY));
    renderApp('/admin', session(ADMIN));
    const rev = within(await screen.findByRole('region', { name: 'Doanh thu tháng này' }));
    expect(await rev.findByText('1.700.000 ₫')).toBeInTheDocument();
    expect(
      rev.getByText(/40 phiên tính tiền · 400 kWh · 2 phiên không định danh/),
    ).toBeInTheDocument();
    // Top 3 by revenue, Operators without revenue left out.
    const top = within(rev.getByRole('list', { name: 'Đơn vị vận hành dẫn đầu' }));
    expect(top.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'B Operator 900.000 ₫',
      'D Operator 500.000 ₫',
      'A Operator 300.000 ₫',
    ]);
    expect(rev.getByRole('link', { name: 'Xem chi tiết →' })).toHaveAttribute(
      'href',
      '/admin/revenue',
    );
    const { from, to } = defaultPeriod();
    await waitFor(() =>
      expect(
        seen.some(
          (r) =>
            r.path === '/api/admin/v1/revenue' &&
            r.search === `?from=${from}&to=${to}&group_by=operator`,
        ),
      ).toBe(true),
    );
    const net = within(screen.getByRole('region', { name: 'Mạng lưới trụ sạc' }));
    expect(net.getByText(/\/ 10 trụ đang hoạt động, đang kết nối/)).toBeInTheDocument();
    expect(net.getByText('Sẵn sàng')).toBeInTheDocument();
    expect(net.queryByText('Sắp trống')).toBeNull();
    expect(net.getByLabelText('4 sự cố đang mở')).toHaveClass('count-badge');
    expect(net.getByText('1 nghiêm trọng')).toBeInTheDocument();
    const ops = within(screen.getByRole('region', { name: 'Đơn vị vận hành và trạm sạc' }));
    expect(ops.getByText('Ngừng hoạt động')).toBeInTheDocument();
    expect(ops.getByText('Trạm sạc')).toBeInTheDocument();
    expect(ops.getByText('7')).toBeInTheDocument();
  });
});
