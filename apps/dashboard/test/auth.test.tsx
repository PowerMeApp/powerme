/** Đăng nhập và phân quyền màn hình (SRS Table 6; Fig 10/11: log in [Operator role] / [Admin role]). */
import { screen } from '@testing-library/react';
import { ADMIN, currentPath, OPERATOR, renderApp } from './render';

describe('Đăng nhập và phân quyền', () => {
  it('chưa đăng nhập → về /login', async () => {
    renderApp('/operator/alerts');
    expect(await screen.findByRole('form', { name: 'Đăng nhập' })).toBeInTheDocument();
    expect(currentPath()).toBe('/login');
  });

  it('operator đăng nhập → Operator Dashboard', async () => {
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Operator' }));
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Tổng quan vận hành' })).toBeInTheDocument();
    expect(currentPath()).toBe('/operator');
  });

  it('admin đăng nhập → Admin Console', async () => {
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Admin' }));
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Tổng quan nền tảng' })).toBeInTheDocument();
    expect(currentPath()).toBe('/admin');
  });

  it('sai mật khẩu → báo lỗi, vẫn ở /login', async () => {
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'operator@powerme.local');
    await user.type(screen.getByLabelText('Mật khẩu'), 'sai-mat-khau');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email hoặc mật khẩu không đúng');
  });

  it('operator không vào được /admin/billing; admin không vào được /operator/alerts', async () => {
    const op = renderApp('/admin/billing', OPERATOR);
    await screen.findByRole('heading', { name: 'Tổng quan vận hành' });
    expect(currentPath()).toBe('/operator');
    op.unmount();

    renderApp('/operator/alerts', ADMIN);
    await screen.findByRole('heading', { name: 'Tổng quan nền tảng' });
    expect(currentPath()).toBe('/admin');
  });

  it('đăng xuất từ mọi màn hình → /login', async () => {
    const { user } = renderApp('/operator/pricing', OPERATOR);
    await user.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(currentPath()).toBe('/login');
  });
});

describe('Mọi màn hình của Fig 10 / Fig 11 dựng được', () => {
  it.each([
    ['/operator', 'Tổng quan vận hành'],
    ['/operator/pillars', 'Trụ sạc'],
    ['/operator/pillars/1', 'Trụ Q1-01'],
    ['/operator/alerts', 'Cảnh báo sự cố'],
    ['/operator/sessions', 'Phiên cần xử lý'],
    ['/operator/pricing', 'Biểu giá & khuyến mãi'],
    ['/operator/tickets', 'Phiếu bảo trì'],
    ['/operator/analytics', 'Doanh thu'],
  ])('operator %s', async (path, heading) => {
    renderApp(path, OPERATOR);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it.each([
    ['/admin', 'Tổng quan nền tảng'],
    ['/admin/users', 'Người dùng & vai trò'],
    ['/admin/devices', 'Sổ thiết bị'],
    ['/admin/cards', 'Thẻ RFID & free vend'],
    ['/admin/billing', 'Ngoại lệ thanh toán'],
    ['/admin/policies', 'Mẫu chính sách'],
    ['/admin/health', 'Sức khoẻ hệ thống'],
  ])('admin %s', async (path, heading) => {
    renderApp(path, ADMIN);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });
});
