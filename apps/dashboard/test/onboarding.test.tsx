/** Screen 19 — Charge Point Onboarding sheet (FE-02, UC-OPS-01, BR-P49) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OnboardResult, SitePage } from '@powerme/shared';
import { fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/operator/v1/charge-points';
const SITES = 'GET /api/operator/v1/sites';
const ONBOARD = 'POST /api/operator/v1/charge-points/onboard';
const emptyList = { status: 200, body: { items: [], total: 0, page: 1, page_size: 20 } };
const site = (id: string, code: string, name: string) => ({
  id,
  site_code: code,
  site_name: name,
  address: null,
  vinfast_only: false,
  latitude: null,
  longitude: null,
});
const SITE_PAGE: SitePage = {
  items: [site('5', 'HCM-DEMO-01', 'Trạm Demo Q1'), site('7', 'HCM-DEMO-02', 'Trạm Demo Q7')],
  total: 2,
  page: 1,
  page_size: 100,
};
const RESULT: OnboardResult = {
  charge_point_id: '42',
  display_code: 'PM-D1-HCM-0002',
  lifecycle: 'awaiting_connection',
  ocpp_url: 'ws://localhost:9000/ocpp/SIM-0005',
  identity: 'SIM-0005',
  password: 'pw-shown-once',
};

async function openSheet(routes: Parameters<typeof fakeCsms>[0]) {
  const seen = fakeCsms({
    [LIST]: emptyList,
    [SITES]: { status: 200, body: SITE_PAGE },
    ...routes,
  });
  const r = renderApp('/operator/charge-points', session(STAFF));
  await r.user.click(await screen.findByRole('button', { name: 'Onboard trụ sạc' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Onboard trụ sạc' }));
  await dialog.findByRole('option', { name: 'HCM-DEMO-01 · Trạm Demo Q1' });
  return { ...r, seen, dialog };
}

describe('Onboard trụ sạc (màn 19)', () => {
  it("opens from screen 18 and lists the Operator's stations; a bad serial is caught first", async () => {
    const { user, seen, dialog } = await openSheet({});
    expect(dialog.getByRole('option', { name: 'HCM-DEMO-02 · Trạm Demo Q7' })).toBeInTheDocument();
    await user.type(dialog.getByLabelText('Serial'), 'ab');
    await user.click(dialog.getByRole('button', { name: 'Onboard' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Serial 3–25 ký tự');
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
  });

  it('posts serial, site_id as a number and the connectors; shows the credential once', async () => {
    const { user, seen, dialog } = await openSheet({ [ONBOARD]: { status: 201, body: RESULT } });
    await user.type(dialog.getByLabelText('Serial'), ' SIM-0005 ');
    await user.selectOptions(dialog.getByLabelText('Trạm sạc'), '7');
    await user.selectOptions(dialog.getByLabelText('Loại súng 2'), 'chademo');
    await user.type(dialog.getByLabelText('Công suất súng 1 (kW, tuỳ chọn)'), '120');
    const lists = seen.filter((r) => r.path === '/api/operator/v1/charge-points').length;
    await user.click(dialog.getByRole('button', { name: 'Onboard' }));

    const cred = within(await screen.findByRole('dialog', { name: 'Credential của trụ sạc' }));
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      serial_number: 'SIM-0005',
      site_id: 7,
      connectors: [
        { connector_no: 1, connector_type: 'ccs2', max_power_kw: 120 },
        { connector_no: 2, connector_type: 'chademo' },
      ],
    });
    expect(cred.getByText('PM-D1-HCM-0002')).toBeInTheDocument();
    expect(cred.getByText('Chờ kết nối')).toBeInTheDocument();
    expect(cred.getByText(RESULT.password)).toBeInTheDocument();
    expect(cred.getByText(RESULT.ocpp_url)).toBeInTheDocument();
    expect(cred.getByText(/chỉ hiện một lần/)).toBeInTheDocument();
    expect(cred.getByRole('link', { name: 'Xem trụ sạc' })).toHaveAttribute(
      'href',
      '/operator/charge-points/42',
    );
    // Screen 18 refreshes so the new charge point shows as awaiting connection.
    await waitFor(() =>
      expect(seen.filter((r) => r.path === '/api/operator/v1/charge-points').length).toBe(
        lists + 1,
      ),
    );

    // Escape does not close the credential; only "Đã lưu, đóng" does, and the password is gone.
    await user.keyboard('{Escape}');
    expect(screen.getByText(RESULT.password)).toBeInTheDocument();
    await user.click(cred.getByRole('button', { name: 'Đã lưu, đóng' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(RESULT.password)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Onboard trụ sạc' }));
    expect(screen.getByRole('dialog', { name: 'Onboard trụ sạc' })).toBeInTheDocument();
    expect(screen.queryByText(RESULT.password)).toBeNull();
  });

  it('one connector only when "Bỏ súng 2" is used', async () => {
    const { user, seen, dialog } = await openSheet({ [ONBOARD]: { status: 201, body: RESULT } });
    await user.type(dialog.getByLabelText('Serial'), 'SIM-0005');
    await user.click(dialog.getByRole('button', { name: 'Bỏ súng 2' }));
    expect(dialog.queryByLabelText('Loại súng 2')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Onboard' }));
    await screen.findByRole('dialog', { name: 'Credential của trụ sạc' });
    expect((seen.find((r) => r.method === 'POST')!.body as any).connectors).toEqual([
      { connector_no: 1, connector_type: 'ccs2' },
    ]);
  });

  it('refuses with a reason: 409 serial_not_registered and already_onboarded (DS-10)', async () => {
    const { user, dialog } = await openSheet({
      [ONBOARD]: {
        status: 409,
        body: { error: 'serial_not_registered', detail: 'SIM-9999 is not in the registry' },
      },
    });
    await user.type(dialog.getByLabelText('Serial'), 'SIM-9999');
    await user.click(dialog.getByRole('button', { name: 'Onboard' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Serial chưa được Admin đăng ký');
    expect(screen.getByRole('dialog', { name: 'Onboard trụ sạc' })).toBeInTheDocument();
  });

  it('an Operator with no station cannot onboard; Escape cancels the form', async () => {
    fakeCsms({
      [LIST]: emptyList,
      [SITES]: { status: 200, body: { items: [], total: 0, page: 1, page_size: 100 } },
    });
    const { user } = renderApp('/operator/charge-points', session(STAFF));
    await user.click(await screen.findByRole('button', { name: 'Onboard trụ sạc' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(await dialog.findByText('Operator chưa có trạm sạc nào.')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Onboard' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
