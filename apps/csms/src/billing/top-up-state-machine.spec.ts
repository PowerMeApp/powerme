/**
 * Unit test TopUpStateMachine (STM-4 v1.1, 10/11/2026: bỏ cửa sổ trả trễ, T117) — không DB.
 *
 * Một test cho MỖI chuyển của STM-4 (#2–#4, #6, #7; #5 đã bỏ; tên test = số chuyển), các nhánh
 * guard, kết quả lặp / mâu thuẫn của BR-P13, timeout đến muộn (`stale`), các ⊕ của decisions D4
 * (thành công sau `failed`, khoản trễ đã ghi, lần trả thứ hai cho top-up đã cộng — T116), rồi quét
 * TOÀN BỘ 5 trạng thái × 4 event = 20 cặp:
 * 16 cặp được nhận, 4 cặp ném InvalidTransition (ADMIN_REFUND khi không ở credited).
 * T32 Phần 8b: #8 (pending → failed khi đã trả mà không cộng được) và các ca cùng giao dịch khác số
 * tiền → `conflicting_result`. Bảng 20 cặp giữ nguyên (guard mặc định = cộng được).
 */
import { topUpStatusEnum } from '../db/schema/enums.js';
import { InvalidTransition, MissingGuard } from './invalid-transition.js';
import {
  NOT_CREDITABLE_TRANSITION,
  TOP_UP_EVENTS,
  TOP_UP_STATUSES,
  TOP_UP_TRANSITIONS,
  TopUpEvent,
  TopUpGuards,
  TopUpStateMachine,
  TopUpStatus,
} from './top-up-state-machine.js';

const sm = new TopUpStateMachine();

/**
 * Guard đủ cho mọi event: mặc định "cộng được", chưa có khoản trễ, và nếu đã cộng thì cộng bằng
 * chính giao dịch này (VNP-1).
 */
const OK: TopUpGuards = {
  transactionNo: 'VNP-1',
  appliedTransactionNo: 'VNP-1',
  recordedLateRef: null,
  balanceCoversAmount: true,
};

describe('TopUpStateMachine — các chuyển của STM-4', () => {
  it('TC-STM4-01 #1: tạo top-up ở pending', () => {
    expect(sm.initial()).toBe('pending');
  });

  type Row = [no: string, from: TopUpStatus, event: TopUpEvent, to: TopUpStatus, note: string];
  const STM4: Row[] = [
    ['#2', 'pending', 'PAYMENT_SUCCEEDED', 'credited', 'IPN/querydr báo đã trả (TC-STM4-02)'],
    ['#3', 'pending', 'PAYMENT_FAILED', 'failed', 'thanh toán lỗi hoặc huỷ (TC-STM4-03)'],
    [
      '#4',
      'pending',
      'TIMEOUT_NOT_PAID',
      'expired',
      'TC-STM4-04 quá expires_at + 2 phút, querydr báo chưa trả dứt khoát',
    ],
    ['#7', 'credited', 'ADMIN_REFUND', 'refunded', 'TC-STM4-07 Admin hoàn, số dư đủ (UC-ADM-08)'],
  ];

  it.each(STM4)('STM-4 %s: %s --%s--> %s (%s)', (no, from, event, to) => {
    expect(sm.apply(from, event, OK)).toEqual({ to, outcome: 'transition', no });
  });

  it('bảng TOP_UP_TRANSITIONS khớp đúng các dòng của test', () => {
    expect(TOP_UP_TRANSITIONS.map((t) => [t.no, t.from, t.event, t.to])).toEqual(
      STM4.map(([no, from, event, to]) => [no, from, event, to]),
    );
  });
});

describe('TopUpStateMachine — thanh toán thành công tới khi chưa / đã expired', () => {
  it('(bước IPN): pending đã quá expires_at, thành công → credited (#2)', () => {
    // Máy không xét đồng hồ: top-up còn `pending` thì cộng, kể cả khi đã quá `expires_at` (đang
    // chờ querydr chốt, D4 ⊕). Test mức service (vòng quét + querydr) là việc của Phần 8.
    expect(sm.apply('pending', 'PAYMENT_SUCCEEDED', OK)).toEqual({
      to: 'credited',
      outcome: 'transition',
      no: '#2',
    });
  });

  it('TC-STM4-06 #6: thành công khi đã expired → late_payment, giữ expired', () => {
    expect(sm.apply('expired', 'PAYMENT_SUCCEEDED', OK)).toEqual({
      to: 'expired',
      outcome: 'late_payment',
      no: '#6',
    });
  });

  it('#6 chỉ cần transactionNo + recordedLateRef (không MissingGuard)', () => {
    const step = sm.apply('expired', 'PAYMENT_SUCCEEDED', {
      transactionNo: 'VNP-1',
      recordedLateRef: null,
    });
    expect(step).toEqual({ to: 'expired', outcome: 'late_payment', no: '#6' });
  });
});

