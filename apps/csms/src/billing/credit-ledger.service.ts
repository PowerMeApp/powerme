/**
 * CreditLedgerService — điểm ghi sổ cái credit duy nhất của billing (T32 Phần 3, CD-2).
 *
 * Vì sao tồn tại: bất biến `credit_accounts.balance_vnd = Σ credit_transactions.amount_vnd` chỉ giữ
 * được khi mọi dòng sổ đi qua một chỗ: khoá ví `FOR UPDATE`, tính `entry_no` và
 * `balance_after_vnd`, INSERT dòng sổ và UPDATE snapshot trong **cùng transaction của bên gọi**.
 * DB không có CHECK dấu tiền theo loại dòng, nên `post` kiểm ở đây.
 *
 * Quy ước:
 * - `post` / `earnForSession` nhận client của transaction bên gọi và **không tự BEGIN/COMMIT**.
 *   Gọi trên Pool (ngoài transaction) thì `FOR UPDATE` vô nghĩa.
 * - Thứ tự khoá: `top_ups` → `credit_accounts` → `loyalty_accounts`. `post` chỉ khoá
 *   `credit_accounts`; bên gọi nào khoá `top_ups` thì khoá trước khi gọi `post`.
 * - Mọi lỗi nghiệp vụ ném ra trước khi có câu SQL lỗi, nên transaction của bên gọi vẫn dùng được.
 * - SQL thô; mọi UPDATE ghi `updated_at = now()` (test quét mã nguồn của 0014).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import {
  CreditAccountNotFound,
  LedgerEntry,
  LedgerEntryExists,
  LedgerPostRejected,
} from './billing-errors.js';

/** Client của transaction bên gọi (pg thuần, cùng kiểu WP3 dùng trong `chargeTransaction`). */
export type LedgerClient = Pick<PoolClient, 'query'>;

export type CreditTransactionType =
  'top_up' | 'session_debit' | 'refund' | 'adjustment' | 'reservation_fee';

export type CreditAccountStatus = 'active' | 'in_shortfall' | 'closed';

export interface LedgerRef {
  topUpId?: number;
  sessionId?: number;
  /** Bắt buộc khi và chỉ khi `reservation_fee` (CHECK `credit_transactions_reservation_fee_check`). */
  reservationId?: number;
}

export interface PostedEntry extends LedgerEntry {
  /** Trạng thái tài khoản sau khi ghi. */
  status: CreditAccountStatus;
}

interface LedgerRow {
  id: string;
  credit_account_id: string;
  entry_no: string;
  transaction_type: string;
  amount_vnd: string;
  balance_after_vnd: string;
  top_up_id: string | null;
  session_id: string | null;
}

const LEDGER_COLUMNS =
  'id,credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd,top_up_id,session_id';

/** Dấu hợp lệ theo loại dòng (app-level; DB không có CHECK dấu). */
const SIGN_OK: Record<CreditTransactionType, (amount: number) => boolean> = {
  top_up: (a) => a > 0,
  // Cho phép 0: WP3 ghi session_debit cho phiên 0 đồng (charging_statements cần debit_id).
  session_debit: (a) => a <= 0,
  refund: (a) => a < 0,
  reservation_fee: (a) => a < 0,
  adjustment: (a) => a !== 0,
};

/** Tài khoản closed chỉ nhận các loại này (D6). */
const CLOSED_ALLOWED: ReadonlySet<CreditTransactionType> = new Set(['refund', 'adjustment']);

const nullableNumber = (v: string | null) => (v === null ? null : Number(v));

function toEntry(r: LedgerRow): LedgerEntry {
  return {
    id: Number(r.id),
    creditAccountId: Number(r.credit_account_id),
    entryNo: Number(r.entry_no),
    transactionType: r.transaction_type,
    amountVnd: Number(r.amount_vnd),
    balanceAfterVnd: Number(r.balance_after_vnd),
    topUpId: nullableNumber(r.top_up_id),
    sessionId: nullableNumber(r.session_id),
  };
}

const isId = (v: number | undefined): v is number => v !== undefined;

