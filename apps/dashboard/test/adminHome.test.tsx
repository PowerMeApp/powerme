/** Screen 27 — Admin Dashboard (FE-14) against a fake CSMS. */
import { screen, within } from '@testing-library/react';
import type { AdminSummary } from '@powerme/shared';
import { ADMIN, fakeCsms, renderApp, session } from './render';

const SUMMARY: AdminSummary = {
  users: { driver: 120, operator_staff: 6, admin: 2, suspended: 0 },
  charge_points: { by_lifecycle: { registered: 3, in_service: 10 }, online: 9 },
  rfid_cards: { active: 40, blocked: 1, unlinked: 0 },
  billing_exceptions: { late_payments: 2, invoices_needs_review: 1, failed_refunds: 0 },
};
const routes = (summary: AdminSummary) => ({
  'GET /api/admin/v1/me': { status: 200, body: ADMIN },
  'GET /api/admin/v1/summary': { status: 200, body: summary },
});

describe('Tổng quan nền tảng (màn 27)', () => {
  it('shows accounts, charge points and RFID cards; zero groups and billing stay hidden', async () => {
    fakeCsms(routes(SUMMARY));
    renderApp('/admin', session(ADMIN));
    const users = within(await screen.findByRole('region', { name: 'Tài khoản' }));
    expect(users.getByText('128')).toBeInTheDocument();
    expect(users.getByText('Tài xế')).toBeInTheDocument();
    expect(users.getByText('120')).toBeInTheDocument();
    expect(users.queryByText('Đang bị khoá')).toBeNull();
    const cps = within(screen.getByRole('region', { name: 'Charge Point' }));
    expect(cps.getByText('13')).toBeInTheDocument();
    expect(cps.getByText(/9 \/ 10 đang hoạt động online/)).toBeInTheDocument();
    expect(cps.getByText('Đã đăng ký')).toBeInTheDocument();
    expect(cps.queryByText('Đã gỡ')).toBeNull();
    const cards = within(screen.getByRole('region', { name: 'Thẻ RFID' }));
    expect(cards.getByText('Bị chặn')).toBeInTheDocument();
    expect(cards.queryByText('Chưa gắn tài xế')).toBeNull();
    // D36: the billing exceptions tile comes with FE-09, even when the API has counts.
    expect(screen.queryByRole('region', { name: /thanh toán/i })).toBeNull();
    expect(screen.queryByText(/hoá đơn/i)).toBeNull();
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
        users: { driver: 0, operator_staff: 0, admin: 0, suspended: 0 },
        charge_points: { by_lifecycle: {}, online: 0 },
        rfid_cards: { active: 0, blocked: 0, unlinked: 0 },
        billing_exceptions: { late_payments: 0, invoices_needs_review: 0, failed_refunds: 0 },
      }),
    );
    renderApp('/admin', session(ADMIN));
    expect(
      await screen.findByText('Nền tảng chưa có tài khoản, Charge Point hay thẻ RFID nào.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
  });
});
