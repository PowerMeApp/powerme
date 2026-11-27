/** Device registry (admin) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { RegistryChargePoint, RegistryChargePointPage } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/charge-points';
const POST = 'POST /api/admin/v1/charge-points';
const CREATED = '2026-11-20T03:00:00.000Z';
const cp = (id: string, over: Partial<RegistryChargePoint> = {}): RegistryChargePoint => ({
  id,
  serial_number: `SIM-000${id}`,
  display_code: null,
  model: null,
  firmware_version: null,
  rated_power_kw: null,
  warranty_until: null,
  lifecycle: 'registered',
  is_online: false,
  free_vend_tag: null,
  operator: null,
  site: null,
  created_at: CREATED,
  ...over,
});
const page = (items: RegistryChargePoint[]): RegistryChargePointPage => ({
  items,
  total: items.length,
  page: 1,
  page_size: 20,
});
const ROWS = page([
  cp('2'),
  cp('1', {
    display_code: 'HCM-0001',
    model: 'D1-120',
    firmware_version: '1.4.2',
    rated_power_kw: 120,
    warranty_until: '2028-03-31',
    lifecycle: 'in_service',
    is_online: true,
    operator: { id: '1', legal_name: 'SaiGon EV Partners' },
    site: { id: '7', site_code: 'HCM-Q1', site_name: 'Trạm Quận 1' },
  }),
]);

/** The message linked to an input (aria-describedby), i.e. the red text right beneath it. */
const errorUnder = (input: HTMLElement) =>
  document.getElementById(input.getAttribute('aria-describedby') ?? '');

