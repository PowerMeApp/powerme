/**
 * Unit test FaultStateMachine (STM-6 v0.2) — không DB.
 *
 * Một test cho MỖI chuyển của STM-6 (tên test = số chuyển), rồi quét TOÀN BỘ 4 trạng thái × 7
 * trigger = 28 cặp: đúng 9 cặp hợp lệ, 3 cặp no-op (SIGNAL khi đang mở), 16 cặp bị từ chối.
 */
import {
  FAULT_STATUSES,
  FAULT_TRANSITIONS,
  FAULT_TRIGGERS,
  FaultStateMachine,
  FaultStatus,
  FaultTrigger,
  InvalidFaultTransitionError,
} from './fault-state-machine.js';

const sm = new FaultStateMachine();

type Row = [no: string, from: FaultStatus, trigger: FaultTrigger, to: FaultStatus, note: string];

const STM6: Row[] = [
  ['t2', 'raised', 'ACKNOWLEDGE', 'acknowledged', 'operator xác nhận cảnh báo (UC-OPS-03)'],
  ['t3', 'raised', 'CONNECTOR_AVAILABLE', 'resolved', 'lỗi tự hết, chưa ai xử lý'],
  ['t4', 'acknowledged', 'RESET_SENT', 'resetting', 'operator gửi Reset từ xa (UC-OPS-04)'],
  ['t5', 'resetting', 'CONNECTOR_AVAILABLE', 'resolved', 'trụ khởi động lại, súng Available'],
  ['t6', 'resetting', 'RESET_FAILED', 'acknowledged', 'Reset bị từ chối hoặc hết hạn chờ'],
  ['t7', 'acknowledged', 'CONNECTOR_AVAILABLE', 'resolved', 'súng Available sau khi đã xác nhận'],
  ['t7', 'acknowledged', 'OPERATOR_CLOSE', 'resolved', 'đóng sau khi kiểm tra tại chỗ'],
  ['t8', 'raised', 'SESSION_COMPLETED', 'resolved', 'BR-P42: phiên hoàn tất bình thường'],
  ['t8', 'acknowledged', 'SESSION_COMPLETED', 'resolved', 'BR-P42: sau khi đã xác nhận'],
];

describe('FaultStateMachine — 9 chuyển của STM-6', () => {
  it('t1: tín hiệu đầu tiên tạo sự cố ở raised', () => {
    expect(sm.initial()).toBe('raised');
  });

  it.each(STM6)('STM-6 %s: %s --%s--> %s (%s)', (no, from, trigger, to) => {
    expect(sm.apply(from, trigger)).toEqual({ to, noop: false, no });
    expect(sm.canApply(from, trigger)).toBe(true);
  });

  it('bảng TRANSITIONS khớp đúng 9 dòng của test', () => {
    expect(FAULT_TRANSITIONS.map((t) => [t.no, t.from, t.trigger, t.to])).toEqual(
      STM6.map(([no, from, trigger, to]) => [no, from, trigger, to]),
    );
  });
});

describe('FaultStateMachine — SIGNAL khi đã có sự cố mở là no-op', () => {
  it.each(['raised', 'acknowledged', 'resetting'] as const)('SIGNAL trên %s giữ nguyên', (s) => {
    expect(sm.apply(s, 'SIGNAL')).toEqual({ to: s, noop: true, no: null });
  });

  it('resolved là trạng thái cuối: SIGNAL bị từ chối (FaultService tạo sự cố MỚI)', () => {
    expect(() => sm.apply('resolved', 'SIGNAL')).toThrow(InvalidFaultTransitionError);
    expect(sm.isOpen('resolved')).toBe(false);
  });
});

describe('FaultStateMachine — chuyển không hợp lệ bị từ chối', () => {
  it.each([
    ['raised', 'RESET_SENT', 'chưa xác nhận thì chưa Reset'],
    ['raised', 'OPERATOR_CLOSE', 'đóng tay chỉ sau khi đã xác nhận'],
    ['acknowledged', 'ACKNOWLEDGE', 'xác nhận hai lần'],
    ['resetting', 'RESET_SENT', 'gửi Reset chồng khi đang chờ'],
    ['resetting', 'OPERATOR_CLOSE', 'đóng khi Reset còn chờ'],
    ['resolved', 'CONNECTOR_AVAILABLE', 'đã đóng'],
    ['resetting', 'SESSION_COMPLETED', 'trụ đang khởi động lại, không có phiên'],
    ['resolved', 'SESSION_COMPLETED', 'đã đóng'],
  ] as const)('%s --%s--> ✗ (%s)', (from, trigger, _why) => {
    expect(() => sm.apply(from, trigger)).toThrow(InvalidFaultTransitionError);
    expect(sm.canApply(from, trigger)).toBe(false);
  });

  it('lỗi mang from/trigger để console trả 409 có nội dung', () => {
    try {
      sm.apply('raised', 'RESET_SENT');
      throw new Error('không ném');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFaultTransitionError);
      expect(err).toMatchObject({ from: 'raised', trigger: 'RESET_SENT' });
      expect((err as Error).message).toContain('STM-6');
    }
  });
});

describe('FaultStateMachine — quét toàn bộ 4 × 7 = 28 cặp', () => {
  const pairs = FAULT_STATUSES.flatMap((s) => FAULT_TRIGGERS.map((t) => [s, t] as const));

  it('đúng 28 cặp: 9 hợp lệ, 3 no-op, 16 bị từ chối', () => {
    let valid = 0;
    let noop = 0;
    let rejected = 0;
    for (const [s, t] of pairs) {
      try {
        if (sm.apply(s, t).noop) noop += 1;
        else valid += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidFaultTransitionError);
        rejected += 1;
      }
    }
    expect(pairs).toHaveLength(28);
    expect([valid, noop, rejected]).toEqual([9, 3, 16]);
  });

  it('canApply khớp apply trên cả 28 cặp', () => {
    for (const [s, t] of pairs) {
      let applies = true;
      try {
        sm.apply(s, t);
      } catch {
        applies = false;
      }
      expect([s, t, sm.canApply(s, t)]).toEqual([s, t, applies]);
    }
  });

  it('mọi trigger trên resolved đều bị từ chối', () => {
    for (const t of FAULT_TRIGGERS) expect(sm.canApply('resolved', t)).toBe(false);
  });
});