@Injectable()
export class CreditLedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Ghi một dòng sổ cái và cập nhật snapshot, trong transaction của bên gọi.
   *
   * @throws LedgerPostRejected sai dấu / thiếu tham chiếu / tham chiếu không thuộc tài khoản /
   *   tài khoản closed nhận loại không cho phép hoặc bị âm.
   * @throws CreditAccountNotFound
   * @throws LedgerEntryExists đã có dòng cùng (top-up, loại), session_debit cùng phiên, hoặc
   *   reservation_fee cùng reservation.
   */
  async post(
    tx: LedgerClient,
    accountId: number,
    type: CreditTransactionType,
    amountVnd: number,
    ref: LedgerRef = {},
  ): Promise<PostedEntry> {
    // 1. Kiểm đầu vào, chưa chạm DB.
    if (!Number.isSafeInteger(amountVnd) || !SIGN_OK[type](amountVnd)) {
      throw new LedgerPostRejected('invalid_amount');
    }
    if (
      (type === 'top_up' && !isId(ref.topUpId)) ||
      (type === 'session_debit' && !isId(ref.sessionId)) ||
      (type === 'reservation_fee') !== isId(ref.reservationId)
    ) {
      throw new LedgerPostRejected('missing_reference');
    }

    // 2. Khoá ví.
    const acc = (
      await tx.query<{ status: CreditAccountStatus; balance_vnd: string; driver_id: string }>(
        'SELECT status,balance_vnd,driver_id FROM credit_accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      )
    ).rows[0];
    if (!acc) throw new CreditAccountNotFound(accountId);
    const balance = Number(acc.balance_vnd) + amountVnd;
    if (!Number.isSafeInteger(balance)) throw new LedgerPostRejected('invalid_amount');

    // 3. Tài khoản closed (D6): chỉ refund / adjustment, chỉ số âm, không xuống dưới 0.
    if (acc.status === 'closed') {
      if (!CLOSED_ALLOWED.has(type)) throw new LedgerPostRejected('account_closed');
      if (amountVnd >= 0) throw new LedgerPostRejected('invalid_amount');
      if (balance < 0) throw new LedgerPostRejected('closed_account_overdraw');
    }

    // 4. Tham chiếu phải thuộc tài khoản này (đọc thường, không khoá).
    if (isId(ref.topUpId)) {
      const owner = (
        await tx.query<{ credit_account_id: string }>(
          'SELECT credit_account_id FROM top_ups WHERE id=$1',
          [ref.topUpId],
        )
      ).rows[0];
      if (!owner || Number(owner.credit_account_id) !== accountId) {
        throw new LedgerPostRejected('reference_mismatch');
      }
    }
    if (isId(ref.sessionId)) {
      const owned = await tx.query('SELECT 1 FROM sessions WHERE id=$1 AND driver_id=$2', [
        ref.sessionId,
        acc.driver_id,
      ]);
      if (!owned.rowCount) throw new LedgerPostRejected('reference_mismatch');
    }

    // 5. Kiểm trùng dưới khoá ví — top-up và phiên đều thuộc đúng một ví nên không có race.
    if (isId(ref.topUpId)) {
      const dup = (
        await tx.query<LedgerRow>(
          `SELECT ${LEDGER_COLUMNS} FROM credit_transactions WHERE top_up_id=$1 AND transaction_type=$2`,
          [ref.topUpId, type],
        )
      ).rows[0];
      if (dup) {
        throw new LedgerEntryExists(toEntry(dup), 'credit_transactions_one_per_top_up_and_type');
      }
    }
    if (type === 'session_debit') {
      const dup = (
        await tx.query<LedgerRow>(
          `SELECT ${LEDGER_COLUMNS} FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'`,
          [ref.sessionId],
        )
      ).rows[0];
      if (dup)
        throw new LedgerEntryExists(toEntry(dup), 'credit_transactions_one_debit_per_session');
    }
    if (type === 'reservation_fee') {
      // Unique reservation_id là toàn bảng; chưa kiểm reservation thuộc ví (chưa có bên gọi), nên
      // hai ví khác nhau cùng ghi phí cho một reservation vẫn chỉ được chặn bởi unique của DB.
      const dup = (
        await tx.query<LedgerRow>(
          `SELECT ${LEDGER_COLUMNS} FROM credit_transactions WHERE reservation_id=$1`,
          [ref.reservationId],
        )
      ).rows[0];
      if (dup) throw new LedgerEntryExists(toEntry(dup), 'credit_transactions_reservation_id_key');
    }

    // 6. Dòng sổ: entry_no = max + 1 trong ví (cùng cách WP3, an toàn nhờ khoá ở bước 2).
    const row = (
      await tx.query<LedgerRow>(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,
           balance_after_vnd,top_up_id,session_id,reservation_id)
         SELECT $1,coalesce(max(entry_no),0)+1,$2,$3,$4,$5,$6,$7 FROM credit_transactions
         WHERE credit_account_id=$1 RETURNING ${LEDGER_COLUMNS}`,
        [
          accountId,
          type,
          amountVnd,
          balance,
          ref.topUpId ?? null,
          ref.sessionId ?? null,
          ref.reservationId ?? null,
        ],
      )
    ).rows[0]!;

    // 7. Snapshot + trạng thái: closed giữ nguyên; còn lại âm → in_shortfall, ≥ 0 → active.
    const status: CreditAccountStatus =
      acc.status === 'closed' ? 'closed' : balance < 0 ? 'in_shortfall' : 'active';
    await tx.query(
      'UPDATE credit_accounts SET balance_vnd=$2,status=$3,updated_at=now() WHERE id=$1',
      [accountId, balance, status],
    );
    return { ...toEntry(row), status };
  }

  /** Số dư snapshot (`credit_accounts.balance_vnd`), không cộng lại sổ. */
  async getBalance(accountId: number, exec: LedgerClient = this.db.$client): Promise<number> {
    const row = (
      await exec.query<{ balance_vnd: string }>(
        'SELECT balance_vnd FROM credit_accounts WHERE id=$1',
        [accountId],
      )
    ).rows[0];
    if (!row) throw new CreditAccountNotFound(accountId);
    return Number(row.balance_vnd);
  }

  /**
   * Tạo ví credit + tài khoản loyalty cho tài xế nếu chưa có (idempotent, an toàn khi gọi song
   * song: ON CONFLICT chờ bên kia commit rồi bỏ qua). Trả id hai tài khoản.
   */
  async ensureAccounts(
    driverId: number,
    exec: LedgerClient = this.db.$client,
  ): Promise<{ creditAccountId: number; loyaltyAccountId: number }> {
    await exec.query(
      'INSERT INTO credit_accounts(driver_id) VALUES($1) ON CONFLICT (driver_id) DO NOTHING',
      [driverId],
    );
    await exec.query(
      'INSERT INTO loyalty_accounts(driver_id) VALUES($1) ON CONFLICT (driver_id) DO NOTHING',
      [driverId],
    );
    const row = (
      await exec.query<{ credit_id: string; loyalty_id: string }>(
        `SELECT c.id AS credit_id, l.id AS loyalty_id
         FROM credit_accounts c JOIN loyalty_accounts l ON l.driver_id = c.driver_id
         WHERE c.driver_id=$1`,
        [driverId],
      )
    ).rows[0]!;
    return { creditAccountId: Number(row.credit_id), loyaltyAccountId: Number(row.loyalty_id) };
  }
}
