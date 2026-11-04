/**
 * Unit test RefundStateMachine (STM-10 v1.0) — không DB.
 *
 * Một test cho MỖI chuyển của STM-10 (#2–#5), biên của bộ đếm lượt (RETRY_LIMIT = 4), Admin retry
 * không reset bộ đếm, rồi quét TOÀN BỘ 3 trạng thái × 3 event = 9 cặp: 3 cặp được nhận (4 chuyển,
 * vì ATTEMPT_FAILED có hai đích tuỳ guard), 6 cặp bị từ chối.
 */
import { eInvoiceErrorKindEnum, refundStatusEnum } from '../db/schema/enums.js';
import { InvalidTransition, MissingGuard } from './invalid-transition.js';
import {
  REFUND_EVENTS,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  RETRY_LIMIT,
  RefundEvent,
  RefundStateMachine,
  RefundStatus,
} from './refund-state-machine.js';

const sm = new RefundStateMachine();

const TRANSIENT_1 = { errorKind: 'transient', attemptCount: 1 } as const;

describe('RefundStateMachine — các chuyển của STM-10', () => {
  it('#1: refund tạo ra ở requested (cùng transaction với quyết định hoàn)', () => {
    expect(sm.initial()).toBe('requested');
  });

  it('RETRY_LIMIT = 4 lượt (D1, D7)', () => {
    expect(RETRY_LIMIT).toBe(4);
  });

  type Row = [no: string, from: RefundStatus, event: RefundEvent, to: RefundStatus, retry: boolean];
  const STM10: Row[] = [
    ['#2', 'requested', 'ATTEMPT_FAILED', 'requested', true],
    ['#3', 'requested', 'GATEWAY_CONFIRMED', 'done', false],
    ['#4', 'requested', 'ATTEMPT_FAILED', 'failed', false],
    ['#5', 'failed', 'ADMIN_RETRY', 'requested', false],
  ];

  it('#2: lỗi tạm thời, chưa hết lượt → vẫn requested, hẹn retry', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', TRANSIENT_1)).toEqual({
      to: 'requested',
      no: '#2',
      retry: true,
    });
  });

  it('#3: VNPay xác nhận → done', () => {
    expect(sm.apply('requested', 'GATEWAY_CONFIRMED')).toEqual({
      to: 'done',
      no: '#3',
      retry: false,
    });
  });

  it('#4: bị từ chối → failed', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'data', attemptCount: 1 })).toEqual(
      {
        to: 'failed',
        no: '#4',
        retry: false,
      },
    );
  });

  it('#5: Admin retry → requested', () => {
    expect(sm.apply('failed', 'ADMIN_RETRY')).toEqual({ to: 'requested', no: '#5', retry: false });
  });

  it('bảng REFUND_TRANSITIONS khớp đúng các dòng của test', () => {
    expect(REFUND_TRANSITIONS.map((t) => [t.no, t.from, t.event, t.to])).toEqual(
      STM10.map(([no, from, event, to]) => [no, from, event, to]),
    );
  });
});

