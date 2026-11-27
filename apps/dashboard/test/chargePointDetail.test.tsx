/** Screen 20 — Charge Point Detail (FE-05) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OperatorChargePointDetail, OperatorFault } from '@powerme/shared';
import { fakeCsms, renderApp, session, STAFF } from './render';

const recent = new Date(Date.now() - 20_000).toISOString();
const fault: OperatorFault = {
  id: '7',
  event_no: 1007,
  kind: 'faulted',
  charge_point_id: '5',
  charge_point_serial: 'RH24D1-00001',
  station_name: 'Trạm sạc demo Quận 1',
  connector_no: 1,
  error_code: 'GroundFailure',
  severity: 'critical',
  hint: 'Lỗi chạm đất',
  status: 'raised',
  raised_at: recent,
  acknowledged_at: null,
  resolved_at: null,
  reset: null,
  charge_point_online: true,
  report_count: 0,
  allowed_actions: ['acknowledge'],
};
const DETAIL: OperatorChargePointDetail = {
  id: '5',
  serial_number: 'RH24D1-00001',
  display_code: 'PM-D1-HCM-0001',
  model: 'D1-120',
  lifecycle: 'in_service',
  connected: true,
  is_online: true,
  last_message_at: recent,
  site: {
    id: '1',
    site_code: 'HCM-DEMO-01',
    site_name: 'Trạm sạc demo Quận 1',
    latitude: 10.776889,
    longitude: 106.700806,
  },
  connectors: [
    {
      connector_id: '11',
      connector_no: 1,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Faulted',
      status_updated_at: recent,
      status_quality: 'fresh',
      error_code: 'GroundFailure',
      active_session_id: null,
    },
    {
      connector_id: '12',
      connector_no: 2,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Charging',
      status_updated_at: recent,
      status_quality: 'fresh',
      error_code: null,
      active_session_id: '88',
    },
  ],
  firmware_version: '1.4.2',
  rated_power_kw: 120,
  reports_soc: true,
  supports_reservation: false,
  offline_card_risk: false,
  offline_card_risk_reason: null,
  offline_auth_check: {
    checked_at: recent,
    epoch: 3,
    config_values: {},
    change_results: { LocalAuthorizeOffline: 'Accepted' },
    supported_feature_profiles: 'Core',
    fallback_profile_status: null,
  },
  open_faults: [fault],
  recent_commands: [
    {
      id: '3',
      charge_point_id: '5',
      action: 'Reset',
      connector_no: null,
      status: 'rejected',
      requested_at: recent,
      sent_at: recent,
      responded_at: recent,
      error: 'Rejected',
    },
  ],
};
const DETAIL_URL = 'GET /api/operator/v1/charge-points/5';
const FAULTS_URL = 'GET /api/operator/v1/faults';
const faults = { status: 200, body: { items: [fault], total: 1, page: 1, page_size: 20 } };

describe('Chi tiết trụ sạc (màn 20)', () => {
  it('shows header, capabilities, connectors, its fault history and recent commands', async () => {
    const seen = fakeCsms({ [DETAIL_URL]: { status: 200, body: DETAIL }, [FAULTS_URL]: faults });
    renderApp('/operator/charge-points/5', session(STAFF));
    expect(await screen.findByRole('heading', { name: 'PM-D1-HCM-0001' })).toBeInTheDocument();
    // FE-07: the station is a link to its own page; breadcrumb Tổng quan › Trụ sạc › trạm › trụ.
    const head = within(document.querySelector('.page-head') as HTMLElement);
    expect(head.getByRole('link', { name: 'Trạm sạc demo Quận 1' })).toHaveAttribute(
      'href',
      '/operator/stations/1',
    );
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/operator',
      '/operator/charge-points',
      '/operator/stations/1',
    ]);
    expect(crumbs.getByText('PM-D1-HCM-0001')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Đang hoạt động')).toBeInTheDocument();
    const info = within(screen.getByRole('region', { name: 'Thông tin trụ sạc' }));
    expect(info.getByText('1.4.2')).toBeInTheDocument();
    expect(info.getByText('120 kW')).toBeInTheDocument();
    const c1 = within(screen.getByRole('region', { name: 'Súng 1' }));
    expect(c1.getByText('Lỗi · GroundFailure')).toBeInTheDocument();
    const c2 = within(screen.getByRole('region', { name: 'Súng 2' }));
    expect(c2.getByText('Đang sạc')).toBeInTheDocument();
    expect(c2.getByText(/Đang có phiên 88/)).toBeInTheDocument();
    // Fault history: the screen 21 table filtered to this charge point, all statuses.
    expect(await screen.findByRole('row', { name: 'Sự cố #1007' })).toBeInTheDocument();
    expect(seen.find((r) => r.path === '/api/operator/v1/faults')?.search).toBe(
      '?status=all&page=1&page_size=20&charge_point_id=5',
    );
    const cmds = within(screen.getByRole('table', { name: 'Lệnh gần đây' }));
    expect(cmds.getByText('Reset')).toBeInTheDocument();
    expect(cmds.getByText('Cả trụ')).toBeInTheDocument();
    expect(cmds.getByText('Trụ từ chối')).toBeInTheDocument();
  });

  it('[TC-BRP52-05] T150: explains the offline card risk, or says it was switched off', async () => {
    fakeCsms({
      [DETAIL_URL]: {
        status: 200,
        body: {
          ...DETAIL,
          offline_card_risk: true,
          offline_card_risk_reason: 'not_supported',
          offline_auth_check: {
            ...DETAIL.offline_auth_check!,
            change_results: { AllowOfflineTxForUnknownId: 'NotSupported' },
          },
        },
      },
      [FAULTS_URL]: faults,
    });
    renderApp('/operator/charge-points/5', session(STAFF));
    const note = await screen.findByRole('note', { name: 'Rủi ro thẻ khi mất kết nối' });
    expect(note).toHaveTextContent(/không cho đổi cấu hình thẻ khi mất kết nối/);
    expect(note).toHaveTextContent(/thẻ lạ hoặc thẻ đã khoá/);
    expect(note).toHaveTextContent(/Lần kiểm cuối/);
  });

  it('T150: a confirmed check shows one muted line and no warning', async () => {
    fakeCsms({ [DETAIL_URL]: { status: 200, body: DETAIL }, [FAULTS_URL]: faults });
    renderApp('/operator/charge-points/5', session(STAFF));
    expect(
      await screen.findByText(/Đã tắt chấp nhận thẻ khi mất kết nối trên trụ/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Rủi ro thẻ khi mất kết nối' })).toBeNull();
  });

  it('acknowledges a fault from the detail page', async () => {
    const seen = fakeCsms({
      [DETAIL_URL]: { status: 200, body: DETAIL },
      [FAULTS_URL]: faults,
      'POST /api/operator/v1/faults/7/acknowledge': {
        status: 200,
        body: { id: '7', status: 'acknowledged' },
      },
    });
    const { user } = renderApp('/operator/charge-points/5', session(STAFF));
    const row = within(await screen.findByRole('row', { name: 'Sự cố #1007' }));
    await user.click(row.getByRole('button', { name: 'Xác nhận' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Xác nhận' }));
    await waitFor(() =>
      expect(seen.some((r) => r.path === '/api/operator/v1/faults/7/acknowledge')).toBe(true),
    );
  });

  it('an unknown or other Operator’s charge point shows not found with a way back', async () => {
    fakeCsms({
      'GET /api/operator/v1/charge-points/99': {
        status: 404,
        body: { error: 'not_found', detail: 'not_found' },
      },
    });
    renderApp('/operator/charge-points/99', session(STAFF));
    expect(await screen.findByText('Không tìm thấy trụ sạc')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Danh sách trụ sạc' })).toHaveAttribute(
      'href',
      '/operator/charge-points',
    );
  });

  it('screen 18 links each charge point to its detail', async () => {
    fakeCsms({
      'GET /api/operator/v1/charge-points': {
        status: 200,
        body: { items: [DETAIL], total: 1, page: 1, page_size: 20 },
      },
    });
    renderApp('/operator/charge-points', session(STAFF));
    expect(await screen.findByRole('link', { name: 'PM-D1-HCM-0001' })).toHaveAttribute(
      'href',
      '/operator/charge-points/5',
    );
  });
});

it('WP3 shows persistent RFID stop reason and held amount beyond recent commands', async () => {
  const { RFID_PROTECTION } = await import('./rfidProtectionFixture');
  fakeCsms({
    [DETAIL_URL]: {
      status: 200,
      body: { ...DETAIL, recent_commands: [], rfid_credit_protection: RFID_PROTECTION },
    },
    [FAULTS_URL]: faults,
  });
  renderApp('/operator/charge-points/5', session(STAFF));
  const region = within(await screen.findByRole('region', { name: 'Bảo vệ credit RFID' }));
  expect(region.getByText('Đã hết lượt tự động dừng')).toBeInTheDocument();
  expect(region.getByText('Chạm ngưỡng credit')).toBeInTheDocument();
  expect(region.getByText('200.000 ₫')).toBeInTheDocument();
  expect(region.getByText('881')).toBeInTheDocument();
});
