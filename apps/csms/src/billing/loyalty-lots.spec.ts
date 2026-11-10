import { LoyaltyLedgerCorrupt, RedemptionRejected } from './billing-errors.js';
import {
  computeQuote,
  LoyaltyRow,
  planExpiry,
  planRedeem,
  planRestore,
  pointsExpiringBy,
  replayLots,
} from './loyalty-lots.js';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const AS_OF = day(100);

/** entry_no đánh 1..n theo thứ tự; lotId do test đặt (ở DB là min(id) của các earn cùng hạn). */
function rows(...specs: Omit<LoyaltyRow, 'entryNo'>[]): LoyaltyRow[] {
  return specs.map((s, i) => ({ ...s, entryNo: i + 1 }));
}
const earn = (points: number, lotId: number, expiresAt: Date) =>
  ({ type: 'earn', points, lotId, expiresAt, topUpId: null }) as const;
const redeem = (points: number, lotId: number, expiresAt: Date, topUpId: number) =>
  ({ type: 'redeem', points: -points, lotId, expiresAt, topUpId }) as const;
const restore = (points: number, lotId: number, expiresAt: Date, topUpId: number) =>
  ({ type: 'restore', points, lotId, expiresAt, topUpId }) as const;
const expire = (points: number, lotId: number | null, expiresAt: Date | null) =>
  ({ type: 'expire', points: -points, lotId, expiresAt, topUpId: null }) as const;
const adjust = (points: number, topUpId: number) =>
  ({ type: 'adjust', points, lotId: null, expiresAt: null, topUpId }) as const;

function corrupt(fn: () => unknown): LoyaltyLedgerCorrupt {
  try {
    fn();
  } catch (err) {
    if (err instanceof LoyaltyLedgerCorrupt) return err;
    throw err;
  }
  throw new Error('kỳ vọng LoyaltyLedgerCorrupt');
}

function rejected(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RedemptionRejected) return err.reason;
    throw err;
  }
  throw new Error('kỳ vọng RedemptionRejected');
}

describe('replayLots', () => {
  it('sổ rỗng → không có lô, 0 điểm', () => {
    expect(replayLots([], AS_OF)).toEqual({
      lots: [],
      total: 0,
      livePoints: 0,
      expiredUnwritten: 0,
    });
  });

  it('lô đã hết hạn không tính vào điểm sống; mốc biên expiresAt = asOf là chết', () => {
    const s = replayLots(
      rows(earn(100, 1, day(50)), earn(200, 2, AS_OF), earn(300, 3, day(101))),
      AS_OF,
    );
    expect(s.livePoints).toBe(300);
    expect(s.expiredUnwritten).toBe(300);
    expect(s.total).toBe(600);
  });

  it('gộp các earn trùng hạn thành một lô; lô sắp theo hạn (FIFO)', () => {
    const s = replayLots(
      rows(earn(50, 1, day(300)), earn(10, 2, day(200)), earn(40, 1, day(300))),
      AS_OF,
    );
    expect(s.lots.map((l) => [l.lotId, l.earned, l.remaining])).toEqual([
      [2, 10, 10],
      [1, 90, 90],
    ]);
  });

  it('earn 0 điểm vẫn hợp lệ (WP3 ghi earn 0 cho phiên 0 đồng)', () => {
    expect(replayLots(rows(earn(0, 1, day(200))), AS_OF).total).toBe(0);
  });

  it('redeem / restore / expire / adjust 0 đổi phần còn lại đúng lô', () => {
    const s = replayLots(
      rows(
        earn(500, 1, day(150)),
        earn(500, 2, day(250)),
        redeem(500, 1, day(150), 9),
        redeem(100, 2, day(250), 9),
        adjust(0, 9),
        restore(30, 2, day(250), 9),
        expire(20, 2, day(250)),
      ),
      AS_OF,
    );
    expect(s.lots.map((l) => l.remaining)).toEqual([0, 410]);
    expect(s.total).toBe(410);
  });

  it('expire không có hạn (đóng tài khoản, D6 g) trừ FIFO mọi lô', () => {
    const s = replayLots(
      rows(earn(100, 1, day(50)), earn(200, 2, day(150)), expire(300, null, null)),
      AS_OF,
    );
    expect(s.lots.map((l) => l.remaining)).toEqual([0, 0]);
    expect(s.total).toBe(0);
  });

  describe('dòng sai dạng → LoyaltyLedgerCorrupt', () => {
    it.each([
      ['adjust ≠ 0', [earn(100, 1, day(200)), adjust(-5, 9)], 'unsupported_adjust', 2],
      [
        'earn thiếu hạn',
        [{ ...earn(100, 1, day(200)), expiresAt: null, lotId: null }],
        'missing_expires_at',
        1,
      ],
      [
        'redeem thiếu hạn',
        [earn(100, 1, day(200)), { ...redeem(10, 1, day(200), 9), expiresAt: null, lotId: null }],
        'missing_expires_at',
        2,
      ],
      [
        'redeem lô không có',
        [earn(100, 1, day(200)), { ...redeem(10, 1, day(201), 9), lotId: null }],
        'unknown_lot',
        2,
      ],
      [
        'redeem trước earn của lô',
        [redeem(10, 1, day(200), 9), earn(100, 1, day(200))],
        'unknown_lot',
        1,
      ],
      ['redeem quá lô', [earn(100, 1, day(200)), redeem(101, 1, day(200), 9)], 'lot_overdrawn', 2],
      [
        'restore quá phần đã earn',
        [earn(100, 1, day(200)), restore(1, 1, day(200), 9)],
        'lot_overdrawn',
        2,
      ],
      ['expire quá lô', [earn(100, 1, day(50)), expire(101, 1, day(50))], 'lot_overdrawn', 2],
      [
        'expire NULL quá tổng',
        [earn(100, 1, day(50)), expire(101, null, null)],
        'lot_overdrawn',
        2,
      ],
      ['earn âm', [earn(-1, 1, day(200))], 'invalid_points', 1],
      [
        'redeem dương',
        [earn(100, 1, day(200)), { ...redeem(10, 1, day(200), 9), points: 10 }],
        'invalid_points',
        2,
      ],
      [
        'restore âm',
        [earn(100, 1, day(200)), { ...restore(10, 1, day(200), 9), points: -10 }],
        'invalid_points',
        2,
      ],
      ['expire 0', [earn(100, 1, day(50)), expire(0, 1, day(50))], 'invalid_points', 2],
    ] as const)('%s', (_name, specs, reason, entryNo) => {
      const err = corrupt(() => replayLots(rows(...(specs as unknown as LoyaltyRow[])), AS_OF));
      expect(err.reason).toBe(reason);
      expect(err.entryNo).toBe(entryNo);
    });
  });
});