describe('TopUpStateMachine — ⊕ D4: thành công tới khi đã failed', () => {
  it('TC-STM4-05: chưa có khoản trễ → ghi khoản trễ, giữ failed', () => {
    expect(sm.apply('failed', 'PAYMENT_SUCCEEDED', OK)).toEqual({
      to: 'failed',
      outcome: 'late_payment',
      no: null,
    });
  });

  it('chỉ cần transactionNo + recordedLateRef, luôn là khoản trễ', () => {
    const step = sm.apply('failed', 'PAYMENT_SUCCEEDED', {
      transactionNo: 'VNP-1',
      recordedLateRef: null,
    });
    expect(step.outcome).toBe('late_payment');
  });
});

describe('TopUpStateMachine — ⊕ D4: khoản trễ đã ghi rồi', () => {
  const cases = ['failed', 'expired'] as const;

  it.each(cases)('%s: khoản trễ lặp, cùng transactionNo → already_applied', (from) => {
    const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
      ...OK,
      recordedLateRef: 'VNP-1',
      transactionNo: 'VNP-1',
    });
    expect(step).toEqual({ to: from, outcome: 'already_applied', no: null });
  });

  it.each(cases)('%s: khác transactionNo → conflicting_result', (from) => {
    const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
      ...OK,
      recordedLateRef: 'VNP-1',
      transactionNo: 'VNP-2',
    });
    // Phần 8b bổ sung (0024): reason để service ghi dòng top_up_payment_conflicts.
    expect(step).toEqual({
      to: from,
      outcome: 'conflicting_result',
      no: null,
      reason: 'extra_payment',
    });
  });
});

describe('TopUpStateMachine — BR-P13: kết quả tới khi đã có kết quả không đổi trạng thái', () => {
  it.each([
    ['credited', 'PAYMENT_SUCCEEDED', 'IPN lặp của chính giao dịch đã cộng'],
    ['refunded', 'PAYMENT_SUCCEEDED', 'IPN lặp sau khi Admin đã hoàn'],
    ['failed', 'PAYMENT_FAILED', 'báo lỗi lặp'],
    ['expired', 'PAYMENT_FAILED', 'báo lỗi sau khi đã hết hạn'],
  ] as const)('%s --%s--> already_applied (%s)', (from, event, _why) => {
    expect(sm.apply(from, event, OK)).toEqual({ to: from, outcome: 'already_applied', no: null });
  });

  it.each(['credited', 'refunded'] as const)(
    '%s: báo lỗi sau khi đã cộng tiền → conflicting_result, không đổi trạng thái',
    (from) => {
      expect(sm.apply(from, 'PAYMENT_FAILED')).toEqual({
        to: from,
        outcome: 'conflicting_result',
        no: null,
      });
    },
  );
});

describe('TopUpStateMachine — T116: thành công tới khi đã credited / refunded', () => {
  const cases = ['credited', 'refunded'] as const;

  it.each(cases)(
    '%s: transactionNo KHÁC giao dịch đã cộng, chưa có khoản trễ → late_payment (lần trả thứ hai)',
    (from) => {
      const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
        transactionNo: 'VNP-2',
        appliedTransactionNo: 'VNP-1',
        recordedLateRef: null,
      });
      expect(step).toEqual({ to: from, outcome: 'late_payment', no: null });
    },
  );

  it.each(cases)('%s: khoản trễ lặp (cùng transactionNo đã ghi) → already_applied', (from) => {
    const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
      transactionNo: 'VNP-2',
      appliedTransactionNo: 'VNP-1',
      recordedLateRef: 'VNP-2',
    });
    expect(step).toEqual({ to: from, outcome: 'already_applied', no: null });
  });

  it.each(cases)('%s: khoản thứ ba (khác cả hai) → conflicting_result', (from) => {
    const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
      transactionNo: 'VNP-3',
      appliedTransactionNo: 'VNP-1',
      recordedLateRef: 'VNP-2',
    });
    expect(step).toEqual({
      to: from,
      outcome: 'conflicting_result',
      no: null,
      reason: 'extra_payment',
    });
  });

  it.each(cases)('%s: IPN lặp của giao dịch đã cộng thắng dù đã có khoản trễ', (from) => {
    const step = sm.apply(from, 'PAYMENT_SUCCEEDED', {
      transactionNo: 'VNP-1',
      appliedTransactionNo: 'VNP-1',
      recordedLateRef: 'VNP-2',
    });
    expect(step).toEqual({ to: from, outcome: 'already_applied', no: null });
  });
});