describe('RefundStateMachine — biên bộ đếm lượt', () => {
  it.each([
    [1, 'requested'],
    [2, 'requested'],
    [3, 'requested'],
    [4, 'failed'],
    [5, 'failed'],
  ] as const)('lỗi tạm thời ở lượt %i → %s', (attemptCount, to) => {
    expect(
      sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'transient', attemptCount }).to,
    ).toBe(to);
  });

  it('bị từ chối ngay lượt 1 → failed, không chờ hết 4 lượt', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'data', attemptCount: 1 }).to).toBe(
      'failed',
    );
  });

  it('Admin retry không reset bộ đếm: lượt 5 lỗi tạm thời → failed ngay', () => {
    const afterRetry = sm.apply('failed', 'ADMIN_RETRY').to;
    expect(afterRetry).toBe('requested');
    expect(
      sm.apply(afterRetry, 'ATTEMPT_FAILED', {
        errorKind: 'transient',
        attemptCount: RETRY_LIMIT + 1,
      }),
    ).toEqual({ to: 'failed', no: '#4', retry: false });
  });

  it('Admin retry thành công → done', () => {
    expect(sm.apply(sm.apply('failed', 'ADMIN_RETRY').to, 'GATEWAY_CONFIRMED').to).toBe('done');
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'attemptCount = %p không hợp lệ → RangeError',
    (attemptCount) => {
      expect(() =>
        sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'transient', attemptCount }),
      ).toThrow(RangeError);
    },
  );

  it('ATTEMPT_FAILED thiếu guard → MissingGuard', () => {
    expect(() => sm.apply('requested', 'ATTEMPT_FAILED')).toThrow(MissingGuard);
    expect(() => sm.apply('requested', 'ATTEMPT_FAILED', { attemptCount: 1 })).toThrow(
      MissingGuard,
    );
  });
});

describe('RefundStateMachine — chuyển không hợp lệ bị từ chối', () => {
  it.each([
    ['failed', 'GATEWAY_CONFIRMED', 'không có failed → done'],
    ['failed', 'ATTEMPT_FAILED', 'failed chỉ chờ Admin retry'],
    ['requested', 'ADMIN_RETRY', 'đang chờ gửi, không retry chồng'],
    ['done', 'GATEWAY_CONFIRMED', 'done là trạng thái cuối'],
    ['done', 'ATTEMPT_FAILED', 'done là trạng thái cuối'],
    ['done', 'ADMIN_RETRY', 'done là trạng thái cuối'],
  ] as const)('%s --%s--> ✗ (%s)', (from, event, _why) => {
    expect(() => sm.apply(from, event, TRANSIENT_1)).toThrow(InvalidTransition);
    expect(sm.canApply(from, event)).toBe(false);
  });

  it('lỗi mang machine/from/event', () => {
    expect(() => sm.apply('failed', 'GATEWAY_CONFIRMED')).toThrow(
      expect.objectContaining({ machine: 'STM-10', from: 'failed', event: 'GATEWAY_CONFIRMED' }),
    );
  });
});

describe('RefundStateMachine — quét toàn bộ 3 × 3 = 9 cặp', () => {
  const pairs = REFUND_STATUSES.flatMap((s) => REFUND_EVENTS.map((e) => [s, e] as const));

  it('đúng 9 cặp: 4 được nhận, 5 bị từ chối', () => {
    let accepted = 0;
    let rejected = 0;
    for (const [s, e] of pairs) {
      try {
        sm.apply(s, e, TRANSIENT_1);
        accepted += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransition);
        rejected += 1;
      }
    }
    expect(pairs).toHaveLength(9);
    // requested: GATEWAY_CONFIRMED, ATTEMPT_FAILED · failed: ADMIN_RETRY · done: không gì.
    expect([accepted, rejected]).toEqual([3, 6]);
  });

  it('canApply khớp apply trên cả 9 cặp', () => {
    for (const [s, e] of pairs) {
      let applies = true;
      try {
        sm.apply(s, e, TRANSIENT_1);
      } catch {
        applies = false;
      }
      expect([s, e, sm.canApply(s, e)]).toEqual([s, e, applies]);
    }
  });

  it('mọi event trên done đều bị từ chối', () => {
    for (const e of REFUND_EVENTS) expect(sm.canApply('done', e)).toBe(false);
  });
});

describe('RefundStateMachine — đồng bộ với enum DB', () => {
  it('REFUND_STATUSES = refund_status', () => {
    expect([...REFUND_STATUSES]).toEqual(refundStatusEnum.enumValues);
  });

  it('errorKind dùng lại e_invoice_error_kind (D8)', () => {
    expect(eInvoiceErrorKindEnum.enumValues).toEqual(['transient', 'data']);
  });
});
