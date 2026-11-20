/** Screen 23 (FE-12, UC-OPS-05): unattributed / review queues and the Operator's decisions. */
import { screen, waitFor, within } from '@testing-library/react';
import type { ReviewSession, UnattributedSession } from '@powerme/shared';
import { fakeCsms, renderApp, session, STAFF } from './render';

const LIST = 'GET /api/operator/v1/sessions';
const stoppedAt = new Date(Date.now() - 5 * 60_000).toISOString();
const unattributed = (
  id: string,
  over: Partial<UnattributedSession> = {},
): UnattributedSession => ({
  session_id: id,
  transaction_no: Number(id) + 100,
  charge_point_serial: 'RH24D1-00001',
  connector_no: 1,
  id_tag: `TAG-${id}`,
  origin: 'rfid',
  status: 'closed',
  energy_wh: 2500,
  delivered_offline: false,
  stopped_at: stoppedAt,
  not_assignable_reason: null,
  open_records: ['card_status=unknown'],
  ...over,
});
const review: ReviewSession = {
  session_id: '7',
  transaction_no: 107,
  charge_point_serial: 'RH24D1-00001',
  connector_no: 2,
  id_tag: 'TAG-7',
  origin: 'rfid',
  payment_mode: 'csms_billed',
  energy_wh: 12000,
  stopped: true,
  open_records: ['meter_gap 300 Wh'],
};
const unattributedPage = {
  status: 200,
  body: {
    queue: 'unattributed',
    items: [
      unattributed('1'),
      unattributed('2', { origin: 'free_vend', not_assignable_reason: 'free_vend_not_billable' }),
    ],
    total: 2,
    page: 1,
    page_size: 20,
  },
};
const reviewPage = {
  status: 200,
  body: { queue: 'review', items: [review], total: 1, page: 1, page_size: 20 },
};

