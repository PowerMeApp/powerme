/** Screen 24 — Pricing & Promotions (FE-06, UC-OPS-06/07) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { Promotion, TariffScheduleView } from '@powerme/shared';
import { ADMIN, currentPath, fakeCsms, renderApp, session, STAFF } from './render';

const TARIFFS = 'GET /api/operator/v1/tariffs';
const PUT = 'PUT /api/operator/v1/tariffs';
const PROMOS = 'GET /api/operator/v1/promotions';
const VIEW: TariffScheduleView = {
  current: {
    effective_from: '2026-01-01',
    effective_to: null,
    periods: [
      { band: 'off_peak', time_start: '00:00', time_end: '06:00', price_per_kwh_vnd: 2800 },
      { band: 'peak', time_start: '06:00', time_end: '20:00', price_per_kwh_vnd: 5500 },
      { band: 'normal', time_start: '20:00', time_end: '24:00', price_per_kwh_vnd: 3800 },
    ],
  },
  upcoming: [],
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
const promo = (id: string, over: Partial<Promotion> = {}): Promotion => ({
  id,
  promotion_code: `CODE${id}`,
  discount_type: 'percent',
  discount_value: 10,
  valid_from: day(-1),
  valid_to: day(10),
  active: true,
  ...over,
});
const PROMO_PAGE = {
  items: [
    promo('1'),
    promo('2', { valid_from: day(3), valid_to: day(5), active: false }),
    promo('3', { valid_from: day(-9), valid_to: day(-2), active: false }),
  ],
  total: 3,
  page: 1,
  page_size: 100,
};
/** The red message linked to an input (aria-describedby), right beneath it. */
const errorUnder = (input: HTMLElement) =>
  document.getElementById(input.getAttribute('aria-describedby') ?? '');

