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
const list = (...faults: OperatorFault[]) => ({ status: 200, body: { faults } });
const open = () => renderApp('/operator/faults', session(STAFF));
const alert = (no: number) => screen.findByRole('article', { name: `Sự cố #${no}` });

describe('Cảnh báo sự cố (màn 21)', () => {
  it('lists the three kinds with labels; buttons only from allowed_actions; nav link', async () => {
    const seen = fakeCsms({ [LIST]: list(base, offline, report) });
    open();
    expect(await screen.findByText('Faulted · GroundFailure · Connector 1')).toBeInTheDocument();
    expect(screen.getByText('Offline · toàn Charge Point')).toBeInTheDocument();
    expect(screen.getByText('Driver report · Connector 2')).toBeInTheDocument();
    const a = within(await alert(1007));
    expect(a.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    expect(a.getByRole('button', { name: 'Đóng' })).toBeInTheDocument();
    expect(a.queryByRole('button', { name: 'Xác nhận' })).toBeNull();
    const o = within(await alert(1008));
    expect(o.getByRole('button', { name: 'Xác nhận' })).toBeInTheDocument();
    expect(o.getByText('Charge Point offline')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cảnh báo sự cố' })).toBeInTheDocument();
    expect(seen[0]).toMatchObject({ search: '?status=open', authorization: 'Bearer token-10' });
  });

  it('All refetches with status=all; empty list shows the empty state', async () => {
    const seen = fakeCsms({ [LIST]: list() });
    const { user } = open();
    expect(await screen.findByText(/Không có cảnh báo/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tất cả' }));
    await waitFor(() => expect(seen.some((r) => r.search === '?status=all')).toBe(true));
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
