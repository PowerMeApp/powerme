/** Station page (FE-07): its charge points with live status, links to screen 20, its revenue. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OperatorChargePoint, RevenueReport } from '@powerme/shared';
import { fakeCsms, renderApp, session, STAFF } from './render';

const CPS = 'GET /api/operator/v1/charge-points';
const REV = 'GET /api/operator/v1/revenue';
const recent = new Date(Date.now() - 20_000).toISOString();
const site = {
  id: '5',
  site_code: 'HCM-Q1',
  site_name: 'Trạm Q1',
  latitude: 10.7,
  longitude: 106.7,
};
const cp = (id: string, over: Partial<OperatorChargePoint> = {}): OperatorChargePoint => ({
  id,
  serial_number: `RH-${id}`,
  display_code: `PM-${id}`,
  model: 'D1-120',
  lifecycle: 'in_service',
  connected: true,
  is_online: true,
  last_message_at: recent,
  site,
  connectors: [
    {
      connector_id: `${id}1`,
      connector_no: 1,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Charging',
      status_updated_at: recent,
      status_quality: 'fresh',
      error_code: null,
      active_session_id: '77',
    },
    {
      connector_id: `${id}2`,
      connector_no: 2,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Faulted',
      status_updated_at: recent,
      status_quality: 'fresh',
      error_code: 'GroundFailure',
      active_session_id: null,
    },
  ],
  offline_card_risk: false,
  offline_card_risk_reason: null,
  ...over,
});
const page = (items: OperatorChargePoint[]) => ({
  status: 200,
  body: { items, total: items.length, page: 1, page_size: 100 },
});
const revenue: RevenueReport = {
  from: '2026-11-01',
  to: '2026-11-05',
  group_by: 'charge_point',
  operator_id: '1',
  currency: 'VND',
  rows: [],
  totals: {
    csms_billed_session_count: 2,
    csms_billed_energy_wh: 20_000,
    csms_billed_revenue_vnd: 90_000,
    unattributed_session_count: 0,
    unattributed_energy_wh: 0,
  },
  pending_reconciliation: { session_count: 0 },
  unsettled: { session_count: 0, by_reason: {} },
  generated_at: '2026-11-20T02:15:00Z',
};

describe('Trang trạm sạc', () => {
  it('lists the station’s charge points with status, links to screen 20, breadcrumb and revenue', async () => {
    const seen = fakeCsms({
      [CPS]: page([
        cp('11'),
        cp('12', {
          is_online: false,
          last_message_at: null,
          connectors: [
            { ...cp('12').connectors[0]!, status_quality: 'offline', active_session_id: null },
          ],
        }),
      ]),
      [REV]: { status: 200, body: revenue },
    });
    renderApp('/operator/stations/5?from=2026-11-01&to=2026-11-05', session(STAFF));
    expect(await screen.findByRole('heading', { level: 1, name: 'Trạm Q1' })).toBeInTheDocument();
    expect(screen.getByText(/1\/2 trụ sạc đang kết nối/)).toBeInTheDocument();
    const list = within(screen.getByRole('region', { name: 'Trụ sạc của trạm' }));
    const first = within(list.getByRole('row', { name: 'Trụ sạc PM-11' }));
    expect(first.getByRole('link', { name: 'PM-11' })).toHaveAttribute(
      'href',
      '/operator/charge-points/11',
    );
    expect(first.getByText('Đang sạc')).toBeInTheDocument();
    expect(first.getByText('Lỗi · GroundFailure')).toBeInTheDocument();
    expect(first.getByText(/phiên 77/)).toBeInTheDocument();
    expect(first.getAllByText(/Súng \d/)).toHaveLength(2);
    const second = within(list.getByRole('row', { name: 'Trụ sạc PM-12' }));
    expect(second.getAllByText('Mất kết nối').length).toBeGreaterThan(0);
    expect(second.getByText('chưa từng kết nối')).toBeInTheDocument();
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Trụ sạc' })).toHaveAttribute(
      'href',
      '/operator/charge-points',
    );
    expect(crumbs.getByText('Trạm Q1')).toHaveAttribute('aria-current', 'page');
    expect(seen.find((r) => r.path === '/api/operator/v1/charge-points')).toMatchObject({
      search: '?site_id=5&page=1&page_size=100',
    });
    await waitFor(() =>
      expect(seen.find((r) => r.path === '/api/operator/v1/revenue')).toMatchObject({
        search: '?from=2026-11-01&to=2026-11-05&group_by=charge_point&site_id=5',
      }),
    );
    const rev = within(screen.getByRole('region', { name: 'Doanh thu của trạm' }));
    expect(await rev.findByText('90.000 ₫', { selector: '.tile-number' })).toBeInTheDocument();
    // The station report cannot be grouped by station.
    expect(
      within(rev.getByRole('combobox', { name: 'Nhóm theo' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Trụ sạc', 'Ngày']);
  });

  it('no search above the charge point list; the revenue filters have only the charge point box', async () => {
    fakeCsms({ [CPS]: page([cp('11')]), [REV]: { status: 200, body: revenue } });
    renderApp('/operator/stations/5', session(STAFF));
    const list = within(await screen.findByRole('region', { name: 'Trụ sạc của trạm' }));
    expect(list.queryByRole('searchbox')).toBeNull();
    const rev = within(screen.getByRole('region', { name: 'Doanh thu của trạm' }));
    const filters = within(rev.getByRole('region', { name: 'Bộ lọc' }));
    expect(filters.getByRole('searchbox', { name: 'Tìm trụ sạc' })).toBeInTheDocument();
    expect(filters.queryByRole('searchbox', { name: 'Tìm trạm sạc' })).toBeNull();
  });

  it('a station of another Operator (empty list) is not found', async () => {
    fakeCsms({ [CPS]: page([]) });
    renderApp('/operator/stations/99', session(STAFF));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Không tìm thấy trạm sạc này trong các trạm của đơn vị vận hành',
    );
    expect(screen.getByRole('link', { name: '← Danh sách trụ sạc' })).toHaveAttribute(
      'href',
      '/operator/charge-points',
    );
  });
});