describe('Giá & khuyến mãi (màn 24)', () => {
  it('shows the tariff in force with bands and prices; menu link', async () => {
    fakeCsms({ [TARIFFS]: { status: 200, body: VIEW } });
    renderApp('/operator/pricing', session(STAFF));
    const table = within(await screen.findByRole('region', { name: 'Đang áp dụng' }));
    const peak = within(table.getByRole('row', { name: 'Đang áp dụng 06:00' }));
    expect(peak.getByText('06:00 – 20:00')).toBeInTheDocument();
    expect(peak.getByText('Cao điểm')).toBeInTheDocument();
    expect(peak.getByText(/5\.500 ₫\/kWh/)).toBeInTheDocument();
    expect(table.getByText('20:00 – 24:00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Giá & khuyến mãi' })).toHaveAttribute(
      'href',
      '/operator/pricing',
    );
  });

  it('editor: a gap shows under the row that causes it; then confirm and PUT a sorted schedule', async () => {
    const seen = fakeCsms({
      [TARIFFS]: { status: 200, body: VIEW },
      [PUT]: { status: 200, body: VIEW },
    });
    const { user } = renderApp('/operator/pricing', session(STAFF));
    await user.click(await screen.findByRole('button', { name: 'Lập biểu giá mới' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Lập biểu giá mới' }));
    // Pre-filled from the current schedule.
    expect(dialog.getByLabelText('Giá khung 2 (₫/kWh)')).toHaveValue('5500');
    const start2 = dialog.getByLabelText('Từ (khung 2)');
    await user.clear(start2);
    await user.type(start2, '07:00');
    await user.click(dialog.getByRole('button', { name: 'Tiếp tục' }));
    expect(errorUnder(start2)).toHaveTextContent('Hở giờ: khung trước kết thúc 06:00');
    expect(errorUnder(start2)).toHaveClass('form-error');
    expect(start2).toHaveAttribute('aria-invalid', 'true');
    expect(seen.some((r) => r.method === 'PUT')).toBe(false);
    // Fix it, change a price, and add nothing else.
    await user.clear(start2);
    await user.type(start2, '06:00');
    const price3 = dialog.getByLabelText('Giá khung 3 (₫/kWh)');
    await user.clear(price3);
    await user.type(price3, '4000');
    await user.click(dialog.getByRole('button', { name: 'Tiếp tục' }));
    expect(dialog.getByText(/Phiên đã quyết toán không đổi/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Áp dụng' }));
    expect(await screen.findByText(/Đã lập biểu giá mới, áp dụng từ/)).toHaveClass(
      'queue-note',
      'ok',
    );
    const put = seen.find((r) => r.method === 'PUT')!.body as any;
    expect(put.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(put.periods).toEqual([
      { band: 'off_peak', time_start: '00:00', time_end: '06:00', price_per_kwh_vnd: 2800 },
      { band: 'peak', time_start: '06:00', time_end: '20:00', price_per_kwh_vnd: 5500 },
      { band: 'normal', time_start: '20:00', time_end: '24:00', price_per_kwh_vnd: 4000 },
    ]);
  });

  it('editor: the last period must end at 24:00, and a past date from the server shows under the date', async () => {
    fakeCsms({
      [TARIFFS]: { status: 200, body: VIEW },
      [PUT]: {
        status: 400,
        body: { error: 'effective_from_in_past', detail: 'effective_from_in_past' },
      },
    });
    const { user } = renderApp('/operator/pricing', session(STAFF));
    await user.click(await screen.findByRole('button', { name: 'Lập biểu giá mới' }));
    const dialog = within(screen.getByRole('dialog'));
    const end3 = dialog.getByLabelText('Đến (khung 3)');
    await user.clear(end3);
    await user.type(end3, '23:00');
    await user.click(dialog.getByRole('button', { name: 'Tiếp tục' }));
    expect(errorUnder(end3)).toHaveTextContent('Khung cuối cùng phải kết thúc lúc 24:00');
    await user.clear(end3);
    await user.type(end3, '24:00');
    await user.click(dialog.getByRole('button', { name: 'Tiếp tục' }));
    await user.click(dialog.getByRole('button', { name: 'Áp dụng' }));
    const date = await dialog.findByLabelText('Áp dụng từ ngày');
    await waitFor(() =>
      expect(errorUnder(date)).toHaveTextContent('Ngày áp dụng không được ở quá khứ'),
    );
  });

  it('promotions: status pills, only open ones can be edited or ended; ending asks first', async () => {
    const seen = fakeCsms({
      [PROMOS]: { status: 200, body: PROMO_PAGE },
      'POST /api/operator/v1/promotions/1/deactivate': {
        status: 200,
        body: promo('1', { active: false, valid_to: day(0) }),
      },
    });
    const { user } = renderApp('/operator/pricing?tab=promotions', session(STAFF));
    const running = within(await screen.findByRole('row', { name: 'Khuyến mãi CODE1' }));
    expect(running.getByText('Đang chạy')).toBeInTheDocument();
    expect(running.getByText('10%')).toBeInTheDocument();
    const soon = within(screen.getByRole('row', { name: 'Khuyến mãi CODE2' }));
    expect(soon.getByText('Sắp chạy')).toBeInTheDocument();
    expect(soon.getByRole('button', { name: 'Kết thúc' })).toBeInTheDocument();
    const ended = within(screen.getByRole('row', { name: 'Khuyến mãi CODE3' }));
    expect(ended.getByText('Đã kết thúc')).toBeInTheDocument();
    expect(ended.queryByRole('button')).toBeNull();
    expect(screen.getByText(/chưa được áp dụng khi tính tiền/)).toBeInTheDocument();
    await user.click(running.getByRole('button', { name: 'Kết thúc' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Kết thúc khuyến mãi CODE1' })).getByRole(
        'button',
        { name: 'Kết thúc' },
      ),
    );
    expect(await screen.findByText('Đã kết thúc khuyến mãi CODE1')).toBeInTheDocument();
    expect(seen.some((r) => r.path === '/api/operator/v1/promotions/1/deactivate')).toBe(true);
  });

  it('create promotion: code upper-cased, errors under each field, 409 code taken under the code', async () => {
    const seen = fakeCsms({
      [PROMOS]: { status: 200, body: PROMO_PAGE },
      'POST /api/operator/v1/promotions': {
        status: 409,
        body: { error: 'promotion_code_taken', detail: 'promotion_code_taken' },
      },
    });
    const { user } = renderApp('/operator/pricing?tab=promotions', session(STAFF));
    await user.click(await screen.findByRole('button', { name: 'Tạo khuyến mãi' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Tạo khuyến mãi' }));
    const value = dialog.getByLabelText('Giá trị (%)');
    await user.type(value, '150');
    await user.click(dialog.getByRole('button', { name: 'Tạo' }));
    const code = dialog.getByLabelText('Mã khuyến mãi');
    expect(errorUnder(code)).toHaveTextContent('Mã 3–20 ký tự');
    expect(errorUnder(value)).toHaveTextContent('Phần trăm từ 0 đến 100');
    expect(errorUnder(dialog.getByLabelText('Bắt đầu'))).toHaveTextContent(
      'Chọn thời điểm bắt đầu',
    );
    expect(seen.some((r) => r.method === 'POST')).toBe(false);
    await user.type(code, 'tet2027');
    await user.clear(value);
    await user.type(value, '15');
    await user.type(dialog.getByLabelText('Bắt đầu'), '2027-01-20T08:00');
    await user.type(dialog.getByLabelText('Kết thúc'), '2027-02-10T23:00');
    await user.click(dialog.getByRole('button', { name: 'Tạo' }));
    await waitFor(() => expect(errorUnder(code)).toHaveTextContent('Mã khuyến mãi đã được dùng'));
    const body = seen.find((r) => r.method === 'POST')!.body as any;
    expect(body).toMatchObject({
      promotion_code: 'TET2027',
      discount_type: 'percent',
      discount_value: 15,
    });
    expect(new Date(body.valid_to).getTime()).toBeGreaterThan(new Date(body.valid_from).getTime());
  });

  it('an Admin cannot open the screen', async () => {
    fakeCsms({});
    renderApp('/operator/pricing', session(ADMIN));
    await waitFor(() => expect(currentPath()).not.toBe('/operator/pricing'));
  });
});
