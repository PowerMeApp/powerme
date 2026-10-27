/**
 * WF-04 trên màn hình Fault Alerts — đi đúng STM-6 qua UI thật + mock server:
 * xác nhận (t2), Reset hồi phục (t4 → t5), Reset nhưng lỗi còn (t4 → hết hạn t6), trụ từ chối (t6),
 * đóng sau kiểm tra (t7). Fixture: #101 GroundFailure (raised, lỗi sống qua reboot),
 * #102 InternalError (acknowledged, hồi phục), #103 ConnectorLockFailure (acknowledged, trụ từ chối),
 * #104 UnderVoltage cả trụ (raised, trụ offline).
 */
import { act, screen, within } from '@testing-library/react';
import { mockConfig, mockDb } from '../src/mocks/server';
import { OPERATOR, renderApp } from './render';

async function fault(eventNo: number) {
  return screen.findByRole('article', { name: `Sự cố #${eventNo}` });
}

async function confirm(user: ReturnType<typeof renderApp>['user'], label: string) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: label }));
}

afterEach(() => {
  vi.useRealTimers();
});

/** Đẩy đồng hồ giả từng giây (để vòng làm mới 1 s của RTK Query chạy) tới khi `check` qua. */
async function tickUntil(check: () => void, maxSeconds = 30) {
  for (let i = 0; i <= maxSeconds; i += 1) {
    try {
      check();
      return;
    } catch (err) {
      if (i === maxSeconds) throw err;
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
  }
}

describe('Fault Alerts (screen 21, WF-04 / STM-6)', () => {
  it('sự cố mở xếp nặng trước, có gợi ý xử lý theo mã lỗi', async () => {
    renderApp('/operator/alerts', OPERATOR);
    const first = await fault(101);
    expect(within(first).getByText('Nghiêm trọng')).toBeInTheDocument();
    expect(within(first).getByText(/KHÔNG Reset từ xa nhiều lần/)).toBeInTheDocument();
    expect(within(first).getByText('2 tài xế báo lỗi')).toBeInTheDocument();
    const all = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(all[0]).toBe('Sự cố #101');
    expect(all).not.toContain('Sự cố #99'); // đã xử lý → chỉ ở tab "Tất cả"
  });

  it('raised: chỉ "Xác nhận" bật; xác nhận → Đã xác nhận (t2), Reset/Đóng bật', async () => {
    const { user } = renderApp('/operator/alerts', OPERATOR);
    const card = await fault(101);
    expect(within(card).getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Đóng' })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Xác nhận' }));
    await confirm(user, 'Xác nhận');
    expect(await screen.findByText('Đã xác nhận sự cố #101')).toBeInTheDocument();
    const after = await fault(101);
    expect(within(after).getByText('Đã xác nhận', { selector: '.pill' })).toBeInTheDocument();
    expect(within(after).getByRole('button', { name: 'Reset' })).toBeEnabled();
    expect(within(after).getByRole('button', { name: 'Đóng' })).toBeEnabled();
  });

  it('Reset được trụ nhận, trụ khởi động lại, súng Available → Đã xử lý (t4 → t5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = renderApp('/operator/alerts', OPERATOR, { fakeTimers: true });
    const card = await fault(102);
    await user.click(within(card).getByRole('button', { name: 'Reset' }));
    await user.selectOptions(screen.getByLabelText('Kiểu Reset'), 'Hard');
    await confirm(user, 'Gửi Reset');
    expect(await screen.findByText(/Trụ nhận lệnh Reset Hard/)).toBeInTheDocument();
    expect(within(await fault(102)).getByText(/Chờ súng Available/)).toBeInTheDocument();
    expect(mockDb().commands[0]).toMatchObject({
      action: 'Reset',
      status: 'accepted',
      payload: { type: 'Hard' },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(mockConfig.rebootMs + 100);
    });
    expect(mockDb().faults.find((f) => f.eventNo === 102)?.status).toBe('resolved');
    // lần làm mới kế tiếp: sự cố rời tab "Đang mở"
    await tickUntil(() => expect(screen.queryByRole('article', { name: 'Sự cố #102' })).toBeNull());
    expect(mockDb().pillars.find((p) => p.id === 2)?.connectors[0]?.status).toBe('Available');
  });

  it('Reset nhận nhưng lỗi còn sau reboot → hết hạn chờ → về Đã xác nhận (t6)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = renderApp('/operator/alerts', OPERATOR, { fakeTimers: true });
    const card = await fault(101);
    await user.click(within(card).getByRole('button', { name: 'Xác nhận' }));
    await confirm(user, 'Xác nhận');
    await screen.findByText('Đã xác nhận sự cố #101');
    await user.click(within(await fault(101)).getByRole('button', { name: 'Reset' }));
    await confirm(user, 'Gửi Reset');
    await screen.findByText(/Trụ nhận lệnh Reset Soft/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(mockConfig.rebootMs + 100);
    });
    expect(mockDb().faults.find((f) => f.eventNo === 101)?.status).toBe('resetting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(mockConfig.resetTimeoutMs);
    });
    expect(mockDb().faults.find((f) => f.eventNo === 101)?.status).toBe('acknowledged');
    await tickUntil(() => {
      const card = screen.getByRole('article', { name: 'Sự cố #101' });
      expect(within(card).getByText('Đã xác nhận', { selector: '.pill' })).toBeInTheDocument();
      expect(within(card).getByText(/lệnh Reset: accepted/)).toBeInTheDocument();
    });
  });

  it('trụ từ chối Reset → cảnh báo, sự cố vẫn Đã xác nhận, lệnh rejected', async () => {
    const { user } = renderApp('/operator/alerts', OPERATOR);
    await user.click(within(await fault(103)).getByRole('button', { name: 'Reset' }));
    await confirm(user, 'Gửi Reset');
    expect(await screen.findByText(/Trụ từ chối Reset/)).toBeInTheDocument();
    expect(within(await fault(103)).getByText(/lệnh Reset: rejected/)).toBeInTheDocument();
  });

  it('đóng sau kiểm tra tại chỗ → Đã xử lý (t7 OPERATOR_CLOSE)', async () => {
    const { user } = renderApp('/operator/alerts', OPERATOR);
    await user.click(within(await fault(103)).getByRole('button', { name: 'Đóng' }));
    await confirm(user, 'Đóng sự cố');
    expect(await screen.findByText('Đã đóng sự cố #103')).toBeInTheDocument();
    expect(mockDb().faults.find((f) => f.eventNo === 103)?.status).toBe('resolved');
  });

  it('trụ offline: không Reset được dù đã xác nhận', async () => {
    const { user } = renderApp('/operator/alerts', OPERATOR);
    const card = await fault(104);
    expect(within(card).getByText('Trụ offline')).toBeInTheDocument();
    expect(within(card).getByText(/Cả trụ/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Xác nhận' }));
    await confirm(user, 'Xác nhận');
    await screen.findByText('Đã xác nhận sự cố #104');
    expect(within(await fault(104)).getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  it('tab "Tất cả" có cả sự cố đã xử lý', async () => {
    const { user } = renderApp('/operator/alerts', OPERATOR);
    await fault(101);
    await user.click(screen.getByRole('tab', { name: /Tất cả/ }));
    expect(await fault(99)).toBeInTheDocument();
  });
});
