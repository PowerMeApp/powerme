/** Screens 32 / 33 — Billing Exceptions (FE-09, UC-ADM-08) against a fake CSMS with #212's shapes. */
import { screen, waitFor, within } from '@testing-library/react';
import type { BillingExceptions, RefundQueue } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/billing/exceptions';
const REFUNDS = 'GET /api/admin/v1/billing/refunds';
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
const refundRow = {
  kind: 'top_up' as const,
  requested_by: '1',
  created_at: AT,
  updated_at: AT,
  gateway_reference: 'TU-15',
  gateway_transaction_no: '15123456',
  paid_at: AT,
  driver,
};
const QUEUE: RefundQueue = {
  generated_at: AT,
  limit: 200,
  total: 2,
  items: [
    {
      ...refundRow,
      refund_id: '51',
      top_up_id: '15',
      amount_vnd: 300000,
      status: 'requested',
      failure_reason: null,
    },
    {
      ...refundRow,
      refund_id: '52',
      kind: 'account_closure',
      requested_by: null,
      top_up_id: '16',
      amount_vnd: 80000,
      status: 'failed',
      failure_reason: 'Cổng báo giao dịch quá 180 ngày',
    },
  ],
};

describe('Ngoại lệ thanh toán (màn 32 / 33)', () => {
  it('shows five tabs with counts; late payments first; menu link', async () => {
    fakeCsms({ [LIST]: { status: 200, body: DATA }, [REFUNDS]: { status: 200, body: QUEUE } });
    renderApp('/admin/billing', session(ADMIN));
    const late = within(await screen.findByRole('row', { name: 'Trả muộn lần nạp #11' }));
    expect(late.getByText('Nguyễn Thị Lan')).toBeInTheDocument();
    expect(late.getByText('200.000 ₫')).toBeInTheDocument();
    expect(late.getByText('VNP-LATE-1')).toBeInTheDocument();
    const tabs = within(screen.getByRole('group', { name: 'Danh sách' }));
    expect(tabs.getByRole('button', { name: /Trả muộn/ })).toHaveAttribute('aria-pressed', 'true');
    expect(tabs.getAllByLabelText('1 mục')).toHaveLength(3);
    expect(await tabs.findByLabelText('2 mục')).toBeInTheDocument();
    expect(late.getByRole('button', { name: 'Hoàn' })).toBeInTheDocument();
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

  it('top-up refund: 422 insufficient_available_balance shows a plain sentence, not the code', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: DATA },
      'POST /api/admin/v1/billing/top-ups/1024/refund': {
        status: 422,
        body: {
          error: 'insufficient_available_balance',
          detail: 'insufficient_available_balance',
        },
      },
    });
    const { user } = renderApp('/admin/billing', session(ADMIN));
    await user.click(await screen.findByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Tạo yêu cầu hoàn lần nạp' }));
    const field = sheet.getByLabelText('Mã lần nạp');
    await user.type(field, 'abc');
    await user.click(sheet.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    expect(await sheet.findByText('Mã lần nạp là một số, ví dụ 1024')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
    await user.clear(field);
    await user.type(field, ' 1024 ');
    await user.click(sheet.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    expect(
      await sheet.findByText(
        'Không thể hoàn: số dư khả dụng của tài xế không đủ cho lần nạp này (có thể đã dùng để sạc hoặc đang giữ cho phiên sạc).',
      ),
    ).toHaveClass('form-error');
    expect(screen.queryByText(/insufficient_available_balance/)).not.toBeInTheDocument();
  });

  it('top-up refund: success says how much customer service refunds; unknown number says so', async () => {
    fakeCsms({
      [LIST]: { status: 200, body: DATA },
      'POST /api/admin/v1/billing/top-ups/77/refund': {
        status: 202,
        body: { refund_id: '60', status: 'requested', amount_vnd: 250000 },
      },
    });
    const { user } = renderApp('/admin/billing', session(ADMIN));
    await user.click(await screen.findByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    let sheet = within(screen.getByRole('dialog'));
    await user.type(sheet.getByLabelText('Mã lần nạp'), '9');
    await user.click(sheet.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    expect(await sheet.findByText('Không có lần nạp #9')).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Huỷ' }));
    await user.click(screen.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    sheet = within(screen.getByRole('dialog'));
    await user.type(sheet.getByLabelText('Mã lần nạp'), '77');
    await user.click(sheet.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    expect(
      await screen.findByText(/Đã tạo yêu cầu hoàn lần nạp #77: CSKH hoàn 250.000 ₫/),
    ).toBeInTheDocument();
  });

  it('late payment: "Hoàn" asks first; 409 already_requested is explained', async () => {
    fakeCsms({
      [LIST]: { status: 200, body: DATA },
      'POST /api/admin/v1/billing/top-ups/11/late-refund': {
        status: 409,
        body: { error: 'already_requested', detail: 'already_requested' },
      },
    });
    const { user } = renderApp('/admin/billing', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Trả muộn lần nạp #11' }));
    await user.click(row.getByRole('button', { name: 'Hoàn' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Hoàn khoản trả muộn lần nạp #11' }));
    await user.click(sheet.getByRole('button', { name: 'Tạo yêu cầu hoàn' }));
    expect(await sheet.findByText(/đã có yêu cầu hoàn/)).toHaveClass('form-error');
  });

  it('refund queue: "Đã hoàn" checks and trims the refund number; refund_no_used is explained', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: DATA },
      [REFUNDS]: { status: 200, body: QUEUE },
      'POST /api/admin/v1/billing/refunds/51/confirm': {
        status: 409,
        body: { error: 'refund_no_used', detail: 'refund_no_used' },
      },
    });
    const { user } = renderApp('/admin/billing?tab=refunds', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Hoàn tiền lần nạp #15' }));
    expect(row.getByText('Hoàn lần nạp')).toBeInTheDocument();
    expect(row.getByText('300.000 ₫')).toBeInTheDocument();
    expect(row.getByText('Chờ hoàn')).toBeInTheDocument();
    await user.click(row.getByRole('button', { name: 'Đã hoàn' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Ghi nhận đã hoàn lần nạp #15' }));
    const field = sheet.getByLabelText('Mã hoàn trên cổng');
    await user.type(field, 'mã có dấu');
    await user.click(sheet.getByRole('button', { name: 'Đã hoàn' }));
    expect(await sheet.findByText(/Chỉ gồm chữ không dấu/)).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
    await user.clear(field);
    await user.type(field, '  RF-2026/001 ');
    await user.click(sheet.getByRole('button', { name: 'Đã hoàn' }));
    expect(await sheet.findByText(/đã được ghi cho một yêu cầu hoàn khác/)).toHaveClass(
      'form-error',
    );
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      gateway_refund_no: 'RF-2026/001',
    });
  });

  it('refund queue: "Cổng từ chối" needs a reason; a failed refund offers "Làm lại"', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: DATA },
      [REFUNDS]: { status: 200, body: QUEUE },
      'POST /api/admin/v1/billing/refunds/51/fail': {
        status: 200,
        body: { refund_id: '51', status: 'failed', failure_reason: 'Thẻ đã huỷ' },
      },
      'POST /api/admin/v1/billing/refunds/52/redo': {
        status: 409,
        body: { error: 'invalid_transition', detail: 'invalid_transition', from: 'requested' },
      },
    });
    const { user } = renderApp('/admin/billing?tab=refunds', session(ADMIN));
    const failed = within(await screen.findByRole('row', { name: 'Hoàn tiền lần nạp #16' }));
    expect(failed.getByText('Hoàn khi đóng tài khoản')).toBeInTheDocument();
    expect(failed.getByText('Hệ thống tạo')).toBeInTheDocument();
    expect(failed.getByText('Cổng báo giao dịch quá 180 ngày')).toBeInTheDocument();
    await user.click(failed.getByRole('button', { name: 'Làm lại' }));
    let sheet = within(screen.getByRole('dialog', { name: 'Làm lại hoàn lần nạp #16' }));
    await user.click(sheet.getByRole('button', { name: 'Làm lại' }));
    expect(await sheet.findByText(/Yêu cầu hoàn đã đổi trạng thái/)).toHaveClass('form-error');
    await user.click(sheet.getByRole('button', { name: 'Huỷ' }));

    const row = within(screen.getByRole('row', { name: 'Hoàn tiền lần nạp #15' }));
    await user.click(row.getByRole('button', { name: 'Cổng từ chối' }));
    sheet = within(screen.getByRole('dialog', { name: 'Cổng từ chối hoàn lần nạp #15' }));
    await user.click(sheet.getByRole('button', { name: 'Ghi nhận thất bại' }));
    expect(await sheet.findByText('Nhập lý do cổng từ chối')).toBeInTheDocument();
    await user.type(sheet.getByLabelText('Lý do (bắt buộc)'), 'Thẻ đã huỷ');
    await user.click(sheet.getByRole('button', { name: 'Ghi nhận thất bại' }));
    expect(
      await screen.findByText(/Đã ghi nhận cổng từ chối hoàn lần nạp #15/),
    ).toBeInTheDocument();
    expect(seen.find((r) => r.path.endsWith('/51/fail'))!.body).toEqual({ reason: 'Thẻ đã huỷ' });
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/billing', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/billing'));
  });
});
