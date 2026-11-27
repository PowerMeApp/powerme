/** Screens 25 / 35 revenue (FE-07) against a fake T108 API; pure helpers of revenueModel. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RevenueReport, RevenueRow } from '@powerme/shared';
import { afterEach, vi } from 'vitest';
import {
  defaultPeriod,
  EMPTY_BUCKET,
  fillDays,
  formatGenerated,
  formatKwh,
  formatVnd,
  periodDays,
  reasonLabel,
} from '../src/features/revenue/revenueModel';
import { ADMIN, fakeCsms, renderApp, session, STAFF } from './render';

afterEach(() => vi.restoreAllMocks());

const OP = 'GET /api/operator/v1/revenue';
const OP_CSV = 'GET /api/operator/v1/revenue.csv';
const AD = 'GET /api/admin/v1/revenue';
/** As the real API returns it (#197): every group field present, null when not in the grouping. */
const row = (over: Partial<RevenueRow>): RevenueRow => ({
  key: '1',
  operator_id: null,
  operator_name: null,
  site_id: null,
  site_name: null,
  charge_point_id: null,
  serial_number: null,
  day: null,
  ...EMPTY_BUCKET,
  ...over,
});
const report = (over: Partial<RevenueReport> = {}): RevenueReport => ({
  from: '2026-11-01',
  to: '2026-11-05',
  group_by: 'charge_point',
  operator_id: '1',
  currency: 'VND',
  rows: [
    row({
      key: '11',
      charge_point_id: '11',
      serial_number: 'RH-1',
      site_id: '5',
      site_name: 'Trạm Q1',
      csms_billed_session_count: 3,
      csms_billed_energy_wh: 45_000,
      csms_billed_revenue_vnd: 1_250_000,
      unattributed_session_count: 1,
      unattributed_energy_wh: 2_000,
    }),
  ],
  totals: {
    csms_billed_session_count: 3,
    csms_billed_energy_wh: 45_000,
    csms_billed_revenue_vnd: 1_250_000,
    unattributed_session_count: 1,
    unattributed_energy_wh: 2_000,
  },
  pending_reconciliation: { session_count: 2 },
  unsettled: { session_count: 3, by_reason: { promotion_unsupported: 2, ineligible: 1 } },
  generated_at: '2026-11-20T02:15:00Z',
  ...over,
});
const ok = (body: unknown) => ({ status: 200, body });
const PERIOD = '?from=2026-11-01&to=2026-11-05';

