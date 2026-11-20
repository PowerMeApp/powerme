/** Screens 17 and 18 (FE-03, UC-OPS-02) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OperatorChargePoint, OperatorSummary } from '@powerme/shared';
import { ago } from '../src/features/chargePoints/format';
import { fakeCsms, renderApp, session, STAFF } from './render';

const SUMMARY: OperatorSummary = {
  charge_points: { total: 3, online: 2, offline: 1, by_lifecycle: { in_service: 3 } },
  connectors: { available: 2, in_use: 1, freeing_soon: 0, unavailable: 1, offline: 2 },
  open_faults: { total: 2, critical: 1, major: 1, minor: 0, none: 0 },
  sessions_to_review: 1,
  unattributed_sessions: 0,
  uncertain_starts: 0,
};
const recent = new Date(Date.now() - 12_000).toISOString();
const cp = (over: Partial<OperatorChargePoint> = {}): OperatorChargePoint => ({
  id: '1',
  serial_number: 'RH24D1-00001',
  display_code: 'PM-D1-HCM-0001',
  model: 'D1-120',
  lifecycle: 'in_service',
  connected: true,
  is_online: true,
  last_message_at: recent,
  site: { id: '1', site_code: 'HCM-DEMO-01', site_name: 'Trạm sạc demo Quận 1' },
  connectors: [
    {
      connector_id: '11',
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
      connector_id: '12',
      connector_no: 2,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Faulted',
      status_updated_at: recent,
      status_quality: 'stale',
      error_code: 'GroundFailure',
      active_session_id: null,
    },
  ],
  ...over,
});
const offline = cp({
  id: '2',
  serial_number: 'RH24D1-00002',
  display_code: null,
  is_online: false,
  connected: false,
  last_message_at: null,
  connectors: [
    {
      ...cp().connectors[0]!,
      connector_id: '21',
      status: 'Available',
      status_quality: 'offline',
      active_session_id: null,
    },
  ],
});
const SUMMARY_URL = 'GET /api/operator/v1/summary';
const LIST_URL = 'GET /api/operator/v1/charge-points';
const page = (items: OperatorChargePoint[], total = items.length, p = 1) => ({
  status: 200,
  body: { items, total, page: p, page_size: 20 },
});

describe('Tổng quan vận hành (màn 17)', () => {
  it('shows tiles from the summary, only groups that have data, with links', async () => {
    fakeCsms({
      'GET /api/operator/v1/me': { status: 200, body: STAFF },
      [SUMMARY_URL]: { status: 200, body: SUMMARY },
    });
    renderApp('/operator', session(STAFF));
    const cps = await screen.findByRole('region', { name: 'Trụ sạc' });
    expect(within(cps).getByText('2')).toBeInTheDocument();
    expect(within(cps).getByText('/ 3 online')).toBeInTheDocument();
    expect(within(cps).getByText('1 offline')).toBeInTheDocument();
    const conns = screen.getByRole('region', { name: 'Súng sạc' });
    expect(within(conns).getByText('Sẵn sàng')).toBeInTheDocument();
    expect(within(conns).queryByText('Sắp trống')).toBeNull(); // 0 → hidden (D36)
    const faults = screen.getByRole('region', { name: 'Cảnh báo sự cố' });
    expect(within(faults).getByText('2 đang mở')).toBeInTheDocument();
    expect(within(faults).getByText('Nghiêm trọng')).toBeInTheDocument();
    expect(within(faults).getByRole('link', { name: 'Xem chi tiết →' })).toHaveAttribute(
      'href',
      '/operator/faults',
    );
    const queue = screen.getByRole('region', { name: 'Việc cần xử lý' });
    expect(within(queue).getByRole('link', { name: /phiên cần xem lại/ })).toHaveAttribute(
      'href',
      '/operator/sessions?queue=review',
    );
    expect(within(queue).queryByText(/chưa gắn tài xế/)).toBeNull();
  });

  it('an Operator without charge points sees that, and no connector tile', async () => {
    fakeCsms({
      'GET /api/operator/v1/me': { status: 200, body: STAFF },
      [SUMMARY_URL]: {
        status: 200,
        body: {
          ...SUMMARY,
          charge_points: { total: 0, online: 0, offline: 0, by_lifecycle: {} },
          open_faults: { total: 0, critical: 0, major: 0, minor: 0, none: 0 },
          sessions_to_review: 0,
        },
      },
    });
    renderApp('/operator', session(STAFF));
    expect(await screen.findByText('Operator chưa có trụ sạc nào.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Súng sạc' })).toBeNull();
    expect(screen.getByText('Không có sự cố đang mở.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Việc cần xử lý' })).toBeNull();
  });
});

describe('Danh sách trụ sạc (màn 18)', () => {
  it('lists raw connector statuses, error code, stale mark, session and Offline override; nav link', async () => {
    const seen = fakeCsms({ [LIST_URL]: page([cp(), offline]) });
    renderApp('/operator/charge-points', session(STAFF));
    const row = within(await screen.findByRole('row', { name: 'Trụ sạc PM-D1-HCM-0001' }));
    expect(row.getByText('Trạm sạc demo Quận 1')).toBeInTheDocument();
    expect(row.getByText('Online')).toBeInTheDocument();
    expect(row.getByText('Charging')).toBeInTheDocument();
    expect(row.getByText('Faulted · GroundFailure')).toBeInTheDocument();
    expect(row.getByText(/có thể đã cũ/)).toBeInTheDocument();
    expect(row.getByText(/phiên 77/)).toBeInTheDocument();
    const off = within(screen.getByRole('row', { name: 'Trụ sạc RH24D1-00002' }));
    expect(off.getAllByText('Offline')).toHaveLength(2); // the charge point and its connector
    expect(off.queryByText('Available')).toBeNull();
    expect(off.getByText('chưa từng kết nối')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Trụ sạc' })).toHaveAttribute(
      'href',
      '/operator/charge-points',
    );
    // FE-07: breadcrumb, and the station name opens the station page.
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Tổng quan' })).toHaveAttribute('href', '/operator');
    expect(crumbs.getByText('Trụ sạc')).toHaveAttribute('aria-current', 'page');
    expect(row.getByRole('link', { name: 'Trạm sạc demo Quận 1' })).toHaveAttribute(
      'href',
      '/operator/stations/1',
    );
    expect(seen[0]).toMatchObject({ search: '?page=1&page_size=20' });
  });

  it('filters send online / lifecycle from page 1; the pager asks for page 2', async () => {
    const seen = fakeCsms({ [LIST_URL]: page([cp()], 25) });
    const { user } = renderApp('/operator/charge-points', session(STAFF));
    await screen.findByRole('row', { name: 'Trụ sạc PM-D1-HCM-0001' });
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sau ›' }));
    await waitFor(() => expect(seen.some((r) => r.search === '?page=2&page_size=20')).toBe(true));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kết nối' }), 'Offline');
    await waitFor(() =>
      expect(seen.some((r) => r.search === '?online=false&page=1&page_size=20')).toBe(true),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Vòng đời' }), 'Đã gỡ');
    await waitFor(() =>
      expect(
        seen.some((r) => r.search === '?lifecycle=decommissioned&online=false&page=1&page_size=20'),
      ).toBe(true),
    );
  });

  it('separate charge point and station searches go to the API (debounced) from page 1 (FE-07)', async () => {
    const seen = fakeCsms({ [LIST_URL]: page([]) });
    const { user } = renderApp('/operator/charge-points', session(STAFF));
    await screen.findByText('Không có trụ sạc nào khớp bộ lọc.');
    await user.type(screen.getByRole('searchbox', { name: 'Tìm trạm sạc' }), 'Trạm Q1');
    await waitFor(() =>
      expect(seen.some((r) => r.search === '?site_q=Tr%E1%BA%A1m+Q1&page=1&page_size=20')).toBe(
        true,
      ),
    );
    // One request for the whole word, not one per key.
    expect(seen.filter((r) => r.search.includes('site_q=')).length).toBe(1);
    await user.type(screen.getByRole('searchbox', { name: 'Tìm trụ sạc' }), '0001');
    await waitFor(() =>
      expect(
        seen.some(
          (r) => r.search === '?charge_point_q=0001&site_q=Tr%E1%BA%A1m+Q1&page=1&page_size=20',
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText('Không có trụ sạc nào khớp ô tìm kiếm và bộ lọc.'),
    ).toBeInTheDocument();
  });

  it('empty result shows the empty state', async () => {
    fakeCsms({ [LIST_URL]: page([]) });
    renderApp('/operator/charge-points', session(STAFF));
    expect(await screen.findByText('Không có trụ sạc nào khớp bộ lọc.')).toBeInTheDocument();
  });

  it('"last seen" reads seconds, minutes, hours, days', () => {
    const now = Date.parse('2026-11-17T10:00:00Z');
    expect(ago('2026-11-17T09:59:48Z', now)).toBe('12 s trước');
    expect(ago('2026-11-17T09:55:00Z', now)).toBe('5 phút trước');
    expect(ago('2026-11-17T07:00:00Z', now)).toBe('3 giờ trước');
    expect(ago('2026-11-15T10:00:00Z', now)).toBe('2 ngày trước');
    expect(ago(null, now)).toBe('chưa từng kết nối');
  });
});