describe('planRedeem (FIFO, chỉ lô còn sống)', () => {
  const lotsOf = (...specs: Omit<LoyaltyRow, 'entryNo'>[]) =>
    replayLots(rows(...specs), AS_OF).lots;

  it('tiêu lô cũ nhất trước, qua nhiều lô', () => {
    const lots = lotsOf(earn(300, 1, day(300)), earn(200, 2, day(150)), earn(400, 3, day(200)));
    expect(planRedeem(lots, AS_OF, 550)).toEqual({
      parts: [
        { lotId: 2, points: 200 },
        { lotId: 3, points: 350 },
      ],
      shortfall: 0,
    });
  });

  it('bỏ qua lô đã hết hạn (dù chưa có dòng expire); thiếu thì shortfall', () => {
    const lots = lotsOf(earn(400, 1, day(50)), earn(300, 2, day(200)));
    expect(planRedeem(lots, AS_OF, 600)).toEqual({
      parts: [{ lotId: 2, points: 300 }],
      shortfall: 300,
    });
  });

  it('lô đã redeem một phần chỉ còn phần còn lại', () => {
    const lots = lotsOf(
      earn(400, 1, day(150)),
      redeem(350, 1, day(150), 7),
      earn(300, 2, day(200)),
    );
    expect(planRedeem(lots, AS_OF, 100).parts).toEqual([
      { lotId: 1, points: 50 },
      { lotId: 2, points: 50 },
    ]);
  });

  it('không còn điểm sống → không có phần nào, thiếu toàn bộ', () => {
    expect(planRedeem(lotsOf(earn(400, 1, day(50))), AS_OF, 500)).toEqual({
      parts: [],
      shortfall: 500,
    });
  });
});