describe('revenueModel', () => {
  it('fillDays adds a zero row for every day without sessions, in order, keeping real rows', () => {
    const d2 = row({ key: '2026-11-02', day: '2026-11-02', csms_billed_session_count: 4 });
    const d4 = row({ key: '2026-11-04', day: '2026-11-04', csms_billed_session_count: 1 });
    const out = fillDays([d4, d2], '2026-11-01', '2026-11-05');
    expect(out.map((r) => r.day)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(out[1]).toBe(d2);
    expect(out[0]).toMatchObject({ csms_billed_session_count: 0, csms_billed_revenue_vnd: 0 });
  });

  it('periods follow Vietnam time and the 366-day limit', () => {
    // 30/11 23:30 UTC is already 01/12 in Vietnam: a new month.
    expect(defaultPeriod(Date.parse('2026-11-30T17:30:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-01',
    });
    expect(defaultPeriod(Date.parse('2026-11-20T03:00:00Z'))).toEqual({
      from: '2026-11-01',
      to: '2026-11-20',
    });
    expect(periodDays('2026-11-01', '2026-11-05')).toBe(5);
    expect(periodDays('2026-11-05', '2026-11-01')).toBeNull();
    expect(periodDays('2026-01-01', '2026-12-31')).toBe(365);
    expect(periodDays('2025-11-01', '2026-11-02')).toBeNull(); // 367 days
    expect(periodDays('2026-02-30', '2026-03-01')).toBeNull();
  });

  it('formats money, energy, reasons and the generated time', () => {
    expect(formatVnd(1_250_000)).toBe('1.250.000 ₫');
    expect(formatKwh(45_500)).toBe('45,5 kWh');
    expect(reasonLabel('promotion_unsupported')).toBe('Có khuyến mãi (chưa áp vào quyết toán)');
    expect(reasonLabel('ineligible')).toMatch(/T115/);
    expect(reasonLabel('new_code')).toBe('new_code');
    expect(formatGenerated('2026-11-20T02:15:00Z')).toBe('20/11/2026 09:15');
  });
});

describe('Doanh thu (màn 25, Operator)', () => {
  it('default period and grouping; totals, separate unattributed line, notes; nav link', async () => {
    const seen = fakeCsms({ [OP]: ok(report()) });
    renderApp('/operator/revenue', session(STAFF));
    const { from, to } = defaultPeriod();
    await waitFor(() =>
      expect(seen[0]).toMatchObject({
        path: '/api/operator/v1/revenue',
        search: `?from=${from}&to=${to}&group_by=charge_point`,
      }),
    );
    const revenue = within(await screen.findByRole('region', { name: 'Doanh thu' }));
    expect(revenue.getByText('1.250.000 ₫')).toBeInTheDocument();
    const unattributed = within(screen.getByRole('region', { name: 'Phiên không định danh' }));
    expect(unattributed.getByText(/2 kWh · không tính tiền/)).toBeInTheDocument();
    // Nghĩa 20/11: no notes under the totals (pending / unsettled / "tính đến lúc").
    expect(screen.queryByText(/chưa đối soát xong/)).toBeNull();
    expect(screen.queryByText(/chưa trừ tiền/)).toBeNull();
    expect(screen.queryByText(/Tính đến lúc/)).toBeNull();
    // Filters in their own card, above the totals (Nghĩa 20/11).
    const filters = screen.getByRole('region', { name: 'Bộ lọc' });
    expect(
      filters.compareDocumentPosition(screen.getByRole('region', { name: 'Doanh thu' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const r = within(screen.getByRole('row', { name: 'RH-1' }));
    // Names open their own pages: the charge point (screen 20) and its station.
    expect(r.getByRole('link', { name: 'RH-1' })).toHaveAttribute(
      'href',
      '/operator/charge-points/11',
    );
    expect(r.getByRole('link', { name: 'Trạm Q1' })).toHaveAttribute(
      'href',
      '/operator/stations/5',
    );
    expect(r.getByText('45 kWh')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: 'Tổng' })).getByText('1.250.000 ₫'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Doanh thu' })).toHaveAttribute(
      'href',
      '/operator/revenue',
    );
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Tổng quan' })).toHaveAttribute('href', '/operator');
    expect(crumbs.getByText('Doanh thu')).toHaveAttribute('aria-current', 'page');
  });

  it('by day: every day of the period is listed, empty ones as 0', async () => {
    const days = [
      row({ key: '2026-11-02', day: '2026-11-02', csms_billed_session_count: 4 }),
      row({ key: '2026-11-04', day: '2026-11-04', csms_billed_session_count: 1 }),
    ];
    fakeCsms({ [OP]: ok(report({ group_by: 'day', rows: days })) });
    renderApp(`/operator/revenue${PERIOD}&group_by=day`, session(STAFF));
    await screen.findByRole('row', { name: '02/11/2026' });
    for (const d of ['01', '03', '05'])
      expect(screen.getByRole('row', { name: `${d}/11/2026` })).toHaveClass('muted');
    expect(
      within(screen.getByRole('row', { name: '04/11/2026' })).getByText('1'),
    ).toBeInTheDocument();
  });

  it('by station: each station links to its own page (no drill-down on this page)', async () => {
    fakeCsms({
      [OP]: ok(
        report({ group_by: 'site', rows: [row({ key: '5', site_id: '5', site_name: 'Trạm Q1' })] }),
      ),
    });
    renderApp(`/operator/revenue${PERIOD}&group_by=site`, session(STAFF));
    expect(await screen.findByRole('link', { name: 'Trạm Q1' })).toHaveAttribute(
      'href',
      '/operator/stations/5',
    );
    expect(screen.queryByText(/Đang xem:/)).toBeNull();
  });

  it('pages the table 20 rows at a time; the period total stays on every page', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      row({
        key: String(100 + i),
        charge_point_id: String(100 + i),
        serial_number: `RH-${String(i + 1).padStart(2, '0')}`,
        csms_billed_session_count: 1,
      }),
    );
    const { user } = (() => {
      fakeCsms({ [OP]: ok(report({ rows: many })) });
      return renderApp(`/operator/revenue${PERIOD}`, session(STAFF));
    })();
    await screen.findByRole('row', { name: 'RH-01' });
    expect(screen.getByText('Hiển thị 1–20 / 45')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'RH-21' })).toBeNull();
    const total = () => within(screen.getByRole('row', { name: 'Tổng' })).getByText('1.250.000 ₫');
    expect(total()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sau ›' }));
    expect(screen.getByText('Hiển thị 21–40 / 45')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'RH-21' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'RH-01' })).toBeNull();
    expect(total()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sau ›' }));
    expect(screen.getByText('Hiển thị 41–45 / 45')).toBeInTheDocument();
    // Search covers every row of the period, not just the page shown (FE-07).
    const box = () => screen.getByRole('searchbox', { name: 'Tìm trụ sạc' });
    await user.type(box(), 'rh-2');
    expect(screen.getByText(/Hiển thị 1–10 \/ 10/)).toHaveTextContent('(lọc từ 45)');
    expect(screen.getByRole('row', { name: 'RH-29' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'RH-01' })).toBeNull();
    expect(total()).toBeInTheDocument(); // still the period total
    await user.clear(box());
    await user.type(box(), 'không có');
    expect(screen.getByText('Không có dòng nào khớp ô tìm kiếm.')).toBeInTheDocument();
    await user.clear(box());
    // Changing the period (or the grouping) goes back to page 1.
    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-11-02' } });
    await waitFor(() => expect(screen.getByText('Hiển thị 1–20 / 45')).toBeInTheDocument());
  });

  it('station search ignores case and accents and stays in the URL; by charge point, two boxes', async () => {
    const sites = [
      row({ key: '5', site_id: '5', site_name: 'Trạm Q1' }),
      row({ key: '6', site_id: '6', site_name: 'Trạm Thủ Đức' }),
    ];
    fakeCsms({ [OP]: ok(report({ group_by: 'site', rows: sites })) });
    renderApp(`/operator/revenue${PERIOD}&group_by=site&site_search=tram%20q1`, session(STAFF));
    expect(await screen.findByRole('row', { name: 'Trạm Q1' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'Trạm Thủ Đức' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Tìm trạm sạc' })).toHaveValue('tram q1');
    expect(screen.queryByRole('searchbox', { name: 'Tìm trụ sạc' })).toBeNull();
  });

  it('by charge point: a charge point box and a station box, both must match (station by id too)', async () => {
    const cps = [
      row({
        key: '11',
        charge_point_id: '11',
        serial_number: 'RH-1',
        site_id: '5',
        site_name: 'Trạm Q1',
      }),
      row({
        key: '12',
        charge_point_id: '12',
        serial_number: 'RH-2',
        site_id: '6',
        site_name: 'Trạm Thủ Đức',
      }),
    ];
    fakeCsms({ [OP]: ok(report({ rows: cps })) });
    const { user } = renderApp(`/operator/revenue${PERIOD}`, session(STAFF));
    await screen.findByRole('row', { name: 'RH-1' });
    await user.type(screen.getByRole('searchbox', { name: 'Tìm trạm sạc' }), '6');
    expect(screen.getByRole('row', { name: 'RH-2' })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: 'RH-1' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: 'Tìm trụ sạc' }), 'rh-1');
    expect(screen.getByText('Không có dòng nào khớp ô tìm kiếm.')).toBeInTheDocument();
  });

  it('an invalid period is caught before asking; the server’s invalid_period is shown too', async () => {
    const seen = fakeCsms({
      [OP]: { status: 400, body: { error: 'invalid_period', detail: 'x' } },
    });
    renderApp('/operator/revenue?from=2026-11-10&to=2026-11-01', session(STAFF));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kỳ báo cáo không hợp lệ');
    expect(seen.filter((r) => r.path.endsWith('/revenue'))).toEqual([]);
    renderApp(`/operator/revenue${PERIOD}`, session(STAFF));
    await waitFor(() =>
      expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('dài tối đa 366 ngày'),
    );
  });

  it('"Tải CSV" asks revenue.csv with the same query and Bearer token, saves it with a BOM', async () => {
    const seen = fakeCsms({ [OP]: ok(report()), [OP_CSV]: ok('key,csms_billed_revenue_vnd') });
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:revenue';
    });
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { user } = renderApp(`/operator/revenue${PERIOD}`, session(STAFF));
    // The button is disabled until the report has loaded: wait for that, then click.
    const download = await screen.findByRole('button', { name: 'Tải tệp bảng tính (CSV)' });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    await waitFor(() =>
      expect(names).toEqual(['doanh-thu_2026-11-01_2026-11-05_charge_point.csv']),
    );
    const csv = seen.find((r) => r.path.endsWith('revenue.csv'))!;
    expect(csv).toMatchObject({
      search: `${PERIOD}&group_by=charge_point`,
      authorization: `Bearer token-${STAFF.user_id}`,
    });
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blobs[0]!);
    });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:revenue');
  });
});

describe('Giao dịch & doanh thu (màn 35, Admin)', () => {
  it('groups by Operator; names are plain text (Admin has no Operator pages); nav link', async () => {
    const seen = fakeCsms({
      [AD]: ok(
        report({
          group_by: 'operator',
          rows: [row({ key: '3', operator_id: '3', operator_name: 'SaiGon EV' })],
        }),
      ),
    });
    renderApp(`/admin/revenue${PERIOD}`, session(ADMIN));
    const r = within(await screen.findByRole('row', { name: 'SaiGon EV' }));
    expect(r.queryByRole('link')).toBeNull();
    expect(r.queryByRole('button')).toBeNull();
    expect(seen[0]).toMatchObject({
      path: '/api/admin/v1/revenue',
      search: `${PERIOD}&group_by=operator`,
    });
    expect(screen.getByRole('link', { name: 'Giao dịch & doanh thu' })).toHaveAttribute(
      'href',
      '/admin/revenue',
    );
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Tổng quan',
      }),
    ).toHaveAttribute('href', '/admin');
  });
});