describe('TopUpStateMachine — #8 (Phần 8b): đã trả nhưng không cộng được', () => {
  it('bảng #8: pending --PAYMENT_SUCCEEDED--> failed', () => {
    expect(NOT_CREDITABLE_TRANSITION).toEqual({
      no: '#8',
      from: 'pending',
      event: 'PAYMENT_SUCCEEDED',
      to: 'failed',
    });
  });

  it.each([
    ['amount_mismatch', { amountMismatch: true }],
    ['account_closed', { accountClosed: true }],
  ] as const)('pending + %s → not_creditable, sang failed (#8)', (reason, guards) => {
    expect(sm.apply('pending', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-1', ...guards })).toEqual(
      { to: 'failed', outcome: 'not_creditable', no: '#8', reason },
    );
  });

  it('sai số tiền và tài khoản đóng cùng lúc → lý do là sai số tiền (kiểm trước)', () => {
    const step = sm.apply('pending', 'PAYMENT_SUCCEEDED', {
      amountMismatch: true,
      accountClosed: true,
    });
    expect(step.reason).toBe('amount_mismatch');
  });

  it('không guard / guard false → credited (#2) như cũ', () => {
    expect(sm.apply('pending', 'PAYMENT_SUCCEEDED').outcome).toBe('transition');
    expect(
      sm.apply('pending', 'PAYMENT_SUCCEEDED', { amountMismatch: false, accountClosed: false }),
    ).toEqual({ to: 'credited', outcome: 'transition', no: '#2' });
  });

  it.each(['credited', 'refunded'] as const)(
    '%s: tài khoản đóng không đổi gì (chỉ xét ở pending) → already_applied',
    (from) => {
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...OK, accountClosed: true }).outcome).toBe(
        'already_applied',
      );
    },
  );
});

describe('TopUpStateMachine — Phần 8b mục 3.4: cùng giao dịch nhưng khác số tiền là mâu thuẫn', () => {
  it.each(['credited', 'refunded'] as const)(
    '%s: cùng transactionNo đã cộng, khác số tiền → conflicting_result (kể cả khi đã có khoản trễ)',
    (from) => {
      const g = { transactionNo: 'VNP-1', appliedTransactionNo: 'VNP-1', amountMismatch: true };
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...g, recordedLateRef: null }).outcome).toBe(
        'conflicting_result',
      );
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...g, recordedLateRef: 'VNP-2' }).outcome).toBe(
        'conflicting_result',
      );
    },
  );

  it.each(['credited', 'refunded'] as const)(
    '%s: transactionNo khác giao dịch đã cộng, sai số tiền, chưa có khoản trễ → late_payment',
    (from) => {
      expect(
        sm.apply(from, 'PAYMENT_SUCCEEDED', {
          transactionNo: 'VNP-2',
          appliedTransactionNo: 'VNP-1',
          recordedLateRef: null,
          amountMismatch: true,
        }).outcome,
      ).toBe('late_payment');
    },
  );

  it.each(['credited', 'refunded', 'failed', 'expired'] as const)(
    '%s: đã có khoản trễ cùng transactionNo nhưng khác số tiền → conflicting_result; cùng số → already_applied',
    (from) => {
      const g = { transactionNo: 'VNP-2', appliedTransactionNo: 'VNP-1', recordedLateRef: 'VNP-2' };
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...g, lateAmountMismatch: true })).toEqual({
        to: from,
        outcome: 'conflicting_result',
        no: null,
        reason: 'amount_differs',
      });
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...g, lateAmountMismatch: false }).outcome).toBe(
        'already_applied',
      );
    },
  );

  it.each(['failed', 'expired'] as const)(
    '%s: chưa có khoản trễ, sai số tiền → late_payment (ghi số thực trừ ở service)',
    (from) => {
      expect(
        sm.apply(from, 'PAYMENT_SUCCEEDED', {
          transactionNo: 'VNP-2',
          recordedLateRef: null,
          amountMismatch: true,
        }).outcome,
      ).toBe('late_payment');
    },
  );
});

