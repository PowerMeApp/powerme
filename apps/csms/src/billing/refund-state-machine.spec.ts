/**
 * Unit test RefundStateMachine (STM-10 v2.0, hoàn tiền thủ công) — không DB.
 *
 * Một test cho MỖI chuyển của STM-10 (#2–#4), rồi quét TOÀN BỘ 3 trạng thái × 3 event = 9 cặp:
 * 3 cặp được nhận, 6 cặp bị từ chối.
 */
import { refundStatusEnum } from '../db/schema/enums.js';
import { InvalidTransition } from './invalid-transition.js';
import {
  REFUND_EVENTS,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  RefundEvent,
  RefundStateMachine,
  RefundStatus,
} from './refund-state-machine.js';

const sm = new RefundStateMachine();

describe('RefundStateMachine — các chuyển của STM-10', () => {
  it('#1: refund tạo ra ở requested (cùng transaction với quyết định hoàn)', () => {
    expect(sm.initial()).toBe('requested');
  });

  type Row = [no: string, from: RefundStatus, event: RefundEvent, to: RefundStatus];
  const STM10: Row[] = [
    ['#2', 'requested', 'ADMIN_CONFIRMED', 'done'],
    ['#3', 'requested', 'ADMIN_MARKED_FAILED', 'failed'],
    ['#4', 'failed', 'ADMIN_REDO', 'requested'],
  ];

  it.each(STM10)('%s: %s --%s--> %s', (no, from, event, to) => {
    expect(sm.apply(from, event)).toEqual({ to, no });
  });

  it('bảng REFUND_TRANSITIONS khớp đúng các dòng của test', () => {
    expect(REFUND_TRANSITIONS.map((t) => [t.no, t.from, t.event, t.to])).toEqual(STM10);
  });

  it('làm lại rồi ghi nhận → done', () => {
    const redone = sm.apply(sm.apply('requested', 'ADMIN_MARKED_FAILED').to, 'ADMIN_REDO').to;
    expect(sm.apply(redone, 'ADMIN_CONFIRMED').to).toBe('done');
  });
});

describe('RefundStateMachine — chuyển không hợp lệ bị từ chối', () => {
  it.each([
    ['failed', 'ADMIN_CONFIRMED', 'không có failed → done, phải làm lại trước'],
    ['failed', 'ADMIN_MARKED_FAILED', 'đã failed'],
    ['requested', 'ADMIN_REDO', 'đang chờ CSKH, không làm lại chồng'],
    ['done', 'ADMIN_CONFIRMED', 'done là trạng thái cuối'],
    ['done', 'ADMIN_MARKED_FAILED', 'done là trạng thái cuối'],
    ['done', 'ADMIN_REDO', 'done là trạng thái cuối'],
  ] as const)('%s --%s--> ✗ (%s)', (from, event, _why) => {
    expect(() => sm.apply(from, event)).toThrow(InvalidTransition);
    expect(sm.canApply(from, event)).toBe(false);
  });

  it('lỗi mang machine/from/event', () => {
    expect(() => sm.apply('failed', 'ADMIN_CONFIRMED')).toThrow(
      expect.objectContaining({ machine: 'STM-10', from: 'failed', event: 'ADMIN_CONFIRMED' }),
    );
  });
});

describe('RefundStateMachine — quét toàn bộ 3 × 3 = 9 cặp', () => {
  const pairs = REFUND_STATUSES.flatMap((s) => REFUND_EVENTS.map((e) => [s, e] as const));

  it('đúng 9 cặp: 3 được nhận, 6 bị từ chối; canApply khớp apply', () => {
    let accepted = 0;
    for (const [s, e] of pairs) {
      let applies = true;
      try {
        sm.apply(s, e);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransition);
        applies = false;
      }
      if (applies) accepted += 1;
      expect([s, e, sm.canApply(s, e)]).toEqual([s, e, applies]);
    }
    expect(pairs).toHaveLength(9);
    expect([accepted, pairs.length - accepted]).toEqual([3, 6]);
  });
});

describe('RefundStateMachine — đồng bộ với enum DB', () => {
  it('REFUND_STATUSES = refund_status', () => {
    expect([...REFUND_STATUSES]).toEqual(refundStatusEnum.enumValues);
  });
});
