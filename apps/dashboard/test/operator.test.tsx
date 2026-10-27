/** Trụ (hai súng độc lập), onboarding (WF-05), lệnh từ xa, phiên cần xử lý (WF-03, T72), biểu giá. */
import { screen, waitFor, within } from '@testing-library/react';
import { mockDb } from '../src/mocks/server';
import { OPERATOR, renderApp } from './render';

describe('Pillar List (screen 18)', () => {
  it('mỗi thẻ trụ hiện HAI trạng thái súng độc lập (M3)', async () => {
    renderApp('/operator/pillars', OPERATOR);
    const card = await screen.findByRole('link', { name: 'Trụ Q1-01' });
    expect(within(within(card).getByTestId('connector-1')).getByText('Lỗi')).toBeInTheDocument();
    expect(
      within(within(card).getByTestId('connector-2')).getByText('Đang sạc'),
    ).toBeInTheDocument();
  });

  it('lọc "Offline" chỉ còn trụ mất kết nối', async () => {
    const { user } = renderApp('/operator/pillars', OPERATOR);
    await screen.findByRole('link', { name: 'Trụ Q1-01' });
    await user.click(screen.getByRole('tab', { name: 'Offline' }));
    expect(screen.queryByRole('link', { name: 'Trụ Q1-01' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Trụ Q7-02' })).toBeInTheDocument();
  });
});

describe('Pillar Onboarding (screen 19, WF-05)', () => {
  it('serial đã đăng ký → onboard, mật khẩu hiện MỘT lần, trụ "Chờ kết nối"', async () => {
    const { user } = renderApp('/operator/pillars', OPERATOR);
    await user.click(await screen.findByRole('button', { name: /Onboard trụ/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Onboard trụ mới' });
    await user.type(within(sheet).getByLabelText('Serial'), 'rh24d1-00005');
    await user.selectOptions(within(sheet).getByLabelText('Site'), '1');
    await user.click(within(sheet).getByRole('button', { name: /Onboard và tạo mật khẩu/ }));
    const password = await within(sheet).findByTestId('credential-password');
    expect(password.textContent).toMatch(/^[A-Za-z0-9]{20}$/);
    await user.click(within(sheet).getByRole('button', { name: /Tôi đã lưu/ }));
    expect(screen.queryByTestId('credential-password')).toBeNull();
    expect(mockDb().devices.find((d) => d.serial === 'RH24D1-00005')?.lifecycle).toBe(
      'awaiting_connection',
    );
  });

  it('serial chưa được Admin đăng ký → 409, không tạo trụ', async () => {
    const { user } = renderApp('/operator/pillars', OPERATOR);
    await user.click(await screen.findByRole('button', { name: /Onboard trụ/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Onboard trụ mới' });
    await user.type(within(sheet).getByLabelText('Serial'), 'RH24D1-99999');
    await user.selectOptions(within(sheet).getByLabelText('Site'), '1');
    await user.click(within(sheet).getByRole('button', { name: /Onboard và tạo mật khẩu/ }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(/chưa có trong sổ thiết bị/);
    expect(mockDb().pillars).toHaveLength(4);
  });
});

describe('Pillar Detail (screen 20) — lệnh từ xa', () => {
  it('Dừng phiên chỉ bật cho súng đang sạc; gửi lệnh → có trong danh sách lệnh', async () => {
    const { user } = renderApp('/operator/pillars/1', OPERATOR);
    await screen.findByRole('heading', { name: 'Trụ Q1-01' });
    expect(screen.getByRole('button', { name: 'Dừng phiên A' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Dừng phiên B' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Gửi lệnh' }),
    );
    expect(await screen.findByText(/Đã gửi RemoteStopTransaction/)).toBeInTheDocument();
    expect(await screen.findByText(/RemoteStopTransaction · súng 2/)).toBeInTheDocument();
  });

  it('trụ offline → mọi nút lệnh khoá', async () => {
    renderApp('/operator/pillars/4', OPERATOR);
    await screen.findByRole('heading', { name: 'Trụ Q7-02' });
    expect(screen.getByText(/Trụ đang offline — không gửi lệnh được/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reset Soft/ })).toBeDisabled();
  });
});

describe('Phiên cần xử lý (screen 22)', () => {
  it('đối soát conflict: ghi chú bắt buộc; chốt → reconciled (STM-1 #17)', async () => {
    const { user } = renderApp('/operator/sessions', OPERATOR);
    await user.click(await screen.findByRole('button', { name: 'Xử lý' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Chốt đối soát' }));
    expect(await screen.findByText(/note phải có ít nhất 5 ký tự/)).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText('Ghi chú xử lý'),
      'Lấy chuỗi MeterValues 1.043 Wh',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Chốt đối soát' }));
    expect(await screen.findByText('Phiên #3 → reconciled')).toBeInTheDocument();
    expect(mockDb().sessions.find((s) => s.id === 1)?.status).toBe('reconciled');
    await waitFor(() =>
      expect(screen.getByText('Không còn phiên nào cần xử lý')).toBeInTheDocument(),
    );
  });

  it('lệnh start bị kẹt (T72): khôi phục → duyệt start muộn chỉ khi trụ đã gửi StartTransaction', async () => {
    const { user } = renderApp('/operator/sessions', OPERATOR);
    await user.click(await screen.findByRole('tab', { name: /Lệnh start bị kẹt/ }));
    const rows = await screen.findAllByRole('button', { name: 'Bắt đầu khôi phục' });
    await user.click(rows[1]!); // yêu cầu #2: trụ CHƯA gửi StartTransaction muộn
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Ghi chú khôi phục'),
      'Đã gọi tài xế, xe chưa cắm',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Bắt đầu khôi phục' }));
    await screen.findByText('Yêu cầu #2: recovering');
    const approve = await screen.findAllByRole('button', { name: 'Duyệt start muộn' });
    expect(approve[0]).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Trả súng về sẵn sàng' }));
    expect(await screen.findByText('Yêu cầu #2: connector_restored')).toBeInTheDocument();
  });
});

describe('Biểu giá (screen 23, M4)', () => {
  it('sửa làm chồng giờ → báo lỗi và khoá nút lưu; sửa đúng → lưu được', async () => {
    const { user } = renderApp('/operator/pricing', OPERATOR);
    const start = await screen.findByLabelText('Bắt đầu dòng 2');
    await user.clear(start);
    await user.type(start, '03:00');
    expect(await screen.findByText('Các khung giờ đang chồng lên nhau')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lưu biểu giá' })).toBeDisabled();

    await user.clear(start);
    await user.type(start, '04:00');
    const price = screen.getByLabelText('Giá dòng 3');
    await user.clear(price);
    await user.type(price, '4300');
    await user.click(screen.getByRole('button', { name: 'Lưu biểu giá' }));
    expect(await screen.findByText(/Đã lưu biểu giá/)).toBeInTheDocument();
    expect(mockDb().tariff[2]?.pricePerKwhVnd).toBe(4300);
  });
});
