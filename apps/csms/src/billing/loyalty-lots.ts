/**
 * Điểm thưởng theo lô earn (T32 Phần 4; WF-02 decisions D3, D11; BR-P35, BR-P36).
 *
 * Vì sao tồn tại: schema không có cột nối `redeem` / `restore` / `expire` với dòng `earn`. Lô được
 * nhận diện bằng `expires_at`:
 * - mỗi dòng `earn` mở (hoặc cộng vào) lô có cùng `expires_at`;
 * - mỗi dòng `redeem` / `restore` / `expire` theo hạn ghi đúng **một** lô và mang `expires_at` của lô đó;
 * - `adjust` (`points = 0`, D3 ⊕) và `expire` lúc đóng tài khoản (D6 g) để `expires_at` NULL.
 *
 * `lotId` do SQL tính: `min(id)` của các dòng earn cùng `expires_at` trong tài khoản (so chính xác µs).
 * App không tự dựng lại timestamp từ `Date` (chỉ có ms) để ghi; service copy `expires_at` bằng SQL từ
 * dòng `lotId`. `Date` ở đây chỉ dùng để so với `asOf` và sắp FIFO.
 *
 * Phát lại theo `entry_no`. Dòng không đúng dạng → `LoyaltyLedgerCorrupt`, không đoán cách sửa. Đảo
 * điểm khi phiên bị sửa (BR-P37) chưa có quy tắc; ai làm thì mở rộng `applyRow`.
 *
 * Mọi hàm ở đây là thuần, không chạm DB.
 */
import { LoyaltyLedgerCorrupt, RedemptionRejected } from './billing-errors.js';

/** BR-P35: tối thiểu 500 điểm mỗi lần dùng. */
export const REDEEM_MIN_POINTS = 500;
/** BR-P35: 100 điểm = 1.000 VND. */
export const VND_PER_POINT = 10;
/** BR-P35: giảm tối đa 50 % số tiền nạp → trần điểm = floor(amountVnd / 2 / 10). */
const CAP_DIVISOR = 2 * VND_PER_POINT;

export type LoyaltyTransactionType = 'earn' | 'redeem' | 'restore' | 'expire' | 'adjust';

/** Một dòng `loyalty_transactions` đã đọc, kèm `lotId` SQL tính. */
export interface LoyaltyRow {
  entryNo: number;
  type: LoyaltyTransactionType;
  points: number;
  /** id dòng earn đầu tiên cùng `expires_at`; NULL khi không có hạn hoặc không khớp lô earn nào. */
  lotId: number | null;
  expiresAt: Date | null;
  topUpId: number | null;
}

export interface Lot {
  lotId: number;
  expiresAt: Date;
  /** Σ earn của lô (trần cho restore). */
  earned: number;
  remaining: number;
}

export interface LotState {
  /** Mọi lô, cũ nhất trước (theo hạn, hoà thì theo lotId). */
  lots: Lot[];
  /** Σ points mọi dòng (phải bằng `points_balance`). */
  total: number;
  /** Điểm còn sống lúc `asOf` (lô có `expiresAt > asOf`). Dùng cái này để hiển thị / quote. */
  livePoints: number;
  /** Phần còn lại của lô đã hết hạn mà chưa có dòng `expire`. */
  expiredUnwritten: number;
}

export interface LotPart {
  lotId: number;
  points: number;
}

export interface Quote {
  points: number;
  discountVnd: number;
  amountPaidVnd: number;
}

const isAlive = (lot: Lot, asOf: Date) => lot.expiresAt.getTime() > asOf.getTime();

const fifo = (a: Lot, b: Lot) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.lotId - b.lotId;

/** Lô mà dòng redeem / restore / expire có hạn trỏ tới; thiếu → lỗi. */
function lotOf(lots: Map<number, Lot>, row: LoyaltyRow): Lot {
  if (row.expiresAt === null) throw new LoyaltyLedgerCorrupt('missing_expires_at', row.entryNo);
  const lot = row.lotId === null ? undefined : lots.get(row.lotId);
  if (!lot) throw new LoyaltyLedgerCorrupt('unknown_lot', row.entryNo);
  return lot;
}

function applyRow(lots: Map<number, Lot>, row: LoyaltyRow): void {
  const bad = () => new LoyaltyLedgerCorrupt('invalid_points', row.entryNo);
  switch (row.type) {
    case 'earn': {
      if (row.points < 0) throw bad();
      if (row.expiresAt === null || row.lotId === null) {
        throw new LoyaltyLedgerCorrupt('missing_expires_at', row.entryNo);
      }
      const lot = lots.get(row.lotId);
      if (lot) {
        lot.earned += row.points;
        lot.remaining += row.points;
      } else {
        lots.set(row.lotId, {
          lotId: row.lotId,
          expiresAt: row.expiresAt,
          earned: row.points,
          remaining: row.points,
        });
      }
      return;
    }
    case 'redeem': {
      if (row.points >= 0) throw bad();
      const lot = lotOf(lots, row);
      if (lot.remaining + row.points < 0) {
        throw new LoyaltyLedgerCorrupt('lot_overdrawn', row.entryNo);
      }
      lot.remaining += row.points;
      return;
    }
    case 'restore': {
      if (row.points <= 0) throw bad();
      const lot = lotOf(lots, row);
      if (lot.remaining + row.points > lot.earned) {
        throw new LoyaltyLedgerCorrupt('lot_overdrawn', row.entryNo);
      }
      lot.remaining += row.points;
      return;
    }
    case 'expire': {
      if (row.points >= 0) throw bad();
      if (row.expiresAt === null) {
        // Đóng tài khoản (D6 g): trừ FIFO mọi lô.
        let need = -row.points;
        for (const lot of [...lots.values()].sort(fifo)) {
          const take = Math.min(lot.remaining, need);
          lot.remaining -= take;
          need -= take;
        }
        if (need > 0) throw new LoyaltyLedgerCorrupt('lot_overdrawn', row.entryNo);
        return;
      }
      const lot = lotOf(lots, row);
      if (lot.remaining + row.points < 0) {
        throw new LoyaltyLedgerCorrupt('lot_overdrawn', row.entryNo);
      }
      lot.remaining += row.points;
      return;
    }
    case 'adjust':
      if (row.points !== 0) throw new LoyaltyLedgerCorrupt('unsupported_adjust', row.entryNo);
      return;
  }
}

