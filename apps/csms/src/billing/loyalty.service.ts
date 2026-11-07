/**
 * LoyaltyService — sổ cái điểm thưởng (T32 Phần 3: `earnForSession`; Phần 4: phần nạp tiền).
 *
 * `earnForSession` làm đúng những gì `charge-settlement.service.ts` của WP3 đang làm bằng SQL thô
 * (tạo loyalty account khi thiếu, `entry_no = max + 1`, `expires_at = now() + N tháng`, cập nhật
 * `points_balance`), để WP3 thay bằng lời gọi này (D9). Khác WP3: gọi lặp cùng phiên trả dòng cũ
 * thay vì để unique `loyalty_transactions_one_earn_per_session` ném 23505.
 *
 * Chạy trong transaction của bên gọi, không tự BEGIN. Khoá `loyalty_accounts` → gọi **sau**
 * `CreditLedgerService.post` (thứ tự khoá `top_ups` → `credit_accounts` → `loyalty_accounts`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntryExists, LedgerPostRejected } from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import { LOYALTY_POLICY, LoyaltyPolicy } from './loyalty-policy.config.js';

export interface EarnResult {
  id: number;
  entryNo: number;
  /** false = phiên đã có dòng earn từ trước, không ghi gì thêm. */
  created: boolean;
}

@Injectable()
export class LoyaltyService {
  constructor(@Inject(LOYALTY_POLICY) private readonly policy: LoyaltyPolicy) {}

  /**
   * Ghi điểm `earn` cho một phiên sạc (một lần cho mỗi phiên).
   *
   * @param points số nguyên ≥ 0 (0 vẫn ghi dòng, như WP3: `charging_statements.loyalty_entry_id`
   *   bắt buộc).
   * @throws LedgerPostRejected `invalid_amount` | `reference_mismatch` (phiên không thuộc tài xế).
   * @throws LedgerEntryExists dòng earn của phiên nằm ở tài khoản khác (dữ liệu lệch).
   */
  async earnForSession(
    tx: LedgerClient,
    driverId: number,
    sessionId: number,
    points: number,
  ): Promise<EarnResult> {
    if (!Number.isSafeInteger(points) || points < 0) {
      throw new LedgerPostRejected('invalid_amount');
    }
    const owned = await tx.query('SELECT 1 FROM sessions WHERE id=$1 AND driver_id=$2', [
      sessionId,
      driverId,
    ]);
    if (!owned.rowCount) throw new LedgerPostRejected('reference_mismatch');

    await tx.query(
      'INSERT INTO loyalty_accounts(driver_id) VALUES($1) ON CONFLICT (driver_id) DO NOTHING',
      [driverId],
    );
    const accountId = Number(
      (
        await tx.query<{ id: string }>(
          'SELECT id FROM loyalty_accounts WHERE driver_id=$1 FOR UPDATE',
          [driverId],
        )
      ).rows[0]!.id,
    );

    const existing = (
      await tx.query<{ id: string; entry_no: string; loyalty_account_id: string }>(
        `SELECT id,entry_no,loyalty_account_id FROM loyalty_transactions
         WHERE session_id=$1 AND transaction_type='earn'`,
        [sessionId],
      )
    ).rows[0];
    if (existing) {
      const found = { id: Number(existing.id), entryNo: Number(existing.entry_no) };
      if (Number(existing.loyalty_account_id) !== accountId) {
        throw new LedgerEntryExists(found, 'loyalty_transactions_one_earn_per_session');
      }
      return { ...found, created: false };
    }

    const row = (
      await tx.query<{ id: string; entry_no: string }>(
        `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at,session_id)
         SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,now()+make_interval(months => $3),$4
         FROM loyalty_transactions WHERE loyalty_account_id=$1 RETURNING id,entry_no`,
        [accountId, points, this.policy.pointsExpiryMonths, sessionId],
      )
    ).rows[0]!;
    await tx.query(
      'UPDATE loyalty_accounts SET points_balance=points_balance+$2,updated_at=now() WHERE id=$1',
      [accountId, points],
    );
    return { id: Number(row.id), entryNo: Number(row.entry_no), created: true };
  }
}
