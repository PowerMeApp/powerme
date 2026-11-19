/** Screen 18 map (FE-03c): list / map switch, pins per Charging Station, station panel. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OperatorChargePoint } from '@powerme/shared';
import { afterEach, vi } from 'vitest';
import { groupBySite } from '../src/features/chargePoints/mapModel';
import type { ChargePointMapProps } from '../src/features/chargePoints/ChargePointMap';
import { fakeCsms, renderApp, session, STAFF } from './render';

// jsdom has no WebGL: stand in for the Vietmap GL component with one button per pin.
vi.mock('../src/features/chargePoints/ChargePointMap', () => ({
  default: ({ sites, onSelect, onError }: ChargePointMapProps) => (
    <div data-testid="vietmap">
      {sites.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`map-pin tone-${s.tone}`}
          onClick={() => onSelect(s.id)}
        >
          ghim {s.site_name}
        </button>
      ))}
      <button type="button" onClick={onError}>
        lỗi tile
      </button>
    </div>
  ),
}));

afterEach(() => vi.unstubAllEnvs());

const recent = new Date(Date.now() - 5_000).toISOString();
const SITE_Q1 = {
  id: '1',
  site_code: 'HCM-Q1',
  site_name: 'Trạm Quận 1',
  latitude: 10.7769,
  longitude: 106.7008,
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
  site: SITE_Q1,
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
  ...over,
});
const faulted = cp('2', {
  connectors: [{ ...cp('2').connectors[0]!, status: 'Faulted', error_code: 'GroundFailure' }],
});
const thuDuc = cp('3', {
  site: {
    id: '2',
    site_code: 'HCM-TD',
    site_name: 'Trạm Thủ Đức',
    latitude: 10.87,
    longitude: 106.8,
  },
  connectors: [{ ...cp('3').connectors[0]!, status: 'Charging' }],
});
const noCoords = cp('4', {
  site: {
    id: '3',
    site_code: 'HCM-X',
    site_name: 'Trạm chưa có toạ độ',
    latitude: null,
    longitude: null,
  },
});
const offline = cp('5', {
  site: {
    id: '2',
    site_code: 'HCM-TD',
    site_name: 'Trạm Thủ Đức',
    latitude: 10.87,
    longitude: 106.8,
  },
  is_online: false,
  connectors: [{ ...cp('5').connectors[0]!, status_quality: 'offline' }],
});
const LIST_URL = 'GET /api/operator/v1/charge-points';
const page = (items: OperatorChargePoint[], total = items.length) => ({
  status: 200,
  body: { items, total, page: 1, page_size: 100 },
});

describe('mapModel.groupBySite', () => {
  it('one pin per station with the worst tone; stations without coordinates are counted apart', () => {
    const { sites, unplaced } = groupBySite([cp('1'), faulted, thuDuc, noCoords]);
    expect(unplaced).toBe(1);
    expect(sites.map((s) => [s.site_name, s.tone, s.chargePoints.length])).toEqual([
      ['Trạm Quận 1', 'critical', 2],
      ['Trạm Thủ Đức', 'busy', 1],
    ]);
  });

  it('Offline overrides every status (D20)', () => {
    expect(groupBySite([thuDuc, offline]).sites[0]!.tone).toBe('offline');
    expect(groupBySite([cp('1')]).sites[0]!.tone).toBe('ok');
  });
});

describe('Bản đồ Charge Point (màn 18, FE-03c)', () => {
  it('"Bản đồ" asks for up to 100 with the same filters; without a key the station list still works', async () => {
    const seen = fakeCsms({ [LIST_URL]: page([cp('1'), faulted, thuDuc, noCoords]) });
    const { user } = renderApp('/operator/charge-points', session(STAFF));
    await screen.findByRole('row', { name: 'Charge Point PM-1' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kết nối' }), 'Online');
    await user.click(screen.getByRole('button', { name: 'Bản đồ' }));
    expect(screen.getByRole('button', { name: 'Bản đồ' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(seen.some((r) => r.search === '?online=true&page=1&page_size=100')).toBe(true),
    );
    expect(await screen.findByText(/Chưa cấu hình key bản đồ Vietmap/)).toBeInTheDocument();
    expect(screen.queryByTestId('vietmap')).toBeNull();
    expect(screen.getByText(/1 Charging Station chưa có toạ độ/)).toBeInTheDocument();

    const panel = within(
      screen.getByRole('complementary', { name: 'Charging Station trên bản đồ' }),
    );
    await user.click(panel.getByRole('button', { name: /Trạm Quận 1/ }));
    const chosen = within(
      screen.getByRole('complementary', { name: 'Charging Station Trạm Quận 1' }),
    );
    expect(chosen.getByText(/Có Connector Faulted/)).toBeInTheDocument();
    expect(chosen.getByRole('link', { name: 'PM-2' })).toHaveAttribute(
      'href',
      '/operator/charge-points/2',
    );
    expect(chosen.getByText('Faulted · GroundFailure')).toBeInTheDocument();
    await user.click(chosen.getByRole('button', { name: '‹ Tất cả trạm' }));
    expect(
      screen.getByRole('complementary', { name: 'Charging Station trên bản đồ' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Danh sách' }));
    await screen.findByRole('row', { name: 'Charge Point PM-1' });
  });

  it('with a key: Vietmap pins, a pin opens its station, more than 100 warns, a tile error shows', async () => {
    vi.stubEnv('VITE_VIETMAP_TILE_KEY', 'test-tile-key');
    fakeCsms({ [LIST_URL]: page([cp('1'), thuDuc, offline], 140) });
    const { user } = renderApp('/operator/charge-points?view=map', session(STAFF));
    const map = within(await screen.findByTestId('vietmap'));
    expect(map.getByRole('button', { name: 'ghim Trạm Thủ Đức' })).toHaveClass('tone-offline');
    expect(screen.getByText(/Bản đồ chỉ hiện 3 \/ 140 Charge Point/)).toBeInTheDocument();
    await user.click(map.getByRole('button', { name: 'ghim Trạm Thủ Đức' }));
    const chosen = within(
      screen.getByRole('complementary', { name: 'Charging Station Trạm Thủ Đức' }),
    );
    expect(chosen.getAllByText('Offline').length).toBeGreaterThan(0);
    expect(chosen.getByRole('link', { name: 'PM-3' })).toHaveAttribute(
      'href',
      '/operator/charge-points/3',
    );
    await user.click(map.getByRole('button', { name: 'lỗi tile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không tải được bản đồ Vietmap/);
  });
});
