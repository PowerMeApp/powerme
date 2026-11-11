/** Screens 16 / 26 and the role guard (SRS Table 6, D31) against a fake CSMS. */
import { screen, waitFor } from '@testing-library/react';
import type { LoginResponse } from '@powerme/shared';
import { SESSION_KEY } from '../src/core/auth/authSlice';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const ok = (user: typeof STAFF): { status: number; body: LoginResponse } => ({
  status: 200,
  body: { access_token: `token-${user.user_id}`, token_type: 'Bearer', expires_in: 28800, user },
});
const fail = (status: number, error: string, headers?: Record<string, string>) => ({
  status,
  body: { error, detail: error },
  ...(headers ? { headers } : {}),
});

async function submit(user: ReturnType<typeof renderApp>['user'], email: string) {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Mật khẩu'), 'mat-khau-123');
  await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
}

describe('Đăng nhập (màn 16 / 26) và phân quyền', () => {
  it.each([
    ['/operator', '/operator/login', 'Đăng nhập Operator Dashboard'],
    ['/admin/anything', '/admin/login', 'Đăng nhập Admin Console'],
  ])('chưa đăng nhập: %s → %s', async (from, to, heading) => {
    fakeCsms({});
    renderApp(from);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(currentPath()).toBe(to);
  });

  it('operator đăng nhập ở màn 16 → Operator Dashboard, token lưu và gửi Bearer cho /me', async () => {
    const seen = fakeCsms({
      'POST /api/auth/v1/login': ok(STAFF),
      'GET /api/operator/v1/me': { status: 200, body: STAFF },
    });
    const { user } = renderApp('/operator/login');
    await submit(user, 'staff@powerme.test');
    expect(await screen.findByRole('heading', { name: 'Tổng quan vận hành' })).toBeInTheDocument();
    expect(currentPath()).toBe('/operator');
    expect(await screen.findByText(/Xin chào Trần Trọng Nghĩa/)).toBeInTheDocument();
    expect(screen.getByText('Quản lý · SaiGon EV Partners')).toBeInTheDocument();
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/auth/v1/login',
      authorization: null,
      body: { email: 'staff@powerme.test', password: 'mat-khau-123' },
    });
    expect(seen.find((r) => r.path === '/api/operator/v1/me')?.authorization).toBe(
      'Bearer token-10',
    );
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!).token).toBe('token-10');
  });

  it.each([
    ['/operator/login', ADMIN, 'Đây là tài khoản Admin', '/admin/login'],
    ['/admin/login', STAFF, 'Đây là tài khoản Operator', '/operator/login'],
  ])(
    'màn %s từ chối tài khoản của vai trò kia và không lưu token',
    async (path, who, text, link) => {
      fakeCsms({ 'POST /api/auth/v1/login': ok(who) });
      const { user } = renderApp(path);
      await submit(user, who.email);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(alert.querySelector('a')).toHaveAttribute('href', link);
      expect(currentPath()).toBe(path);
      expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    },
  );

  it.each([
    [fail(401, 'invalid_credentials'), 'Email hoặc mật khẩu không đúng'],
    [fail(403, 'account_locked'), 'Tài khoản đã bị khoá'],
    [fail(403, 'operator_inactive'), 'Operator đã ngừng hoạt động'],
    [fail(429, 'too_many_attempts', { 'Retry-After': '840' }), 'thử lại sau 14 phút'],
    [fail(503, 'auth_unavailable'), 'Máy chủ chưa bật đăng nhập'],
    ['network' as const, 'Không kết nối được máy chủ'],
  ])('lỗi đăng nhập %# hiện đúng thông báo và vẫn ở màn đăng nhập', async (response, text) => {
    fakeCsms({ 'POST /api/auth/v1/login': response });
    const { user } = renderApp('/operator/login');
    await submit(user, 'staff@powerme.test');
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(currentPath()).toBe('/operator/login');
  });

  it('operator mở /admin về /operator; admin mở /operator về /admin', async () => {
    fakeCsms({
      'GET /api/operator/v1/me': { status: 200, body: STAFF },
      'GET /api/admin/v1/me': { status: 200, body: ADMIN },
    });
    const op = renderApp('/admin', session(STAFF));
    await screen.findByRole('heading', { name: 'Tổng quan vận hành' });
    expect(currentPath()).toBe('/operator');
    op.unmount();
    renderApp('/operator', session(ADMIN));
    await screen.findByRole('heading', { name: 'Tổng quan nền tảng' });
    expect(currentPath()).toBe('/admin');
  });

  it('đăng xuất xoá token và về màn đăng nhập của khu vực', async () => {
    fakeCsms({ 'GET /api/admin/v1/me': { status: 200, body: ADMIN } });
    sessionStorage.setItem(SESSION_KEY, '{}');
    const { user } = renderApp('/admin', session(ADMIN));
    await user.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(currentPath()).toBe('/admin/login');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it.each([[fail(401, 'unauthorized')], [fail(403, 'account_locked')]])(
    'phiên khôi phục bị CSMS từ chối ở /me → đăng xuất',
    async (response) => {
      fakeCsms({ 'GET /api/operator/v1/me': response });
      renderApp('/operator', session(STAFF));
      await waitFor(() => expect(currentPath()).toBe('/operator/login'));
    },
  );

  it('token hết hạn khi đang mở → tự đăng xuất', async () => {
    fakeCsms({ 'GET /api/operator/v1/me': { status: 200, body: STAFF } });
    renderApp('/operator', session(STAFF, 150));
    await screen.findByRole('heading', { name: 'Tổng quan vận hành' });
    await waitFor(() => expect(currentPath()).toBe('/operator/login'), { timeout: 2000 });
  });
});
