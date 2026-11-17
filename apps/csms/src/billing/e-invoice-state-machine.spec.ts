/**
 * Unit test EInvoiceStateMachine (STM-7 v1.0) — không DB.
 *
 * Một test cho MỖI mũi tên của STM-7 (#1–#7), biên của bộ đếm lượt (RETRY_LIMIT = 4), Admin retry
 * không reset bộ đếm, rồi quét TOÀN BỘ 4 trạng thái × 4 event = 16 cặp: 4 cặp được nhận (5 chuyển,
 * vì ATTEMPT_FAILED có hai đích tuỳ guard), 12 cặp bị từ chối.
 */
import { eInvoiceErrorKindEnum, eInvoiceStatusEnum } from '../db/schema/enums.js';
import {
  E_INVOICE_EVENTS,
  E_INVOICE_STATUSES,
  E_INVOICE_TRANSITIONS,
  EInvoiceStateMachine,
} from './e-invoice-state-machine.js';
import { InvalidTransition, MissingGuard } from './invalid-transition.js';
import { RETRY_LIMIT } from './refund-state-machine.js';

const sm = new EInvoiceStateMachine();

const TRANSIENT_1 = { errorKind: 'transient', attemptCount: 1 } as const;

describe('EInvoiceStateMachine — các mũi tên của STM-7', () => {
  it('#1: hoá đơn tạo ra ở requested (cùng transaction cộng tiền)', () => {
    expect(sm.initial()).toBe('requested');
  });

  it('#2: nhà cung cấp trả số hoá đơn → issued', () => {
    expect(sm.apply('requested', 'PROVIDER_ISSUED')).toEqual({
      to: 'issued',
      no: '#2',
      retry: false,
    });
  });

  it('#3 → #4: lỗi tạm thời, chưa hết lượt → failed, hẹn retry', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', TRANSIENT_1)).toEqual({
      to: 'failed',
      no: '#3→#4',
      retry: true,
    });
  });

  it('#3 → #5: bị từ chối → needs_review, không hẹn retry', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'data', attemptCount: 1 })).toEqual(
      { to: 'needs_review', no: '#3→#5', retry: false },
    );
  });

  it('#6: failed đến hạn → requested', () => {
    expect(sm.apply('failed', 'RETRY_DUE')).toEqual({ to: 'requested', no: '#6', retry: false });
  });

  it('#7: Admin retry needs_review → requested', () => {
    expect(sm.apply('needs_review', 'ADMIN_RETRY')).toEqual({
      to: 'requested',
      no: '#7',
      retry: false,
    });
  });

  it('bảng E_INVOICE_TRANSITIONS đúng 5 chuyển theo thứ tự mũi tên', () => {
    expect(E_INVOICE_TRANSITIONS.map((t) => [t.no, t.from, t.event, t.to])).toEqual([
      ['#2', 'requested', 'PROVIDER_ISSUED', 'issued'],
      ['#3→#4', 'requested', 'ATTEMPT_FAILED', 'failed'],
      ['#3→#5', 'requested', 'ATTEMPT_FAILED', 'needs_review'],
      ['#6', 'failed', 'RETRY_DUE', 'requested'],
      ['#7', 'needs_review', 'ADMIN_RETRY', 'requested'],
    ]);
  });
});

describe('EInvoiceStateMachine — biên bộ đếm lượt (RETRY_LIMIT dùng chung với STM-10)', () => {
  it('RETRY_LIMIT = 4 lượt tổng (BR-P44)', () => {
    expect(RETRY_LIMIT).toBe(4);
  });

  it.each([
    [1, 'failed'],
    [2, 'failed'],
    [3, 'failed'],
    [4, 'needs_review'],
    [5, 'needs_review'],
  ] as const)('lỗi tạm thời ở lượt %i → %s', (attemptCount, to) => {
    expect(
      sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'transient', attemptCount }).to,
    ).toBe(to);
  });

  it('bị từ chối (data) ngay lượt 1 → needs_review, không chờ hết 4 lượt', () => {
    expect(sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'data', attemptCount: 1 }).to).toBe(
      'needs_review',
    );
  });

  it('Admin retry không reset bộ đếm: bộ đếm đã ≥ 4, lỗi tạm thời → lại needs_review', () => {
    const afterRetry = sm.apply('needs_review', 'ADMIN_RETRY').to;
    expect(afterRetry).toBe('requested');
    expect(
      sm.apply(afterRetry, 'ATTEMPT_FAILED', {
        errorKind: 'transient',
        attemptCount: RETRY_LIMIT + 1,
      }),
    ).toEqual({ to: 'needs_review', no: '#3→#5', retry: false });
  });

  it('Admin retry thành công → issued', () => {
    expect(sm.apply(sm.apply('needs_review', 'ADMIN_RETRY').to, 'PROVIDER_ISSUED').to).toBe(
      'issued',
    );
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
    expect(() => sm.apply('requested', 'ATTEMPT_FAILED', { errorKind: 'transient' })).toThrow(
      MissingGuard,
    );
  });
});

describe('EInvoiceStateMachine — quét toàn bộ 4 × 4 = 16 cặp', () => {
  const pairs = E_INVOICE_STATUSES.flatMap((s) => E_INVOICE_EVENTS.map((e) => [s, e] as const));
  const ACCEPTED = new Set([
    'requested PROVIDER_ISSUED',
    'requested ATTEMPT_FAILED',
    'failed RETRY_DUE',
    'needs_review ADMIN_RETRY',
  ]);

  it.each(pairs)('%s × %s: nhận hoặc ném InvalidTransition đúng bảng', (s, e) => {
    if (ACCEPTED.has(`${s} ${e}`)) {
      expect(() => sm.apply(s, e, TRANSIENT_1)).not.toThrow();
      expect(sm.canApply(s, e)).toBe(true);
    } else {
      expect(() => sm.apply(s, e, TRANSIENT_1)).toThrow(InvalidTransition);
      expect(() => sm.apply(s, e, TRANSIENT_1)).toThrow(
        expect.objectContaining({ machine: 'STM-7', from: s, event: e }),
      );
      expect(sm.canApply(s, e)).toBe(false);
    }
  });

  it('đúng 16 cặp: 4 được nhận, 12 bị từ chối; mọi event trên issued bị từ chối', () => {
    expect(pairs).toHaveLength(16);
    expect(pairs.filter(([s, e]) => sm.canApply(s, e))).toHaveLength(4);
    for (const e of E_INVOICE_EVENTS) expect(sm.canApply('issued', e)).toBe(false);
  });
});

describe('EInvoiceStateMachine — đồng bộ với enum DB', () => {
  it('E_INVOICE_STATUSES = e_invoice_status', () => {
    expect([...E_INVOICE_STATUSES]).toEqual(eInvoiceStatusEnum.enumValues);
  });

  it('errorKind = e_invoice_error_kind', () => {
    expect(eInvoiceErrorKindEnum.enumValues).toEqual(['transient', 'data']);
  });
});
