/** Screen 28 — Users & Roles (FE-19, UC-ADM-01/02) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { PlatformOperatorPage, UserAccount } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/users';
const OPERATORS = 'GET /api/admin/v1/operators';
const CREATED = '2026-11-20T03:00:00.000Z';
const user = (id: string, over: Partial<UserAccount> = {}): UserAccount => ({
  id,
  email: `user${id}@powerme.test`,
  full_name: `Người dùng ${id}`,
  phone_number: null,
  role: 'operator_staff',
  account_status: 'active',
  operator: { id: '1', legal_name: 'An Phát EV' },
  staff_role: 'technician',
  created_at: CREATED,
  ...over,
});
const USERS = {
  items: [
    user('1', { email: 'admin@powerme.test', role: 'admin', operator: null, staff_role: null }),
    user('5'),
    user('6', { account_status: 'suspended' }),
    user('7', { role: 'driver', operator: null, staff_role: null, phone_number: '+84901234567' }),
  ],
  total: 4,
  page: 1,
  page_size: 20,
};
const OPS: PlatformOperatorPage = {
  items: [{ id: '1', tax_code: '0400000181', legal_name: 'An Phát EV', status: 'active' }],
  total: 1,
  page: 1,
  page_size: 100,
};
const routes = (extra = {}) => ({
  [LIST]: { status: 200, body: USERS },
  [OPERATORS]: { status: 200, body: OPS },
  ...extra,
});
const buttons = (email: string) =>
  within(screen.getByRole('row', { name: `Tài khoản ${email}` }))
    .queryAllByRole('button')
    .map((b) => b.textContent);
/** The red message linked to an input (aria-describedby), right beneath it. */
const errorUnder = (input: HTMLElement) =>
  document.getElementById(input.getAttribute('aria-describedby') ?? '');