describe('Phiên cần xử lý (màn 23)', () => {
  it('lists the unattributed queue; free vend can only be closed; nav link', async () => {
    const seen = fakeCsms({ [LIST]: unattributedPage });
    renderApp('/operator/sessions', session(STAFF));
    const row = within(await screen.findByRole('row', { name: 'Phiên #101' }));
    expect(row.getByText('TAG-1')).toBeInTheDocument();
    expect(row.getByText('2,5 kWh')).toBeInTheDocument();
    expect(row.getByText('card_status=unknown')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Gán tài xế' })).toBeEnabled();
    const free = within(screen.getByRole('row', { name: 'Phiên #102' }));
    expect(free.getByRole('button', { name: 'Gán tài xế' })).toBeDisabled();
    expect(free.getByText(/Free vend — không bao giờ tính tiền/)).toBeInTheDocument();
    expect(free.getByRole('button', { name: 'Đóng' })).toBeEnabled();
    expect(seen[0]).toMatchObject({ search: '?queue=unattributed&page=1&page_size=20' });
    // FE-07 look: breadcrumb and Vietnamese names.
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Tổng quan' })).toHaveAttribute('href', '/operator');
    expect(crumbs.getByText('Phiên cần xử lý')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('columnheader', { name: 'Trụ sạc' })).toBeInTheDocument();
    expect(row.getByText('Súng 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Phiên cần xử lý' })).toHaveAttribute(
      'href',
      '/operator/sessions',
    );
  });

  it('assign: needs a driver id and a note, posts them, shows the result and refreshes', async () => {
    const seen = fakeCsms({
      [LIST]: unattributedPage,
      'POST /api/operator/v1/sessions/1/assign': {
        status: 200,
        body: { session_id: '1', decision: 'assigned', records_reviewed: 1, settlement: 'posted' },
      },
    });
    const { user } = renderApp('/operator/sessions', session(STAFF));
    const row = within(await screen.findByRole('row', { name: 'Phiên #101' }));
    await user.click(row.getByRole('button', { name: 'Gán tài xế' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Gán phiên #101 cho tài xế' }));
    await user.click(dialog.getByRole('button', { name: 'Gán và tính tiền' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Nhập ID tài xế');
    await user.type(dialog.getByLabelText('ID tài xế'), '5');
    await user.click(dialog.getByRole('button', { name: 'Gán và tính tiền' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Ghi chú bắt buộc');
    await user.type(dialog.getByLabelText('Ghi chú (bắt buộc)'), 'Tài xế gọi điện xác nhận');
    const lists = seen.filter((r) => r.method === 'GET').length;
    await user.click(dialog.getByRole('button', { name: 'Gán và tính tiền' }));
    expect(
      await screen.findByText('Đã gán phiên #101 cho tài xế 5 · quyết toán: posted'),
    ).toHaveClass('queue-note', 'ok');
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = seen.find((r) => r.method === 'POST')!;
    expect(post).toMatchObject({
      path: '/api/operator/v1/sessions/1/assign',
      body: { driver_id: '5', note: 'Tài xế gọi điện xác nhận' },
    });
    expect(post.body).not.toHaveProperty('operator_user_id');
    await waitFor(() =>
      expect(seen.filter((r) => r.method === 'GET').length).toBeGreaterThan(lists),
    );
  });

  it('close posts the chosen reason; a server rule error stays in the dialog', async () => {
    const seen = fakeCsms({
      [LIST]: unattributedPage,
      'POST /api/operator/v1/sessions/2/close': {
        status: 409,
        body: { error: 'already_resolved', detail: 'x' },
      },
    });
    const { user } = renderApp('/operator/sessions', session(STAFF));
    const row = within(await screen.findByRole('row', { name: 'Phiên #102' }));
    await user.click(row.getByRole('button', { name: 'Đóng' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Đóng phiên #102 không tính tiền' }));
    await user.selectOptions(dialog.getByLabelText('Lý do'), 'free_vend_ok');
    await user.type(dialog.getByLabelText('Ghi chú (bắt buộc)'), 'Khuyến mãi khai trương');
    await user.click(dialog.getByRole('button', { name: 'Đóng phiên' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Phiên đã có quyết định khác');
    expect(seen.find((r) => r.method === 'POST')).toMatchObject({
      body: { reason: 'free_vend_ok', note: 'Khuyến mãi khai trương' },
    });
  });

  it('review queue: "Cần xem lại" asks for queue=review; resolve posts the verdict', async () => {
    const seen = fakeCsms({
      [LIST]: reviewPage,
      'POST /api/operator/v1/sessions/7/resolve': {
        status: 200,
        body: { session_id: '7', status: 'reconciled', records_reviewed: 1, settlement: 'pending' },
      },
    });
    const { user } = renderApp('/operator/sessions?queue=review', session(STAFF));
    expect(screen.getByRole('button', { name: 'Cần xem lại' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const row = within(await screen.findByRole('row', { name: 'Phiên #107' }));
    expect(row.getByText('meter_gap 300 Wh')).toBeInTheDocument();
    expect(seen[0]).toMatchObject({ search: '?queue=review&page=1&page_size=20' });
    await user.click(row.getByRole('button', { name: 'Chốt đối soát' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Chốt đối soát phiên #107' }));
    await user.type(dialog.getByLabelText('Ghi chú (bắt buộc)'), 'Đã xem ảnh công tơ');
    await user.click(dialog.getByRole('button', { name: 'Chốt đối soát' }));
    expect(
      await screen.findByText('Phiên #107 đã chốt đối soát (reconciled) · quyết toán: pending'),
    ).toHaveClass('queue-note', 'ok');
    expect(seen.find((r) => r.method === 'POST')).toMatchObject({
      body: { resolution: 'meter_confirmed', note: 'Đã xem ảnh công tơ' },
    });
  });

  it('switching queue goes back to unattributed; empty queue message', async () => {
    const seen = fakeCsms({
      [LIST]: {
        status: 200,
        body: { queue: 'review', items: [], total: 0, page: 1, page_size: 20 },
      },
    });
    const { user } = renderApp('/operator/sessions?queue=review', session(STAFF));
    expect(await screen.findByText('Không có phiên nào cần xem lại.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chưa gắn tài xế' }));
    await waitFor(() =>
      expect(seen.some((r) => r.search === '?queue=unattributed&page=1&page_size=20')).toBe(true),
    );
  });
});
