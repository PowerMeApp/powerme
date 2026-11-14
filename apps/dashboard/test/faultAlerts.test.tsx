/** Screen 21 — Fault Alerts (FE-04b, D38–D42) against a fake CSMS. */
import { screen, waitFor, within } from '@testing-library/react';
import type { OperatorFault } from '@powerme/shared';
import { fakeCsms, renderApp, session, STAFF } from './render';

const base: OperatorFault = {
  id: '7',
  event_no: 1007,
  kind: 'faulted',
  charge_point_serial: 'RH24D1-00001',
  station_name: 'Tram sac demo Quan 1',
  connector_no: 1,
  error_code: 'GroundFailure',
  severity: 'critical',
  hint: 'Lỗi chạm đất: KHÔNG Reset từ xa nhiều lần.',
  status: 'acknowledged',
  raised_at: '2026-11-13T02:00:00Z',
  acknowledged_at: '2026-11-13T02:01:00Z',
  resolved_at: null,
  reset: null,
  charge_point_online: true,
  report_count: 0,
  allowed_actions: ['reset', 'close'],
};
const offline: OperatorFault = {
  ...base,
  id: '8',
  event_no: 1008,
  kind: 'offline',
  connector_no: 0,
  error_code: 'Offline',
  severity: 'major',
  status: 'raised',
  charge_point_online: false,
  allowed_actions: ['acknowledge'],
};
const report: OperatorFault = {
  ...base,
  report_count: 2,
  id: '9',
  event_no: 1009,
  kind: 'driver_report',
  connector_no: 2,
  error_code: null,
  severity: 'minor',
  status: 'raised',
  allowed_actions: ['acknowledge'],
};
const LIST = 'GET /api/operator/v1/faults';
const RESET = 'POST /api/operator/v1/faults/7/reset';
const list = (...faults: OperatorFault[]) => ({
  status: 200,
  body: { items: faults, total: faults.length, page: 1, page_size: 20 },
});
/** Fake list endpoint that answers whatever page was asked (`total` read on every call). */
function pagedCsms(items: OperatorFault[], total: () => number) {
  const seen = fakeCsms({});
  const record = globalThis.fetch as unknown as (r: Request) => Promise<Response>;
  globalThis.fetch = (async (r: Request) => {
    await record(r);
    const page = Number(new URL(r.url).searchParams.get('page') ?? 1);
    return new Response(JSON.stringify({ items, total: total(), page, page_size: 20 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}
const open = () => renderApp('/operator/faults', session(STAFF));
const alert = (no: number) => screen.findByRole('row', { name: `Sự cố #${no}` });

describe('Cảnh báo sự cố (màn 21)', () => {
  it('lists the three kinds with labels; buttons only from allowed_actions; nav link', async () => {
    const seen = fakeCsms({ [LIST]: list(base, offline, report) });
    open();
    expect(await screen.findByText('Faulted · GroundFailure · Connector 1')).toBeInTheDocument();
    expect(screen.getByText('Offline · toàn Charge Point')).toBeInTheDocument();
    expect(screen.getByText('Driver report · Connector 2')).toBeInTheDocument();
    expect(screen.getByText('2 tài xế báo lỗi')).toBeInTheDocument();
    const a = within(await alert(1007));
    expect(a.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(a.getByRole('button', { name: 'Đóng' })).toBeInTheDocument();
    expect(a.queryByRole('button', { name: 'Xác nhận' })).toBeNull();
    const o = within(await alert(1008));
    expect(o.getByRole('button', { name: 'Xác nhận' })).toBeInTheDocument();
    expect(o.getByText('Charge Point offline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cảnh báo sự cố' })).toBeInTheDocument();
    expect(seen[0]).toMatchObject({
      search: '?status=open&page=1&page_size=20',
      authorization: 'Bearer token-10',
    });
  });

  it('status filters refetch from page 1; empty states', async () => {
    const seen = fakeCsms({ [LIST]: list() });
    const { user } = open();
    expect(await screen.findByText(/Không có cảnh báo/)).toBeInTheDocument();
    for (const [label, status] of [
      ['Đang reset', 'resetting'],
      ['Đã xử lý', 'resolved'],
      ['Tất cả', 'all'],
    ] as const) {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Trạng thái' }), label);
      await waitFor(() =>
        expect(seen.some((r) => r.search === `?status=${status}&page=1&page_size=20`)).toBe(true),
      );
    }
    expect(screen.getByRole('combobox', { name: 'Trạng thái' })).toHaveValue('all');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Đang mở',
      'Mới',
      'Đã xác nhận',
      'Đang reset',
      'Đã xử lý',
      'Tất cả',
    ]);
    expect(await screen.findByText('Không có sự cố ở trạng thái này.')).toBeInTheDocument();
  });

  it('table with pager: range, next page sends page=2, ends disabled', async () => {
    const seen = pagedCsms([base, offline], () => 22);
    const { user } = open();
    expect(await screen.findByRole('columnheader', { name: 'Trạng thái' })).toBeInTheDocument();
    expect(screen.getByText('Hiển thị 1–2 / 22')).toBeInTheDocument();
    expect(screen.getByText('Trang 1 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '‹ Trước' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Sau ›' }));
    await waitFor(() =>
      expect(seen.some((r) => r.search === '?status=open&page=2&page_size=20')).toBe(true),
    );
    expect(await screen.findByText('Trang 2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sau ›' })).toBeDisabled();
    expect(await screen.findByText('Hiển thị 21–22 / 22')).toBeInTheDocument();
  });

  it('a page past the end (rows left the filter) falls back to the last page', async () => {
    let total = 22;
    const seen = pagedCsms([base], () => total);
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Sau ›' }));
    expect(await screen.findByText('Trang 2 / 2')).toBeInTheDocument();
    // Closing the last row of page 2 refetches; the list now fits on one page.
    total = 20;
    await user.click(within(await alert(1007)).getByRole('button', { name: 'Đóng' }));
    await user.click(screen.getByRole('button', { name: 'Đóng sự cố' }));
    expect(await screen.findByText('Trang 1 / 1')).toBeInTheDocument();
    expect(seen.at(-1)?.search).toBe('?status=open&page=1&page_size=20');
  });

  it('Reset sends Soft by default', async () => {
    const seen = fakeCsms({
      [LIST]: list(base),
      [RESET]: {
        status: 200,
        body: {
          fault_id: '7',
          command_id: '3',
          reset_status: 'Accepted',
          fault_status: 'resetting',
          forced: false,
        },
      },
    });
    const { user } = open();
    await user.click(within(await alert(1007)).getByRole('button', { name: 'Reset' }));
    const dialog = screen.getByRole('dialog', { name: 'Gửi Reset tới RH24D1-00001?' });
    expect(within(dialog).getByRole('radio', { name: /Soft/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Gửi Reset' }));
    expect(await screen.findByText('Charge Point nhận lệnh Reset Soft')).toBeInTheDocument();
    expect(seen.find((r) => r.path.endsWith('/reset'))?.body).toEqual({ type: 'Soft' });
  });

  it('409 sessions_active → second confirmation listing the sessions → resend with force', async () => {
    let calls = 0;
    const seen = fakeCsms({ [LIST]: list(base) });
    const fetchFake = globalThis.fetch as unknown as (r: Request) => Promise<Response>;
    globalThis.fetch = (async (r: Request) => {
      if (r.method === 'POST' && r.url.endsWith('/reset') && calls++ === 0) {
        await fetchFake(r);
        return new Response(
          JSON.stringify({
            error: 'sessions_active',
            detail: 'x',
            sessions: [{ connector_no: 2, session_id: '55' }],
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (r.method === 'POST' && r.url.endsWith('/reset')) {
        await fetchFake(r);
        return new Response(
          JSON.stringify({
            fault_id: '7',
            command_id: '4',
            reset_status: 'Accepted',
            fault_status: 'resetting',
            forced: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return fetchFake(r);
    }) as typeof fetch;
    const { user } = open();
    await user.click(within(await alert(1007)).getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('radio', { name: /Hard/ }));
    await user.click(screen.getByRole('button', { name: 'Gửi Reset' }));
    const second = await screen.findByRole('dialog', { name: 'RH24D1-00001 đang có phiên sạc' });
    expect(within(second).getByText('Connector 2 — phiên 55')).toBeInTheDocument();
    await user.click(within(second).getByRole('button', { name: 'Vẫn Reset' }));
    expect(
      await screen.findByText('Charge Point nhận lệnh Reset Hard (đã cắt phiên đang sạc)'),
    ).toBeInTheDocument();
    expect(seen.filter((r) => r.path.endsWith('/reset')).map((r) => r.body)).toEqual([
      { type: 'Hard' },
      { type: 'Hard', force: true },
    ]);
  });

  it.each([
    [502, 'station_error', 'Charge Point không trả lời lệnh Reset hợp lệ'],
    [409, 'station_offline', 'Charge Point đang offline, không gửi được lệnh Reset'],
  ])('%s %s → Vietnamese message on the alert', async (status, error, text) => {
    fakeCsms({ [LIST]: list(base), [RESET]: { status, body: { error, detail: error } } });
    const { user } = open();
    await user.click(within(await alert(1007)).getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Gửi Reset' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a resetting fault shows the countdown and no buttons', async () => {
    const deadline = new Date(Date.now() + 90_000).toISOString();
    fakeCsms({
      [LIST]: list({
        ...base,
        status: 'resetting',
        reset: { command_id: '3', status: 'accepted', deadline },
        allowed_actions: [],
      }),
    });
    open();
    const a = within(await alert(1007));
    expect(a.getByText(/Chờ connector hoạt động lại · còn (89|90) s/)).toBeInTheDocument();
    expect(a.queryByRole('button')).toBeNull();
  });
});
