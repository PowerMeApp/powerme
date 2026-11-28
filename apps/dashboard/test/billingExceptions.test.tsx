/** Screens 32 / 33 — Billing Exceptions (FE-09, UC-ADM-08) against a fake CSMS with #212's shapes. */
import { screen, waitFor, within } from '@testing-library/react';
import type { BillingExceptions } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/billing/exceptions';
const driver = { driver_id: '42', full_name: 'Nguyễn Thị Lan', phone_number: '+84901234567' };
const AT = '2026-11-25T03:00:00.000Z';
const DATA: BillingExceptions = {
  generated_at: AT,
  limit: 200,
  late_payments: {
    total: 1,
    items: [
      {
        top_up_id: '11',
        gateway_reference: 'TU-11',
        status: 'expired',
        late_amount_vnd: 200000,
        late_gateway_ref: 'VNP-LATE-1',
        late_paid_at: AT,
        driver,
      },
    ],
  },
  invoices_needs_review: {
    total: 1,
    items: [
      {
        e_invoice_id: '21',
        top_up_id: '12',
        amount_vnd: 100000,
        attempt_count: 4,
        last_error_kind: 'data',
        last_error_message: 'Mã số thuế không hợp lệ',
        updated_at: AT,
        driver,
      },
    ],
  },
  top_up_exceptions: {
    total: 1,
    items: [
      {
        top_up_id: '13',
        gateway_reference: 'TU-13',
        status: 'pending',
        exception_kind: 'unresolved_04',
        amount_paid_vnd: 50000,
        completed_at: null,
        driver,
      },
    ],
  },
  payment_conflicts: { total: 0, items: [] },
};

describe('Ngoại lệ thanh toán (màn 32 / 33)', () => {
  it('shows four tabs with counts; late payments first; menu link', async () => {
    fakeCsms({ [LIST]: { status: 200, body: DATA } });
    renderApp('/admin/billing', session(ADMIN));
    const late = within(await screen.findByRole('row', { name: 'Trả muộn lần nạp #11' }));
    expect(late.getByText('Nguyễn Thị Lan')).toBeInTheDocument();
    expect(late.getByText('200.000 ₫')).toBeInTheDocument();
    expect(late.getByText('VNP-LATE-1')).toBeInTheDocument();
    const tabs = within(screen.getByRole('group', { name: 'Danh sách' }));
    expect(tabs.getByRole('button', { name: /Trả muộn/ })).toHaveAttribute('aria-pressed', 'true');
    expect(tabs.getAllByLabelText('1 mục')).toHaveLength(3);
    expect(screen.getByText(/không cộng vào tín dụng sạc/)).toBeInTheDocument();
    // No internal task / rule codes on screen.
    expect(document.body.textContent).not.toMatch(/BR-P\d|T1\d\d/);
    expect(screen.getByRole('link', { name: 'Ngoại lệ thanh toán' })).toHaveAttribute(
      'href',
      '/admin/billing',
    );
  });

  it('e-invoice: the provider error is shown; "Thử lại" confirms then POSTs', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: DATA },
      'POST /api/admin/v1/billing/e-invoices/21/retry': {
        status: 202,
        body: { e_invoice_id: '21', status: 'requested', attempt_count: 4 },
      },
    });
    const { user } = renderApp('/admin/billing?tab=invoices', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Hoá đơn lần nạp #12' }));
    expect(row.getByText(/Dữ liệu bị từ chối/)).toBeInTheDocument();
    expect(row.getByText(/Mã số thuế không hợp lệ/)).toBeInTheDocument();
    await user.click(row.getByRole('button', { name: 'Thử lại' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Thử lại hoá đơn lần nạp #12' }));
    expect(sheet.getByText(/đã thử 4 lần/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText(/Đã gửi lại hoá đơn của lần nạp #12/)).toBeInTheDocument();
    expect(seen.some((r) => r.path === '/api/admin/v1/billing/e-invoices/21/retry')).toBe(true);
  });

  it('top-up exception: "Kiểm tra lại" shows the result; "Đã xem" asks first; 409 shows the reason', async () => {
    fakeCsms({
      [LIST]: { status: 200, body: DATA },
      'POST /api/admin/v1/billing/top-ups/13/recheck': {
        status: 200,
        body: {
          top_up_id: '13',
          result: 'still_unresolved',
          reason: 'vnpay_rc_94',
          retry_after_minutes: 15,
        },
      },
      'POST /api/admin/v1/billing/top-ups/13/exception-reviewed': {
        status: 409,
        body: { error: 'no_exception', detail: 'no_exception' },
      },
    });
    const { user } = renderApp('/admin/billing?tab=exceptions', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Ngoại lệ lần nạp #13' }));
    expect(row.getByText('VNPay mã 04: chưa rõ kết quả')).toBeInTheDocument();
    // D10: recheck comes before "Đã xem".
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Kiểm tra lại',
      'Đã xem',
    ]);
    await user.click(row.getByRole('button', { name: 'Kiểm tra lại' }));
    expect(await screen.findByText(/Thử lại sau khoảng 15 phút/)).toHaveClass('queue-note', 'ok');
    await user.click(row.getByRole('button', { name: 'Đã xem' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Đánh dấu đã xem lần nạp #13' }));
    expect(sheet.getByText(/không “Kiểm tra lại” được nữa/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Đã xem' }));
    expect(await sheet.findByText(/Lần nạp không còn ngoại lệ/)).toHaveClass('form-error');
  });

  it('payment conflict: the note is required (red under the field) and sent', async () => {
    const withConflict: BillingExceptions = {
      ...DATA,
      payment_conflicts: {
        total: 1,
        items: [
          {
            conflict_id: '31',
            top_up_id: '14',
            gateway_reference: 'TU-14',
            gateway_transaction_no: '14123456',
            amount_vnd: 150000,
            paid_at: AT,
            source: 'ipn',
            reason: 'amount_mismatch',
            created_at: AT,
            driver,
          },
        ],
      },
    };
    const seen = fakeCsms({
      [LIST]: { status: 200, body: withConflict },
      'POST /api/admin/v1/billing/payment-conflicts/31/review': {
        status: 200,
        body: { conflict_id: '31', reviewed_at: AT, reviewed_by: '1', review_note: 'x' },
      },
    });
    const { user } = renderApp('/admin/billing?tab=conflicts', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Trả mâu thuẫn lần nạp #14' }));
    await user.click(row.getByRole('button', { name: 'Đã xử lý' }));
    const sheet = within(screen.getByRole('dialog'));
    await user.click(sheet.getByRole('button', { name: 'Đã xử lý' }));
    const noteField = sheet.getByLabelText('Ghi chú xử lý (bắt buộc)');
    expect(
      document.getElementById(noteField.getAttribute('aria-describedby') ?? ''),
    ).toHaveTextContent('Nhập cách đã xử lý');
    await user.type(noteField, 'Đã hoàn 150.000 ₫ qua cổng VNPay');
    await user.click(sheet.getByRole('button', { name: 'Đã xử lý' }));
    expect(await screen.findByText(/Đã ghi nhận xử lý lần trả mâu thuẫn/)).toBeInTheDocument();
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      note: 'Đã hoàn 150.000 ₫ qua cổng VNPay',
    });
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/billing', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/billing'));
  });
});