describe('planRestore (về đúng lô, −Σ redeem − đã restore)', () => {
  it('trả theo từng lô của top-up, không đụng top-up khác', () => {
    const r = rows(
      earn(300, 1, day(150)),
      earn(300, 2, day(200)),
      redeem(300, 1, day(150), 7),
      redeem(100, 2, day(200), 7),
      adjust(0, 7),
      redeem(50, 2, day(200), 8),
    );
    expect(planRestore(r, 7)).toEqual([
      { lotId: 1, points: 300 },
      { lotId: 2, points: 100 },
    ]);
  });

  it('trừ phần đã restore; đã trả hết thì rỗng', () => {
    const r = rows(
      earn(300, 1, day(150)),
      earn(300, 2, day(200)),
      redeem(300, 1, day(150), 7),
      redeem(100, 2, day(200), 7),
      restore(300, 1, day(150), 7),
    );
    expect(planRestore(r, 7)).toEqual([{ lotId: 2, points: 100 }]);
    const done = [...r, { ...restore(100, 2, day(200), 7), entryNo: 6 }];
    expect(planRestore(done, 7)).toEqual([]);
  });

  it('top-up chỉ có adjust 0 (điểm đã hết hạn hết) → không trả gì', () => {
    expect(planRestore(rows(earn(300, 1, day(50)), adjust(0, 7)), 7)).toEqual([]);
  });
});

describe('planExpiry', () => {
  it('chỉ trừ phần còn sống của lô đã hết hạn (lô đã redeem một phần)', () => {
    const s = replayLots(
      rows(
        earn(500, 1, day(50)),
        redeem(320, 1, day(50), 7),
        earn(200, 2, day(80)),
        earn(900, 3, day(200)),
      ),
      AS_OF,
    );
    expect(planExpiry(s.lots, AS_OF)).toEqual([
      { lotId: 1, points: 180 },
      { lotId: 2, points: 200 },
    ]);
  });

  it('chạy lại sau khi đã ghi expire → rỗng', () => {
    const s = replayLots(rows(earn(500, 1, day(50)), expire(500, 1, day(50))), AS_OF);
    expect(planExpiry(s.lots, AS_OF)).toEqual([]);
  });

  it('restore vào lô đã hết hạn → lại có phần để expire', () => {
    const s = replayLots(
      rows(earn(500, 1, day(50)), redeem(500, 1, day(50), 7), restore(500, 1, day(50), 7)),
      AS_OF,
    );
    expect(planExpiry(s.lots, AS_OF)).toEqual([{ lotId: 1, points: 500 }]);
  });
});

describe('pointsExpiringBy', () => {
  it('điểm còn sống của các lô hết hạn trong (asOf, until]', () => {
    const s = replayLots(
      rows(
        earn(100, 1, day(50)),
        earn(200, 2, day(110)),
        earn(300, 3, day(130)),
        earn(400, 4, day(131)),
      ),
      AS_OF,
    );
    expect(pointsExpiringBy(s.lots, AS_OF, day(130))).toBe(500);
  });
});

describe('computeQuote (BR-P35)', () => {
  it('ngưỡng 500 điểm còn sống', () => {
    expect(rejected(() => computeQuote(499, 1_000_000))).toBe('below_minimum');
    expect(computeQuote(500, 1_000_000)).toEqual({
      points: 500,
      discountVnd: 5_000,
      amountPaidVnd: 995_000,
    });
  });

  it('dùng tối đa = min(điểm sống, trần 50 %); 1 điểm = 10 VND', () => {
    expect(computeQuote(3_000, 50_000)).toEqual({
      points: 2_500,
      discountVnd: 25_000,
      amountPaidVnd: 25_000,
    });
    expect(computeQuote(1_234, 1_000_000).points).toBe(1_234);
  });

  it('số tiền lẻ: trần làm tròn xuống, giảm không quá 50 %', () => {
    const q = computeQuote(10_000, 50_019);
    expect(q.points).toBe(2_500);
    expect(q.discountVnd * 2).toBeLessThanOrEqual(50_019);
  });

  it('không bắt bội số 100', () => {
    expect(computeQuote(10_000, 1_000_000, 537)).toEqual({
      points: 537,
      discountVnd: 5_370,
      amountPaidVnd: 994_630,
    });
  });

  it('requestedPoints: < 500, > điểm sống, > trần', () => {
    expect(rejected(() => computeQuote(10_000, 1_000_000, 499))).toBe('below_minimum');
    expect(rejected(() => computeQuote(800, 1_000_000, 801))).toBe('insufficient_points');
    expect(rejected(() => computeQuote(3_000, 50_000, 2_501))).toBe('exceeds_cap');
    expect(computeQuote(3_000, 50_000, 2_500).points).toBe(2_500);
  });

  it('trần quá nhỏ để đạt 500 điểm → exceeds_cap', () => {
    expect(rejected(() => computeQuote(10_000, 9_999))).toBe('exceeds_cap');
  });

  it('đầu vào sai', () => {
    for (const a of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(rejected(() => computeQuote(1_000, a))).toBe('invalid_amount');
    }
    for (const p of [0, -500, 500.5]) {
      expect(rejected(() => computeQuote(1_000, 1_000_000, p))).toBe('invalid_points');
    }
  });
});
