/** Screen 30 — RFID Cards (T161, UC-ADM-04) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { UserAccountPage, RfidCard, RfidCardPage } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/rfid-cards';
const ISSUED = '2026-11-20T03:00:00.000Z';
const LAN = { id: '42', email: 'lan@powerme.test', full_name: 'Nguyễn Thị Lan' };
const card = (id: string, over: Partial<RfidCard> = {}): RfidCard => ({
  id,
  card_identifier: `04A1B2C${id}`,
  card_kind: 'online',
  status: 'unlinked',
  driver: null,
  issued_at: ISSUED,
  updated_at: ISSUED,
  ...over,
});
const page = (items: RfidCard[], total = items.length): RfidCardPage => ({
  items,
  total,
  page: 1,
  page_size: 20,
});
const CARDS = page([
  card('1'),
  card('2', { status: 'active', driver: LAN }),
  card('3', { status: 'blocked', driver: LAN }),
  card('4', { status: 'blocked' }),
  card('5', { card_kind: 'free_vend', status: 'active', card_identifier: 'FREE-01' }),
]);
const DRIVERS: UserAccountPage = {
  items: [
    {
      id: '42',
      full_name: 'Nguyễn Thị Lan',
      email: 'lan@powerme.test',
      phone_number: '+84901234567',
      role: 'driver',
      account_status: 'active',
      operator: null,
      staff_role: null,
      created_at: ISSUED,
    },
  ],
  total: 1,
  page: 1,
  page_size: 10,
};
const buttons = (name: string) =>
  within(screen.getByRole('row', { name: `Thẻ ${name}` }))
    .queryAllByRole('button')
    .map((b) => b.textContent);

describe('Thẻ RFID (màn 30)', () => {
  it('lists cards with type, status, driver and date; only valid actions per row', async () => {
    const seen = fakeCsms({ [LIST]: { status: 200, body: CARDS } });
    renderApp('/admin/rfid-cards', session(ADMIN));
    const linked = within(await screen.findByRole('row', { name: 'Thẻ 04A1B2C2' }));
    expect(linked.getByText('Thẻ trả phí')).toBeInTheDocument();
    expect(linked.getByText('Đang dùng')).toBeInTheDocument();
    expect(linked.getByText('Nguyễn Thị Lan')).toBeInTheDocument();
    expect(linked.getByText('lan@powerme.test')).toBeInTheDocument();
    expect(linked.getByText('20/11/2026')).toBeInTheDocument();
    expect(buttons('04A1B2C1')).toEqual(['Gắn tài xế', 'Khoá']);
    expect(buttons('04A1B2C2')).toEqual(['Bỏ gắn', 'Khoá']);
    expect(buttons('04A1B2C3')).toEqual(['Mở khoá']);
    expect(buttons('04A1B2C4')).toEqual(['Mở khoá']);
    expect(buttons('FREE-01')).toEqual(['Khoá']);
    expect(screen.queryByRole('button', { name: /Xoá/ })).toBeNull();
    expect(seen[0]).toMatchObject({ search: '?page=1&page_size=20' });
    expect(screen.getByRole('link', { name: 'Thẻ RFID' })).toHaveAttribute(
      'href',
      '/admin/rfid-cards',
    );
  });

  it('filters by status, type and card identifier prefix', async () => {
    const seen = fakeCsms({ [LIST]: { status: 200, body: CARDS } });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    await screen.findByRole('row', { name: 'Thẻ 04A1B2C1' });
    await user.selectOptions(screen.getByLabelText('Trạng thái'), 'blocked');
    await user.selectOptions(screen.getByLabelText('Loại'), 'online');
    await user.type(screen.getByLabelText('Tìm thẻ'), '04A');
    await waitFor(() =>
      expect(seen.at(-1)!.search).toBe(
        '?status=blocked&card_kind=online&q=04A&page=1&page_size=20',
      ),
    );
  });

  it('registers an online card linked to a driver found by name', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'GET /api/admin/v1/users': { status: 200, body: DRIVERS },
      'POST /api/admin/v1/rfid-cards': {
        status: 201,
        body: card('9', { card_identifier: 'NEW-1', status: 'active', driver: LAN }),
      },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    await screen.findByRole('row', { name: 'Thẻ 04A1B2C1' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký thẻ' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Đăng ký thẻ RFID' }));
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Nhập mã thẻ');
    await user.type(dialog.getByLabelText('Mã thẻ'), '  NEW-1 ');
    await user.type(dialog.getByLabelText('Tài xế (tuỳ chọn)'), 'lan');
    await user.click(await dialog.findByRole('button', { name: /Nguyễn Thị Lan/ }));
    expect(seen.find((r) => r.path === '/api/admin/v1/users')!.search).toBe(
      '?role=driver&account_status=active&q=lan&page_size=10',
    );
    const lists = seen.filter((r) => r.path === '/api/admin/v1/rfid-cards').length;
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    expect(await screen.findByText('Đã đăng ký thẻ NEW-1 và gắn cho Nguyễn Thị Lan')).toHaveClass(
      'queue-note',
      'ok',
    );
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      card_identifier: 'NEW-1',
      card_kind: 'online',
      driver_id: '42',
    });
    // The list refreshes (and the screen-27 counts, same invalidation).
    await waitFor(() =>
      expect(seen.filter((r) => r.path === '/api/admin/v1/rfid-cards').length).toBe(lists + 2),
    );
  });

  it('a free-vend card is registered without a driver', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'POST /api/admin/v1/rfid-cards': { status: 201, body: card('9', { card_kind: 'free_vend' }) },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    await screen.findByRole('row', { name: 'Thẻ 04A1B2C1' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký thẻ' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Mã thẻ'), 'FREE-02');
    await user.selectOptions(dialog.getByLabelText('Loại'), 'free_vend');
    expect(dialog.queryByLabelText('Tài xế (tuỳ chọn)')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    await screen.findByText('Đã đăng ký thẻ FREE-02');
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      card_identifier: 'FREE-02',
      card_kind: 'free_vend',
    });
  });

  it('shows the 409 text of a duplicate card identifier in the dialog', async () => {
    fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'POST /api/admin/v1/rfid-cards': {
        status: 409,
        body: { error: 'card_already_registered', detail: 'card_already_registered' },
      },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    await screen.findByRole('row', { name: 'Thẻ 04A1B2C1' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký thẻ' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Mã thẻ'), '04A1B2C1');
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Mã thẻ đã được đăng ký');
  });

  it('block and unlink ask first, then PATCH status / driver_id', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'PATCH /api/admin/v1/rfid-cards/2': { status: 200, body: card('2') },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Thẻ 04A1B2C2' }));
    await user.click(row.getByRole('button', { name: 'Khoá' }));
    const block = within(screen.getByRole('dialog', { name: 'Khoá thẻ 04A1B2C2' }));
    await user.click(block.getByRole('button', { name: 'Khoá' }));
    await screen.findByText('Đã khoá thẻ 04A1B2C2');
    await user.click(row.getByRole('button', { name: 'Bỏ gắn' }));
    const unlink = within(screen.getByRole('dialog', { name: 'Bỏ gắn thẻ 04A1B2C2' }));
    expect(unlink.getByText(/Nguyễn Thị Lan/)).toBeInTheDocument();
    await user.click(unlink.getByRole('button', { name: 'Bỏ gắn' }));
    await screen.findByText('Đã bỏ gắn thẻ 04A1B2C2');
    expect(seen.filter((r) => r.method === 'PATCH').map((r) => r.body)).toEqual([
      { status: 'blocked' },
      { driver_id: null },
    ]);
  });

  it('unblock: at once when the card has a driver; asks for one when it has none', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'GET /api/admin/v1/users': { status: 200, body: DRIVERS },
      'PATCH /api/admin/v1/rfid-cards/3': { status: 200, body: card('3', { status: 'active' }) },
      'PATCH /api/admin/v1/rfid-cards/4': { status: 200, body: card('4', { status: 'active' }) },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    await screen.findByRole('row', { name: 'Thẻ 04A1B2C3' });
    await user.click(
      within(screen.getByRole('row', { name: 'Thẻ 04A1B2C3' })).getByRole('button', {
        name: 'Mở khoá',
      }),
    );
    await screen.findByText('Đã mở khoá thẻ 04A1B2C3');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(
      within(screen.getByRole('row', { name: 'Thẻ 04A1B2C4' })).getByRole('button', {
        name: 'Mở khoá',
      }),
    );
    const dialog = within(screen.getByRole('dialog', { name: 'Mở khoá thẻ 04A1B2C4' }));
    await user.click(dialog.getByRole('button', { name: 'Mở khoá' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Chọn một tài xế');
    await user.type(dialog.getByLabelText('Tài xế'), '0901');
    await user.click(await dialog.findByRole('button', { name: /Nguyễn Thị Lan/ }));
    await user.click(dialog.getByRole('button', { name: 'Mở khoá' }));
    await screen.findByText('Đã mở khoá thẻ 04A1B2C4 và gắn cho Nguyễn Thị Lan');
    expect(seen.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body])).toEqual([
      ['/api/admin/v1/rfid-cards/3', { status: 'active' }],
      ['/api/admin/v1/rfid-cards/4', { status: 'active', driver_id: '42' }],
    ]);
  });

  it('a stale card (404) shows the reason and reloads the list', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: CARDS },
      'PATCH /api/admin/v1/rfid-cards/1': {
        status: 404,
        body: { error: 'not_found', detail: 'not_found' },
      },
    });
    const { user } = renderApp('/admin/rfid-cards', session(ADMIN));
    const row = within(await screen.findByRole('row', { name: 'Thẻ 04A1B2C1' }));
    const lists = seen.filter((r) => r.method === 'GET').length;
    await user.click(row.getByRole('button', { name: 'Khoá' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Khoá' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Không tìm thấy thẻ này');
    await waitFor(() =>
      expect(seen.filter((r) => r.method === 'GET').length).toBeGreaterThan(lists),
    );
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/rfid-cards', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/rfid-cards'));
  });
});
