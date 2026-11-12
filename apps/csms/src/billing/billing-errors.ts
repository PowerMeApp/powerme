/**
 * Lỗi của sổ cái billing (T32 Phần 3).
 *
 * Mọi lỗi ở đây ném ra **trước** khi có câu SQL nào thất bại, nên transaction của bên gọi vẫn dùng
 * được (không bị Postgres đánh dấu aborted như khi gặp 23505).
 */

/** Dòng sổ cái credit trả về cho bên gọi (`post`, hoặc dòng cũ trong `LedgerEntryExists`). */
export interface LedgerEntry {
  id: number;
  creditAccountId: number;
  entryNo: number;
  transactionType: string;
  amountVnd: number;
  balanceAfterVnd: number;
  topUpId: number | null;
  sessionId: number | null;
}

export class CreditAccountNotFound extends Error {
  constructor(readonly accountId: number) {
    super(`credit_account_not_found: ${accountId}`);
    this.name = 'CreditAccountNotFound';
  }
}

export type LedgerRejectReason =
  /** Tài khoản closed chỉ nhận refund / adjustment (D6). */
  | 'account_closed'
  /** Không phải safe integer, hoặc sai dấu theo loại dòng. */
  | 'invalid_amount'
  /** Thiếu tham chiếu mà CHECK của bảng bắt buộc (top_up_id, session_id, reservation_id). */
  | 'missing_reference'
  /** top-up / phiên không thuộc tài khoản này. */
  | 'reference_mismatch'
  /** Ghi lên tài khoản closed làm số dư âm. */
  | 'closed_account_overdraw';

export class LedgerPostRejected extends Error {
  constructor(readonly reason: LedgerRejectReason) {
    super(`ledger_post_rejected: ${reason}`);
    this.name = 'LedgerPostRejected';
  }
}

/** Lý do từ chối dùng điểm cho top-up (BR-P35, `quoteRedemption`). */
export type RedemptionRejectReason =
  /** `amountVnd` không phải safe integer > 0. */
  | 'invalid_amount'
  /** `requestedPoints` không phải số nguyên > 0. */
  | 'invalid_points'
  /** Điểm còn sống < 500, hoặc số điểm yêu cầu < 500. */
  | 'below_minimum'
  /** Số điểm yêu cầu vượt điểm còn sống. */
  | 'insufficient_points'
  /** Vượt trần 50 % số tiền nạp (hoặc trần quá nhỏ để đạt 500 điểm). */
  | 'exceeds_cap';

export class RedemptionRejected extends Error {
  constructor(readonly reason: RedemptionRejectReason) {
    super(`redemption_rejected: ${reason}`);
    this.name = 'RedemptionRejected';
  }
}

/**
 * Mã từ chối tạo / đọc top-up (T32 Phần 5, SD-2a, D2). Route đổi sang HTTP
 * (`driver/top-ups.http.ts`); mã là giá trị `error` của hợp đồng driver (snake_case).
 */
export type TopUpRejectCode =
  /** Cùng Idempotency-Key, body khác (hoặc dòng không tạo qua API, `request_hash` NULL). → 409 */
  | 'idempotency_conflict'
  /** Tài khoản credit đã đóng (D6). → 409 */
  | 'account_closed'
  /** Còn top-up pending chưa quá `expires_at`; kèm `topUpId`, `paymentUrl`. → 409 */
  | 'top_up_pending'
  /** Còn top-up pending đã quá `expires_at`, đang chờ querydr chốt (D4 ⊕); kèm `topUpId`. → 409 */
  | 'pending_top_up_confirming'
  /** BR-P22: mỗi lần nạp 50.000–2.000.000 VND. → 422 */
  | 'amount_out_of_range'
  /** BR-P22: số dư + số nạp > 5.000.000 VND. → 422 */
  | 'balance_limit_exceeded'
  /** BR-P35: điểm còn sống < 500 hoặc số điểm xin < 500. → 422 */
  | 'points_below_minimum'
  /** BR-P35: xin nhiều hơn điểm còn sống. → 422 */
  | 'points_unavailable'
  /** BR-P35: vượt trần 50 % số tiền nạp. → 422 */
  | 'points_exceed_cap'
  /** Thiếu VNPAY_TMN_CODE / VNPAY_HASH_SECRET. → 503 */
  | 'payment_unconfigured'
  /** Không có top-up này, hoặc của tài xế khác. → 404 */
  | 'not_found';

export class TopUpRejected extends Error {
  constructor(
    readonly code: TopUpRejectCode,
    readonly extra: { topUpId?: number; paymentUrl?: string } = {},
  ) {
    super(`top_up_rejected: ${code}`);
    this.name = 'TopUpRejected';
  }
}

/** Lý do sổ điểm không phát lại được theo lô (`loyalty-lots.ts`). */
export type LoyaltyCorruptReason =
  /** Sai dấu theo loại dòng (earn ≥ 0, redeem < 0, restore > 0, expire < 0). */
  | 'invalid_points'
  /** earn / redeem / restore thiếu `expires_at`. */
  | 'missing_expires_at'
  /** `expires_at` không khớp lô earn nào đã có trước đó. */
  | 'unknown_lot'
  /** Lô bị trừ quá phần còn lại, hoặc trả quá phần đã earn. */
  | 'lot_overdrawn'
  /** `adjust` khác 0 — chưa có quy tắc phát lại (BR-P37 sẽ cần). */
  | 'unsupported_adjust'
  /** `loyalty_accounts.points_balance` ≠ Σ `points`. */
  | 'balance_mismatch';

/**
 * Sổ điểm có dòng không đúng dạng hoặc lệch snapshot. Ném trước mọi câu ghi; không đoán cách sửa.
 */
export class LoyaltyLedgerCorrupt extends Error {
  constructor(
    readonly reason: LoyaltyCorruptReason,
    readonly entryNo: number | null = null,
  ) {
    super(`loyalty_ledger_corrupt: ${reason}${entryNo === null ? '' : ` (entry_no=${entryNo})`}`);
    this.name = 'LoyaltyLedgerCorrupt';
  }
}

export class LoyaltyAccountNotFound extends Error {
  constructor(readonly loyaltyAccountId: number) {
    super(`loyalty_account_not_found: ${loyaltyAccountId}`);
    this.name = 'LoyaltyAccountNotFound';
  }
}

/**
 * Đã có dòng sổ cái cho cùng top-up + loại, hoặc cùng phiên (session_debit / earn). Bên gọi cần
 * idempotent thì dùng `existing`.
 */
export class LedgerEntryExists extends Error {
  constructor(
    readonly existing: { id: number; entryNo: number },
    readonly constraint: string,
  ) {
    super(`ledger_entry_exists: ${constraint} (id=${existing.id})`);
    this.name = 'LedgerEntryExists';
  }
}
