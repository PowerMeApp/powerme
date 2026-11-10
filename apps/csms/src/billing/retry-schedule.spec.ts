import { RefundStateMachine, RETRY_LIMIT } from './refund-state-machine.js';
import { nextRetry, RETRY_DELAYS_MS } from './retry-schedule.js';

const MIN = 60_000;

describe('nextRetry (D7: lịch retry dùng chung cho e-invoice và refund)', () => {
  it('lượt 1 → 5 phút, lượt 2 → 30 phút, lượt 3 → 2 giờ', () => {
    expect(nextRetry(1)).toEqual({ exhausted: false, delayMs: 5 * MIN });
    expect(nextRetry(2)).toEqual({ exhausted: false, delayMs: 30 * MIN });
    expect(nextRetry(3)).toEqual({ exhausted: false, delayMs: 120 * MIN });
  });

  it('đủ RETRY_LIMIT lượt (hoặc hơn) thì báo hết lượt', () => {
    expect(RETRY_LIMIT).toBe(4);
    expect(nextRetry(RETRY_LIMIT)).toEqual({ exhausted: true });
    expect(nextRetry(RETRY_LIMIT + 1)).toEqual({ exhausted: true });
  });

  it('số độ trễ = RETRY_LIMIT − 1', () => {
    expect(RETRY_DELAYS_MS).toHaveLength(RETRY_LIMIT - 1);
  });

  it.each([0, -1, 1.5, Number.NaN])('từ chối attemptCount = %s', (n) => {
    expect(() => nextRetry(n)).toThrow(RangeError);
  });

  it.each([1, 2, 3, 4, 5])('khớp guard retry của STM-10 ở lượt %s', (n) => {
    const step = new RefundStateMachine().apply('requested', 'ATTEMPT_FAILED', {
      errorKind: 'transient',
      attemptCount: n,
    });
    expect(step.retry).toBe(!nextRetry(n).exhausted);
  });
});
