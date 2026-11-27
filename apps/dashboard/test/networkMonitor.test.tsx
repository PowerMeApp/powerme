/** Screen 31 — Charge Point Network Monitor (FE-18, UC-ADM-07) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { NetworkChargePoint, PlatformOperatorPage } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/admin/v1/network/charge-points';
const OPERATORS = 'GET /api/admin/v1/operators';
const recent = new Date(Date.now() - 12_000).toISOString();
const cp = (id: string, over: Partial<NetworkChargePoint> = {}): NetworkChargePoint => ({
  id,
  serial_number: `RH24D1-0000${id}`,
  display_code: `PM-D1-HCM-000${id}`,
  model: 'D1-120',
  lifecycle: 'in_service',
  connected: true,
  is_online: true,
  last_message_at: recent,
  site: { id: '1', site_code: 'HCM-Q1', site_name: 'Trạm Quận 1' },
  connectors: [
    {
      connector_id: `${id}1`,
      connector_no: 1,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Available',
      status_updated_at: recent,
      status_quality: 'fresh',
      error_code: null,
      active_session_id: null,
    },
  ],
  operator: { id: '1', legal_name: 'An Phát EV' },
  open_faults: { total: 0, top_severity: null },
  offline_card_risk: false,
  offline_card_risk_reason: null,
  ...over,
});
const page = (items: NetworkChargePoint[]) => ({
  status: 200,
  body: { items, total: items.length, page: 1, page_size: 20 },
});
const OPS: PlatformOperatorPage = {
  items: [
    { id: '1', tax_code: '0400000181', legal_name: 'An Phát EV', status: 'active' },
    { id: '2', tax_code: '0400000182', legal_name: 'Bình Minh Charging', status: 'active' },
  ],
  total: 2,
  page: 1,
  page_size: 100,
};
const ROWS = [
  cp('1', { open_faults: { total: 2, top_severity: 'critical' } }),
  cp('2', {
    operator: { id: '2', legal_name: 'Bình Minh Charging' },
    site: { id: '9', site_code: 'HN-01', site_name: 'Trạm Hà Nội' },
    is_online: false,
  }),
];

describe('Giám sát mạng lưới (màn 31)', () => {
  it("lists every Operator's charge points with Operator, station, connectors and open faults", async () => {
    const seen = fakeCsms({ [LIST]: page(ROWS), [OPERATORS]: { status: 200, body: OPS } });
    renderApp('/admin/network', session(ADMIN));
    const a = within(await screen.findByRole('row', { name: 'Trụ sạc PM-D1-HCM-0001' }));
    expect(a.getByText('An Phát EV')).toBeInTheDocument();
    expect(a.getByText('HCM-Q1 · Trạm Quận 1')).toBeInTheDocument();
    expect(a.getByText('Đang kết nối')).toBeInTheDocument();
    expect(a.getByText('Nghiêm trọng')).toHaveClass('pill', 'critical');
    expect(a.getByLabelText('2 sự cố đang mở')).toBeInTheDocument();
    const b = within(screen.getByRole('row', { name: 'Trụ sạc PM-D1-HCM-0002' }));
    expect(b.getByText('Bình Minh Charging')).toBeInTheDocument();
    expect(b.getByText('Mất kết nối')).toBeInTheDocument();
    expect(b.getByText('—')).toBeInTheDocument();
    // Read-only: no links into the Operator-only screens.
    expect(a.queryByRole('link')).toBeNull();
    expect(seen.find((r) => r.path === '/api/admin/v1/network/charge-points')!.search).toBe(
      '?page=1&page_size=20',
    );
    expect(screen.getByRole('link', { name: 'Giám sát mạng lưới' })).toHaveAttribute(
      'href',
      '/admin/network',
    );
  });

  it('filters by Operator, connection and lifecycle', async () => {
    const seen = fakeCsms({ [LIST]: page(ROWS), [OPERATORS]: { status: 200, body: OPS } });
    const { user } = renderApp('/admin/network', session(ADMIN));
    await screen.findByRole('row', { name: 'Trụ sạc PM-D1-HCM-0001' });
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Đơn vị vận hành' }),
      await screen.findByRole('option', { name: 'Bình Minh Charging' }),
    );
    await user.selectOptions(screen.getByLabelText('Kết nối'), 'offline');
    await user.selectOptions(screen.getByLabelText('Vòng đời'), 'in_service');
    await waitFor(() =>
      expect(
        seen.filter((r) => r.path === '/api/admin/v1/network/charge-points').at(-1)!.search,
      ).toBe('?operator_id=2&lifecycle=in_service&online=false&page=1&page_size=20'),
    );
  });

  it('shows an empty state', async () => {
    fakeCsms({ [LIST]: page([]), [OPERATORS]: { status: 200, body: OPS } });
    renderApp('/admin/network', session(ADMIN));
    expect(await screen.findByText('Chưa có trụ sạc nào trên nền tảng.')).toBeInTheDocument();
  });

  it('operator staff cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/admin/network', session(STAFF));
    await waitFor(() => expect(currentPath()).not.toBe('/admin/network'));
  });
});