describe('Tài khoản & vai trò (màn 28)', () => {
  it('lists accounts with role, Operator and status; only valid actions; own row is protected', async () => {
    const seen = fakeCsms(routes());
    renderApp('/admin/users', session(ADMIN)); // ADMIN.user_id = '1'
    const staff = within(await screen.findByRole('row', { name: 'Tài khoản user5@powerme.test' }));
    expect(staff.getByText('Nhân viên đơn vị vận hành')).toBeInTheDocument();
    expect(staff.getByText('Kỹ thuật viên · An Phát EV')).toBeInTheDocument();
    expect(staff.getByText('Đang hoạt động')).toBeInTheDocument();
    expect(buttons('user5@powerme.test')).toEqual(['Sửa', 'Đổi vai trò', 'Khoá']);
    expect(buttons('user6@powerme.test')).toEqual(['Sửa', 'Đổi vai trò', 'Mở khoá']);
    expect(buttons('user7@powerme.test')).toEqual(['Sửa', 'Khoá']); // driver: no role change
    expect(buttons('admin@powerme.test')).toEqual(['Sửa']); // yourself
    expect(seen.find((r) => r.path === '/api/admin/v1/users')!.search).toBe('?page=1&page_size=20');
    expect(screen.getByRole('link', { name: 'Tài khoản & vai trò' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
  });

  it('filters by role, status, Operator and search (2+ characters)', async () => {
    const seen = fakeCsms(routes());
    const { user: u } = renderApp('/admin/users', session(ADMIN));
    await screen.findByRole('row', { name: 'Tài khoản user5@powerme.test' });
    await u.selectOptions(screen.getByLabelText('Vai trò'), 'operator_staff');
    await u.selectOptions(screen.getByLabelText('Trạng thái'), 'suspended');
    await u.selectOptions(
      screen.getByRole('combobox', { name: 'Đơn vị vận hành' }),
      await screen.findByRole('option', { name: 'An Phát EV' }),
    );
    await u.type(screen.getByLabelText('Tìm tài khoản'), 'ng');
    await waitFor(() =>
      expect(seen.filter((r) => r.path === '/api/admin/v1/users').at(-1)!.search).toBe(
        '?role=operator_staff&account_status=suspended&operator_id=1&q=ng&page=1&page_size=20',
      ),
    );
  });

  it('create staff: Operator required, errors under fields, 409 email under Email, then created', async () => {
    const seen = fakeCsms(
      routes({
        'POST /api/admin/v1/users': {
          status: 409,
          body: { error: 'email_taken', detail: 'email_taken' },
        },
      }),
    );
    const { user: u } = renderApp('/admin/users', session(ADMIN));
    await u.click(await screen.findByRole('button', { name: 'Tạo tài khoản' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Tạo tài khoản' }));
    await u.click(dialog.getByRole('button', { name: 'Tạo' }));
    expect(errorUnder(dialog.getByLabelText('Đơn vị vận hành'))).toHaveTextContent(
      'Chọn đơn vị vận hành',
    );
    expect(errorUnder(dialog.getByLabelText('Email'))).toHaveTextContent(
      'Email không hợp lệ',
    );
    expect(errorUnder(dialog.getByLabelText('Mật khẩu ban đầu'))).toHaveTextContent(
      'Ít nhất 8 ký tự',
    );
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
    await u.selectOptions(dialog.getByLabelText('Đơn vị vận hành'), '1');
    await u.selectOptions(dialog.getByLabelText('Chức vụ'), 'manager');
    await u.type(dialog.getByLabelText('Email'), 'new@powerme.test');
    await u.type(dialog.getByLabelText('Họ tên'), 'Nguyễn Quản Lý');
    await u.type(dialog.getByLabelText('Mật khẩu ban đầu'), 'mat-khau-123');
    await u.click(dialog.getByRole('button', { name: 'Tạo' }));
    const email = dialog.getByLabelText('Email');
    await waitFor(() =>
      expect(errorUnder(email)).toHaveTextContent('Email đã được dùng cho tài khoản khác'),
    );
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      email: 'new@powerme.test',
      full_name: 'Nguyễn Quản Lý',
      initial_password: 'mat-khau-123',
      role: 'operator_staff',
      operator_id: '1',
      staff_role: 'manager',
    });
  });

  it('create admin: Operator fields disappear and are not sent', async () => {
    const seen = fakeCsms(
      routes({
        'POST /api/admin/v1/users': { status: 201, body: user('9', { role: 'admin' }) },
      }),
    );
    const { user: u } = renderApp('/admin/users', session(ADMIN));
    await u.click(await screen.findByRole('button', { name: 'Tạo tài khoản' }));
    const dialog = within(screen.getByRole('dialog'));
    await u.selectOptions(dialog.getByLabelText('Vai trò'), 'admin');
    expect(dialog.queryByLabelText('Đơn vị vận hành')).toBeNull();
    await u.type(dialog.getByLabelText('Email'), 'admin2@powerme.test');
    await u.type(dialog.getByLabelText('Họ tên'), 'Admin Hai');
    await u.type(dialog.getByLabelText('Mật khẩu ban đầu'), 'mat-khau-123');
    await u.click(dialog.getByRole('button', { name: 'Tạo' }));
    expect(await screen.findByText('Đã tạo tài khoản admin2@powerme.test')).toBeInTheDocument();
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      email: 'admin2@powerme.test',
      full_name: 'Admin Hai',
      initial_password: 'mat-khau-123',
      role: 'admin',
    });
  });

  it('lock needs a note, then POSTs it; change role sends the role body', async () => {
    const seen = fakeCsms(
      routes({
        'POST /api/admin/v1/users/5/lock': {
          status: 200,
          body: user('5', { account_status: 'suspended' }),
        },
        'PUT /api/admin/v1/users/5/role': { status: 200, body: user('5', { role: 'admin' }) },
      }),
    );
    const { user: u } = renderApp('/admin/users', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Tài khoản user5@powerme.test' }));
    await u.click(row.getByRole('button', { name: 'Khoá' }));
    const lock = within(screen.getByRole('dialog', { name: 'Khoá tài khoản user5@powerme.test' }));
    await u.click(lock.getByRole('button', { name: 'Khoá' }));
    const noteField = lock.getByLabelText('Ghi chú (bắt buộc)');
    expect(errorUnder(noteField)).toHaveTextContent('Nhập ghi chú');
    await u.type(noteField, 'Nghỉ việc');
    await u.click(lock.getByRole('button', { name: 'Khoá' }));
    expect(await screen.findByText('Đã khoá tài khoản user5@powerme.test')).toBeInTheDocument();
    await u.click(row.getByRole('button', { name: 'Đổi vai trò' }));
    const role = within(screen.getByRole('dialog', { name: 'Đổi vai trò user5@powerme.test' }));
    await u.selectOptions(role.getByLabelText('Vai trò'), 'admin');
    await u.click(role.getByRole('button', { name: 'Đổi vai trò' }));
    expect(await screen.findByText('Đã đổi vai trò của user5@powerme.test')).toBeInTheDocument();
    expect(seen.filter((r) => r.method !== 'GET').map((r) => [r.path, r.body])).toEqual([
      ['/api/admin/v1/users/5/lock', { note: 'Nghỉ việc' }],
      ['/api/admin/v1/users/5/role', { role: 'admin' }],
    ]);
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/users', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/users'));
  });
});
