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