describe('Sổ đăng ký trụ', () => {
  it('lists registered charge points with model, warranty, lifecycle and operator', async () => {
    const seen = fakeCsms({ [LIST]: { status: 200, body: ROWS } });
    renderApp('/admin/charge-points', session(ADMIN));
    const full = within(await screen.findByRole('row', { name: 'Trụ SIM-0001' }));
    expect(full.getByText('HCM-0001')).toBeInTheDocument();
    expect(full.getByText('D1-120')).toBeInTheDocument();
    expect(full.getByText('FW 1.4.2')).toBeInTheDocument();
    expect(full.getByText('120')).toBeInTheDocument();
    expect(full.getByText('31/03/2028')).toBeInTheDocument();
    expect(full.getByText('Đang hoạt động')).toBeInTheDocument();
    expect(full.getByText('SaiGon EV Partners')).toBeInTheDocument();
    expect(full.getByText('HCM-Q1 · Trạm Quận 1')).toBeInTheDocument();
    expect(full.getByText('20/11/2026')).toBeInTheDocument();
    const bare = within(screen.getByRole('row', { name: 'Trụ SIM-0002' }));
    expect(bare.getByText('Đã đăng ký')).toBeInTheDocument();
    expect(bare.getAllByText('—')).toHaveLength(5);
    expect(seen[0]).toMatchObject({ search: '?page=1&page_size=20' });
    expect(screen.getByRole('link', { name: 'Sổ đăng ký trụ' })).toHaveAttribute(
      'href',
      '/admin/charge-points',
    );
  });

  it('filters by lifecycle', async () => {
    const seen = fakeCsms({ [LIST]: { status: 200, body: ROWS } });
    const { user } = renderApp('/admin/charge-points', session(ADMIN));
    await screen.findByRole('row', { name: 'Trụ SIM-0001' });
    await user.selectOptions(screen.getByLabelText('Vòng đời'), 'registered');
    await waitFor(() =>
      expect(seen.at(-1)!.search).toBe('?lifecycle=registered&page=1&page_size=20'),
    );
  });

  it('checks the serial before sending, then registers and reloads the list', async () => {
    const seen = fakeCsms({
      [LIST]: { status: 200, body: ROWS },
      [POST]: { status: 201, body: cp('9', { serial_number: 'SIM-0099', model: 'D1-60' }) },
    });
    const { user } = renderApp('/admin/charge-points', session(ADMIN));
    await screen.findByRole('row', { name: 'Trụ SIM-0001' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký trụ' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Đăng ký trụ sạc' }));
    await user.type(dialog.getByLabelText('Serial'), 'a b');
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Serial 3–25 ký tự');
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
    await user.clear(dialog.getByLabelText('Serial'));
    await user.type(dialog.getByLabelText('Serial'), ' SIM-0099 ');
    await user.type(dialog.getByLabelText('Model (tuỳ chọn)'), 'D1-60');
    await user.type(dialog.getByLabelText('Công suất định mức, kW (tuỳ chọn)'), '60');
    const lists = seen.filter((r) => r.method === 'GET').length;
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    expect(
      await screen.findByText('Đã đăng ký trụ SIM-0099, operator có thể onboard trụ này'),
    ).toHaveClass('queue-note', 'ok');
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      serial_number: 'SIM-0099',
      model: 'D1-60',
      rated_power_kw: 60,
    });
    await waitFor(() =>
      expect(
        seen.filter((r) => r.method === 'GET' && r.path === '/api/admin/v1/charge-points').length,
      ).toBeGreaterThan(lists),
    );
  });

  it('D43: each invalid field shows its message in red right beneath it', async () => {
    fakeCsms({ [LIST]: { status: 200, body: ROWS } });
    const { user } = renderApp('/admin/charge-points', session(ADMIN));
    await screen.findByRole('row', { name: 'Trụ SIM-0001' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký trụ' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Đăng ký trụ sạc' }));
    const serial = dialog.getByLabelText('Serial');
    const model = dialog.getByLabelText('Model (tuỳ chọn)');
    const kw = dialog.getByLabelText('Công suất định mức, kW (tuỳ chọn)');
    await user.type(model, 'M'.repeat(21));
    await user.type(kw, '0');
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    for (const [input, text] of [
      [serial, 'Serial 3–25 ký tự'],
      [model, 'Model tối đa 20 ký tự'],
      [kw, 'Công suất phải là số lớn hơn 0'],
    ] as const) {
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(errorUnder(input)).toHaveTextContent(text);
      expect(errorUnder(input)).toHaveClass('form-error');
      expect(input.parentElement).toContainElement(errorUnder(input));
    }
    // Leaving the serial field after a valid value clears only its message.
    await user.type(serial, 'SIM-0042');
    await waitFor(() => expect(serial).toHaveAttribute('aria-invalid', 'false'));
    expect(model).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the text of a duplicate serial in the dialog', async () => {
    fakeCsms({
      [LIST]: { status: 200, body: ROWS },
      [POST]: {
        status: 409,
        body: { error: 'serial_already_registered', detail: 'SIM-0001 is already registered' },
      },
    });
    const { user } = renderApp('/admin/charge-points', session(ADMIN));
    await screen.findByRole('row', { name: 'Trụ SIM-0001' });
    await user.click(screen.getByRole('button', { name: 'Đăng ký trụ' }));
    const dialog = within(screen.getByRole('dialog'));
    const serial = dialog.getByLabelText('Serial');
    await user.type(serial, 'SIM-0001');
    await user.click(dialog.getByRole('button', { name: 'Đăng ký' }));
    // The 409 goes under the Serial field, in red.
    await waitFor(() =>
      expect(errorUnder(serial)).toHaveTextContent('Serial đã có trong sổ đăng ký'),
    );
    expect(errorUnder(serial)).toHaveClass('form-error');
  });

  it('shows an empty state when nothing is registered', async () => {
    fakeCsms({ [LIST]: { status: 200, body: page([]) } });
    renderApp('/admin/charge-points', session(ADMIN));
    expect(await screen.findByText('Chưa có trụ nào được đăng ký.')).toBeInTheDocument();
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/charge-points', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/charge-points'));
  });
});