describe('TopUpStateMachine — Phần 8b bổ sung: reason của conflicting_result (bảng 0024)', () => {
  it.each(['credited', 'refunded'] as const)(
    '%s: cùng transactionNo đã cộng, khác số tiền → amount_differs',
    (from) => {
      expect(sm.apply(from, 'PAYMENT_SUCCEEDED', { ...OK, amountMismatch: true }).reason).toBe(
        'amount_differs',
      );
    },
  );

  it.each(['credited', 'refunded', 'failed', 'expired'] as const)(
    '%s: đã có khoản trễ, thêm lần trả khác giao dịch → extra_payment',
    (from) => {
      expect(
        sm.apply(from, 'PAYMENT_SUCCEEDED', {
          transactionNo: 'VNP-3',
          appliedTransactionNo: 'VNP-1',
          recordedLateRef: 'VNP-2',
        }).reason,
      ).toBe('extra_payment');
    },
  );

  it.each(['credited', 'refunded'] as const)(
    '%s: PAYMENT_FAILED sau khi đã cộng → conflicting_result không có reason (chỉ log)',
    (from) => {
      expect(sm.apply(from, 'PAYMENT_FAILED').reason).toBeUndefined();
    },
  );
});

describe('TopUpStateMachine — TIMEOUT_NOT_PAID đến muộn (đua với IPN qua Scheduler) → stale', () => {
  it.each(['credited', 'failed', 'expired', 'refunded'] as const)(
    '%s --TIMEOUT_NOT_PAID--> stale, giữ nguyên, không ném',
    (from) => {
      expect(sm.apply(from, 'TIMEOUT_NOT_PAID')).toEqual({ to: from, outcome: 'stale', no: null });
      expect(sm.canApply(from, 'TIMEOUT_NOT_PAID')).toBe(true);
    },
  );
});

describe('TopUpStateMachine — #7: guard số dư khi Admin hoàn', () => {
  it('số dư không đủ → rejected, giữ credited, không ném', () => {
    expect(sm.apply('credited', 'ADMIN_REFUND', { balanceCoversAmount: false })).toEqual({
      to: 'credited',
      outcome: 'rejected',
      reason: 'insufficient_balance',
      no: '#7',
    });
  });
});

describe('TopUpStateMachine — chuyển không hợp lệ bị từ chối', () => {
  it.each([
    ['refunded', 'ADMIN_REFUND', 'hoàn hai lần'],
    ['pending', 'ADMIN_REFUND', 'chưa cộng tiền'],
    ['expired', 'ADMIN_REFUND', 'khoản trễ hoàn bằng refundLatePayment, không phải #7'],
    ['failed', 'ADMIN_REFUND', 'chưa cộng tiền'],
  ] as const)('%s --%s--> ✗ (%s)', (from, event, _why) => {
    expect(() => sm.apply(from, event, OK)).toThrow(InvalidTransition);
    expect(sm.canApply(from, event)).toBe(false);
  });

  it('lỗi mang machine/from/event để route trả 409 có nội dung', () => {
    try {
      sm.apply('refunded', 'ADMIN_REFUND', OK);
      throw new Error('không ném');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransition);
      expect(err).toMatchObject({ machine: 'STM-4', from: 'refunded', event: 'ADMIN_REFUND' });
      expect((err as Error).message).toContain('STM-4');
    }
  });
});