/** Phát lại sổ điểm của một tài khoản (theo `entry_no`) → các lô tại `asOf`. */
export function replayLots(rows: readonly LoyaltyRow[], asOf: Date): LotState {
  const lots = new Map<number, Lot>();
  let total = 0;
  for (const row of [...rows].sort((a, b) => a.entryNo - b.entryNo)) {
    applyRow(lots, row);
    total += row.points;
  }
  const sorted = [...lots.values()].sort(fifo);
  let livePoints = 0;
  let expiredUnwritten = 0;
  for (const lot of sorted) {
    if (isAlive(lot, asOf)) livePoints += lot.remaining;
    else expiredUnwritten += lot.remaining;
  }
  return { lots: sorted, total, livePoints, expiredUnwritten };
}

/** Điểm còn sống lúc `asOf` sẽ hết hạn tới `until` (UC-PAY-04 "sắp hết hạn"). */
export function pointsExpiringBy(lots: readonly Lot[], asOf: Date, until: Date): number {
  return lots
    .filter((l) => isAlive(l, asOf) && l.expiresAt.getTime() <= until.getTime())
    .reduce((s, l) => s + l.remaining, 0);
}

/** Tiêu `points` từ các lô còn sống, cũ nhất trước. Thiếu → `shortfall` (D3 ⊕ ghi `adjust` 0). */
export function planRedeem(
  lots: readonly Lot[],
  asOf: Date,
  points: number,
): { parts: LotPart[]; shortfall: number } {
  const parts: LotPart[] = [];
  let need = points;
  for (const lot of [...lots].sort(fifo)) {
    if (need === 0) break;
    if (!isAlive(lot, asOf) || lot.remaining === 0) continue;
    const take = Math.min(lot.remaining, need);
    parts.push({ lotId: lot.lotId, points: take });
    need -= take;
  }
  return { parts, shortfall: need };
}

/**
 * Phần cần trả lại cho top-up, theo từng lô: −Σ redeem − Σ restore đã có (D3 ⊕; không theo
 * `points_redeemed`). Thứ tự theo lần đầu gặp lô trong sổ.
 */
export function planRestore(rows: readonly LoyaltyRow[], topUpId: number): LotPart[] {
  const owed = new Map<number, number>();
  for (const row of [...rows].sort((a, b) => a.entryNo - b.entryNo)) {
    if (row.topUpId !== topUpId || row.lotId === null) continue;
    if (row.type === 'redeem' || row.type === 'restore') {
      owed.set(row.lotId, (owed.get(row.lotId) ?? 0) - row.points);
    }
  }
  return [...owed].filter(([, points]) => points > 0).map(([lotId, points]) => ({ lotId, points }));
}

/** Phần còn lại của các lô đã hết hạn tới `asOf` (D11). Đã ghi expire rồi thì rỗng. */
export function planExpiry(lots: readonly Lot[], asOf: Date): LotPart[] {
  return [...lots]
    .sort(fifo)
    .filter((l) => !isAlive(l, asOf) && l.remaining > 0)
    .map((l) => ({ lotId: l.lotId, points: l.remaining }));
}

/** Kiểm đầu vào của quote (không cần điểm), để service ném trước khi chạm DB. */
export function validateQuoteInput(amountVnd: number, requestedPoints?: number): void {
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) {
    throw new RedemptionRejected('invalid_amount');
  }
  if (
    requestedPoints !== undefined &&
    (!Number.isSafeInteger(requestedPoints) || requestedPoints <= 0)
  ) {
    throw new RedemptionRejected('invalid_points');
  }
}

/**
 * BR-P35: ≥ 500 điểm, giảm ≤ 50 % `amountVnd`, 1 điểm = 10 VND, chỉ điểm còn sống.
 * `requestedPoints` bỏ trống = dùng tối đa. Không bắt bội số 100.
 *
 * @throws RedemptionRejected
 */
export function computeQuote(
  livePoints: number,
  amountVnd: number,
  requestedPoints?: number,
): Quote {
  validateQuoteInput(amountVnd, requestedPoints);
  if (livePoints < REDEEM_MIN_POINTS) throw new RedemptionRejected('below_minimum');
  const cap = Math.floor(amountVnd / CAP_DIVISOR);

  let points: number;
  if (requestedPoints === undefined) {
    points = Math.min(livePoints, cap);
    if (points < REDEEM_MIN_POINTS) throw new RedemptionRejected('exceeds_cap');
  } else {
    if (requestedPoints < REDEEM_MIN_POINTS) throw new RedemptionRejected('below_minimum');
    if (requestedPoints > livePoints) throw new RedemptionRejected('insufficient_points');
    if (requestedPoints > cap) throw new RedemptionRejected('exceeds_cap');
    points = requestedPoints;
  }
  const discountVnd = points * VND_PER_POINT;
  return { points, discountVnd, amountPaidVnd: amountVnd - discountVnd };
}
