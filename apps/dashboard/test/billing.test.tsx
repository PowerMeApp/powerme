/**
 * UC-ADM-08 Billing Exceptions — TC-ADM08 trong docs/UC-ADM-08-BILLING-EXCEPTIONS.md mục 8,
 * chạy trên UI thật + mock server (luật SD-2c, STM-4/7, BR-P21/P44).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { mockDb } from '../src/mocks/server';
import { ADMIN, renderApp } from './render';

function row(text: RegExp | string) {
  return screen.getByText(text).closest('tr') as HTMLElement;
}

async function confirmIn(user: ReturnType<typeof renderApp>['user'], label: string) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: label }));
}

describe('Tab 1 — top-up để hoàn', () => {
  it('TC-ADM08-01/04: danh sách có badge; số dư thiếu → nút hoàn khoá kèm lý do', async () => {
    renderApp('/admin/billing', ADMIN);
    await screen.findByText('PM20261027-0501');
    expect(screen.getByRole('tab', { name: /Top-up để hoàn\s*3/ })).toBeInTheDocument();
    const blocked = within(row('PM20261026-0502')).getByRole('button', { name: 'Hoàn tiền' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', expect.stringMatching(/không hoàn một phần/));
  });

  it('TC-ADM08-05: huỷ hộp xác nhận → không gửi gì', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await screen.findByText('PM20261027-0501');
    await user.click(within(row('PM20261027-0501')).getByRole('button', { name: 'Hoàn tiền' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Huỷ' }),
    );
    expect(mockDb().topUps.find((t) => t.id === 501)?.status).toBe('credited');
  });

  it('TC-ADM08-06/07: xác nhận ghi số tiền + điểm; hoàn xong → dòng biến mất, badge giảm', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await screen.findByText('PM20261027-0501');
    await user.click(within(row('PM20261027-0501')).getByRole('button', { name: 'Hoàn tiền' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/195\.000 ₫/);
    expect(dialog).toHaveTextContent(/trả lại 500 điểm/);
    await confirmIn(user, 'Hoàn tiền');
    expect(
      await screen.findByText(/Đã hoàn 195\.000 ₫ cho Nguyễn Thị Lan · trả lại 500 điểm/),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('PM20261027-0501')).toBeNull());
    expect(screen.getByRole('tab', { name: /Top-up để hoàn\s*2/ })).toBeInTheDocument();
    expect(mockDb().topUps.find((t) => t.id === 501)).toMatchObject({
      status: 'refunded',
      balanceVnd: 30_000,
    });
  });

  it('TC-ADM08-09: số dư giảm trong lúc hộp mở → 422, dòng giữ nguyên', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await screen.findByText('PM20261025-0503');
    await user.click(within(row('PM20261025-0503')).getByRole('button', { name: 'Hoàn tiền' }));
    mockDb().topUps.find((t) => t.id === 503)!.balanceVnd = 40_000; // tài xế vừa sạc
    await confirmIn(user, 'Hoàn tiền');
    expect(await screen.findByText(/không hoàn một phần/)).toBeInTheDocument();
    expect(mockDb().topUps.find((t) => t.id === 503)?.status).toBe('credited');
  });

  it('TC-ADM08-10: bấm xác nhận hai lần liền → chỉ một yêu cầu', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await screen.findByText('PM20261027-0501');
    await user.click(within(row('PM20261027-0501')).getByRole('button', { name: 'Hoàn tiền' }));
    const dialog = await screen.findByRole('dialog');
    const btn = within(dialog).getByRole('button', { name: 'Hoàn tiền' });
    await user.dblClick(btn);
    await screen.findByText(/Đã hoàn 195\.000 ₫/);
    expect(screen.queryByText(/đã được hoàn/)).toBeNull(); // không có 409 từ lần bấm thứ hai
  });
});

describe('Tab 2 — thanh toán trễ', () => {
  it('TC-ADM08-14/12: cổng lỗi → 502, dòng còn; thử lại → hoàn xong', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await user.click(await screen.findByRole('tab', { name: /Thanh toán trễ/ }));
    await screen.findByText('VNP14590388');
    await user.click(
      within(row('VNP14590388')).getByRole('button', { name: 'Hoàn thanh toán trễ' }),
    );
    await confirmIn(user, 'Hoàn tiền');
    expect(await screen.findByText(/VNPay không xác nhận lệnh hoàn/)).toBeInTheDocument();
    expect(screen.getByText('VNP14590388')).toBeInTheDocument();

    await user.click(
      within(row('VNP14590388')).getByRole('button', { name: 'Hoàn thanh toán trễ' }),
    );
    await confirmIn(user, 'Hoàn tiền');
    expect(await screen.findByText(/Đã hoàn 500\.000 ₫ \(VNP14590388\)/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('VNP14590388')).toBeNull());
  });
});

describe('Tab 3 — hoá đơn needs_review', () => {
  it('TC-ADM08-18: thử lại thành công → số hoá đơn, dòng biến mất', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await user.click(await screen.findByRole('tab', { name: /Hoá đơn cần xử lý/ }));
    await screen.findByText('#701');
    await user.click(within(row('#701')).getByRole('button', { name: 'Thử lại' }));
    await confirmIn(user, 'Thử lại một lần');
    expect(await screen.findByText(/Đã phát hành C26TPM00000701/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('#701')).toBeNull());
  });

  it('TC-ADM08-19: lỗi bị từ chối vẫn lỗi → còn trong danh sách, số lần +1', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await user.click(await screen.findByRole('tab', { name: /Hoá đơn cần xử lý/ }));
    await screen.findByText('#702');
    expect(within(row('#702')).getByText('Bị từ chối')).toBeInTheDocument();
    await user.click(within(row('#702')).getByRole('button', { name: 'Thử lại' }));
    await confirmIn(user, 'Thử lại một lần');
    expect(await screen.findByText(/Vẫn lỗi \(lần 2\)/)).toBeInTheDocument();
    await waitFor(() => expect(within(row('#702')).getByText('2')).toBeInTheDocument());
  });
});

describe('Tab 4 — tài khoản đã đóng (SRS screen 31)', () => {
  it('chia hoàn về top-up mới nhất trước, rồi hoàn xong', async () => {
    const { user } = renderApp('/admin/billing', ADMIN);
    await user.click(await screen.findByRole('tab', { name: /Tài khoản đã đóng/ }));
    expect(await screen.findByText(/chờ xác nhận phạm vi/)).toBeInTheDocument();
    expect(screen.getByText(/PM20261025-0503 · 100\.000 ₫/)).toBeInTheDocument();
    expect(screen.getByText(/PM20261019-0470 · 40\.000 ₫/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hoàn số dư' }));
    await confirmIn(user, 'Hoàn số dư');
    expect(await screen.findByText(/Đã hoàn 140\.000 ₫ cho Phạm Quang Minh/)).toBeInTheDocument();
  });
});

describe('Admin — sổ thiết bị và người dùng', () => {
  it('đăng ký serial trùng → 409; serial mới → "Đã đăng ký"', async () => {
    const { user } = renderApp('/admin/devices', ADMIN);
    const serial = await screen.findByLabelText('Serial');
    await user.type(serial, 'RH24D1-00001');
    await user.click(screen.getByRole('button', { name: /Đăng ký/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/đã có trong sổ thiết bị/);
    await user.clear(serial);
    await user.type(serial, 'RH24D1-00077');
    await user.click(screen.getByRole('button', { name: /Đăng ký/ }));
    expect(await screen.findByText(/Đã đăng ký RH24D1-00077/)).toBeInTheDocument();
    expect(await screen.findByText('RH24D1-00077', { selector: 'td' })).toBeInTheDocument();
  });

  it('không đổi được vai trò của chính admin gốc', async () => {
    const { user } = renderApp('/admin/users', ADMIN);
    await user.selectOptions(
      await screen.findByLabelText('Vai trò của admin@powerme.local'),
      'driver',
    );
    expect(
      await screen.findByText(/Không đổi vai trò của chính tài khoản admin/),
    ).toBeInTheDocument();
  });
});