describe('TopUpStateMachine — thiếu guard thì ném MissingGuard, không đoán', () => {
  it.each([
    ['expired', 'PAYMENT_SUCCEEDED', { recordedLateRef: null }],
    ['expired', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-1' }],
    ['failed', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-1' }],
    ['credited', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-1' }],
    ['refunded', 'PAYMENT_SUCCEEDED', { appliedTransactionNo: 'VNP-1' }],
    // T116: credited / refunded cần cả recordedLateRef.
    ['credited', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-1', appliedTransactionNo: 'VNP-1' }],
    ['refunded', 'PAYMENT_SUCCEEDED', { transactionNo: 'VNP-2', appliedTransactionNo: 'VNP-1' }],
    ['credited', 'ADMIN_REFUND', {}],
  ] as const)('%s --%s--> thiếu guard %j', (from, event, guards) => {
    expect(() => sm.apply(from, event, guards)).toThrow(MissingGuard);
  });

  it('pending không cần guard nào', () => {
    expect(sm.apply('pending', 'PAYMENT_SUCCEEDED').to).toBe('credited');
    expect(sm.apply('pending', 'PAYMENT_FAILED').to).toBe('failed');
    expect(sm.apply('pending', 'TIMEOUT_NOT_PAID').to).toBe('expired');
  });
});

describe('TopUpStateMachine — quét toàn bộ 5 × 4 = 20 cặp', () => {
  const pairs = TOP_UP_STATUSES.flatMap((s) => TOP_UP_EVENTS.map((e) => [s, e] as const));

  /** Kết quả mong đợi của từng cặp với guard OK; `throw` = InvalidTransition. */
  const EXPECTED: Record<TopUpStatus, Record<TopUpEvent, string>> = {
    pending: {
      PAYMENT_SUCCEEDED: 'transition',
      PAYMENT_FAILED: 'transition',
      TIMEOUT_NOT_PAID: 'transition',
      ADMIN_REFUND: 'throw',
    },
    credited: {
      PAYMENT_SUCCEEDED: 'already_applied',
      PAYMENT_FAILED: 'conflicting_result',
      TIMEOUT_NOT_PAID: 'stale',
      ADMIN_REFUND: 'transition',
    },
    failed: {
      PAYMENT_SUCCEEDED: 'late_payment',
      PAYMENT_FAILED: 'already_applied',
      TIMEOUT_NOT_PAID: 'stale',
      ADMIN_REFUND: 'throw',
    },
    expired: {
      PAYMENT_SUCCEEDED: 'late_payment',
      PAYMENT_FAILED: 'already_applied',
      TIMEOUT_NOT_PAID: 'stale',
      ADMIN_REFUND: 'throw',
    },
    refunded: {
      PAYMENT_SUCCEEDED: 'already_applied',
      PAYMENT_FAILED: 'conflicting_result',
      TIMEOUT_NOT_PAID: 'stale',
      ADMIN_REFUND: 'throw',
    },
  };

  it.each(pairs)('%s × %s khớp bảng 20 cặp', (s, e) => {
    let got: string;
    try {
      got = sm.apply(s, e, OK).outcome;
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransition);
      got = 'throw';
    }
    expect(got).toBe(EXPECTED[s][e]);
  });

  it('đúng 20 cặp: 16 được nhận, 4 bị từ chối', () => {
    let accepted = 0;
    let rejected = 0;
    for (const [s, e] of pairs) {
      try {
        sm.apply(s, e, OK);
        accepted += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransition);
        rejected += 1;
      }
    }
    expect(pairs).toHaveLength(20);
    expect([accepted, rejected]).toEqual([16, 4]);
  });

  it('canApply khớp apply trên cả 20 cặp', () => {
    for (const [s, e] of pairs) {
      let applies = true;
      try {
        sm.apply(s, e, OK);
      } catch {
        applies = false;
      }
      expect([s, e, sm.canApply(s, e)]).toEqual([s, e, applies]);
    }
  });

  it('chỉ #2–#4, #7 đổi trạng thái; mọi kết quả khác giữ nguyên', () => {
    for (const [s, e] of pairs) {
      if (!sm.canApply(s, e)) continue;
      const step = sm.apply(s, e, OK);
      if (step.outcome !== 'transition') expect(step.to).toBe(s);
    }
  });
});

describe('TopUpStateMachine — isOpen (D2 ⊕: chỉ pending chặn tạo mới)', () => {
  it.each(TOP_UP_STATUSES.map((s) => [s, s === 'pending'] as const))('%s → %s', (s, open) => {
    expect(sm.isOpen(s)).toBe(open);
  });
});

describe('TopUpStateMachine — đồng bộ với enum DB', () => {
  it('TOP_UP_STATUSES = top_up_status', () => {
    expect([...TOP_UP_STATUSES]).toEqual(topUpStatusEnum.enumValues);
  });
});
