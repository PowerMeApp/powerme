/**
 * LoyaltyService — sổ cái điểm thưởng (T32 Phần 3: `earnForSession`; Phần 4: phần nạp tiền).
 *
 * `earnForSession` làm đúng những gì `charge-settlement.service.ts` của WP3 đang làm bằng SQL thô
 * (tạo loyalty account khi thiếu, `entry_no = max + 1`, `expires_at = now() + N tháng`, cập nhật
 * `points_balance`), để WP3 thay bằng lời gọi này (D9). Khác WP3: gọi lặp cùng phiên trả dòng cũ
 * thay vì để unique `loyalty_transactions_one_earn_per_session` ném 23505.
 *
 * Phần 4 (D3, D11; BR-P35–P37): `quoteRedemption`, `redeemForTopUp`, `restoreForTopUp`,
 * `expireDueForAccount`. Điểm tính theo lô earn (`loyalty-lots.ts`): mỗi dòng redeem / restore /
 * expire ghi đúng một lô và mang `expires_at` của lô đó, **copy bằng SQL** từ dòng earn của lô (JS
 * `Date` mất phần µs). Bất biến `points_balance = Σ points ≥ 0` được kiểm dưới khoá trước khi ghi.
 *
 * Chạy trong transaction của bên gọi, không tự BEGIN. Khoá `loyalty_accounts` → gọi **sau**
 * `CreditLedgerService.post` (thứ tự khoá `top_ups` → `credit_accounts` → `loyalty_accounts`).
 * Lỗi nghiệp vụ ném trước mọi câu ghi.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  LedgerEntryExists,
  LedgerPostRejected,
  LoyaltyAccountNotFound,
  LoyaltyLedgerCorrupt,
} from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import {
  computeQuote,
  LotPart,
  LoyaltyRow,
  LoyaltyTransactionType,
  planExpiry,
  planRedeem,
  planRestore,
  Quote,
  replayLots,
  validateQuoteInput,
} from './loyalty-lots.js';
import { LOYALTY_POLICY, LoyaltyPolicy } from './loyalty-policy.config.js';

export interface EarnResult {
  id: number;
  entryNo: number;
  /** false = phiên đã có dòng earn từ trước, không ghi gì thêm. */
  created: boolean;
}

/** Một dòng loyalty vừa ghi (hoặc dòng cũ khi gọi lặp). */
export interface LoyaltyEntry {
  id: number;
  entryNo: number;
  type: LoyaltyTransactionType;
  points: number;
  expiresAt: Date | null;
}

export interface RedeemResult {
  /** false = top-up không dùng điểm, hoặc đã trừ từ trước (`entries` là dòng cũ). */
  created: boolean;
  redeemedPoints: number;
  /** Điểm thiếu lúc cộng tiền (đã hết hạn / bị top-up khác tiêu), ghi bằng `adjust` 0 (D3 ⊕). */
  shortfallPoints: number;
  entries: LoyaltyEntry[];
}

export interface RestoreResult {
  /** false = không còn gì để trả (chưa redeem, hoặc đã trả). */
  created: boolean;
  restoredPoints: number;
  /** Điểm của lô đã hết hạn bị expire ngay sau khi trả (câu c, D11). */
  expiredPoints: number;
  entries: LoyaltyEntry[];
}

export interface ExpireResult {
  expiredPoints: number;
  entries: LoyaltyEntry[];
}

interface RawRow {
  entry_no: string;
  transaction_type: LoyaltyTransactionType;
  points: string;
  expires_at: Date | null;
  top_up_id: string | null;
  lot_id: string | null;
}

interface EntryRow {
  id: string;
  entry_no: string;
  transaction_type: LoyaltyTransactionType;
  points: string;
  expires_at: Date | null;
}

const nullableNumber = (v: string | null) => (v === null ? null : Number(v));

const toEntry = (r: EntryRow): LoyaltyEntry => ({
  id: Number(r.id),
  entryNo: Number(r.entry_no),
  type: r.transaction_type,
  points: Number(r.points),
  expiresAt: r.expires_at,
});

/** Trạng thái tài khoản đã khoá + sổ đã đọc trong cùng transaction. */
interface Locked {
  accountId: number;
  rows: LoyaltyRow[];
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

  /**
   * Báo giá dùng điểm cho top-up (BR-P35). Chỉ đọc, không khoá, không trừ: số thật trừ lúc cộng
   * tiền (`redeemForTopUp`), thiếu thì ghi `adjust` (D3 ⊕). Chỉ tính điểm còn sống lúc `asOf`.
   *
   * @param opts.requestedPoints bỏ trống = dùng tối đa (min(điểm sống, trần 50 %)).
   * @param opts.asOf mặc định `now()` của DB.
   * @throws RedemptionRejected
   */
  async quoteRedemption(
    exec: LedgerClient,
    driverId: number,
    amountVnd: number,
    opts: { requestedPoints?: number; asOf?: Date } = {},
  ): Promise<Quote> {
    validateQuoteInput(amountVnd, opts.requestedPoints);
    const asOf = opts.asOf ?? (await this.dbNow(exec));
    const acc = (
      await exec.query<{ id: string }>('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [
        driverId,
      ])
    ).rows[0];
    const live = acc ? replayLots(await this.loadRows(exec, Number(acc.id)), asOf).livePoints : 0;
    return computeQuote(live, amountVnd, opts.requestedPoints);
  }

  /**
   * Trừ điểm đã dùng cho top-up, lúc cộng tiền (SD-2b, D3; gọi sau `CreditLedgerService.post`,
   * bên gọi đã khoá `top_ups`). FIFO theo lô còn sống; thiếu (đã hết hạn / bị top-up khác tiêu) →
   * redeem phần có + một dòng `adjust` `points = 0` cho top-up. Không ném vì thiếu điểm.
   * Gọi lặp cùng top-up → không ghi thêm.
   *
   * @throws LedgerPostRejected `reference_mismatch` (top-up không có / không thuộc tài xế).
   * @throws LoyaltyLedgerCorrupt sổ điểm sai dạng hoặc lệch snapshot.
   */
  async redeemForTopUp(
    tx: LedgerClient,
    driverId: number,
    topUpId: number,
    asOf?: Date,
  ): Promise<RedeemResult> {
    const pointsRedeemed = await this.ownedTopUpPoints(tx, driverId, topUpId);
    if (pointsRedeemed === 0) {
      return { created: false, redeemedPoints: 0, shortfallPoints: 0, entries: [] };
    }
    const locked = await this.lockOrCreate(tx, driverId);

    // Kiểm trùng dưới khoá (không có unique trong DB cho redeem/adjust theo top-up).
    const existing = await this.entriesOf(tx, locked.accountId, topUpId, ['redeem', 'adjust']);
    if (existing.length) {
      const redeemed = -existing.reduce((s, e) => s + (e.type === 'redeem' ? e.points : 0), 0);
      return {
        created: false,
        redeemedPoints: redeemed,
        shortfallPoints: pointsRedeemed - redeemed,
        entries: existing,
      };
    }

    const at = asOf ?? (await this.dbNow(tx));
    const state = this.replayChecked(locked, at);
    const { parts, shortfall } = planRedeem(state.lots, at, pointsRedeemed);
    const writes: Write[] = parts.map((p) => ({
      type: 'redeem',
      points: -p.points,
      lotId: p.lotId,
      topUpId,
    }));
    if (shortfall > 0) writes.push({ type: 'adjust', points: 0, lotId: null, topUpId });
    const entries = await this.write(tx, locked, writes);
    return {
      created: true,
      redeemedPoints: pointsRedeemed - shortfall,
      shortfallPoints: shortfall,
      entries,
    };
  }

  /**
   * Trả điểm của top-up bị hoàn (BR-P37, D3 ⊕): −Σ `redeem` của top-up (không theo
   * `points_redeemed`), mỗi phần về đúng lô / hạn cũ. Lô đã hết hạn tới `asOf` thì expire ngay trong
   * cùng transaction (cùng hàm của `expireDueForAccount`), nên ngay sau khi hoàn `points_balance` =
   * điểm còn sống. Không còn gì để trả → không ghi gì (kể cả expire).
   *
   * @throws LedgerPostRejected `reference_mismatch`.
   * @throws LoyaltyLedgerCorrupt
   */
  async restoreForTopUp(
    tx: LedgerClient,
    driverId: number,
    topUpId: number,
    asOf?: Date,
  ): Promise<RestoreResult> {
    await this.ownedTopUpPoints(tx, driverId, topUpId);
    const none: RestoreResult = {
      created: false,
      restoredPoints: 0,
      expiredPoints: 0,
      entries: [],
    };
    const acc = (
      await tx.query<{ id: string }>('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [
        driverId,
      ])
    ).rows[0];
    if (!acc) return none;
    const locked = await this.lock(tx, 'id', Number(acc.id));

    const at = asOf ?? (await this.dbNow(tx));
    this.replayChecked(locked, at);
    const parts = planRestore(locked.rows, topUpId);
    if (!parts.length) return none;

    const restored = await this.write(
      tx,
      locked,
      parts.map((p) => ({ type: 'restore', points: p.points, lotId: p.lotId, topUpId })),
    );
    const expired = await this.writeExpiry(tx, locked, at);
    return {
      created: true,
      restoredPoints: sum(parts),
      expiredPoints: expired.expiredPoints,
      entries: [...restored, ...expired.entries],
    };
  }

  /**
   * Ghi `expire` cho phần còn sống của các lô đã hết hạn tới `asOf` của MỘT tài khoản (D11), mỗi lô
   * một dòng mang `expires_at` của lô. Chạy lại không trừ hai lần. Job hằng ngày (chống chạy chồng,
   * bỏ qua tài khoản `closed`) là Phần 13.
   *
   * @throws LoyaltyAccountNotFound
   * @throws LoyaltyLedgerCorrupt
   */
  async expireDueForAccount(
    tx: LedgerClient,
    loyaltyAccountId: number,
    asOf?: Date,
  ): Promise<ExpireResult> {
    const locked = await this.lock(tx, 'id', loyaltyAccountId);
    const at = asOf ?? (await this.dbNow(tx));
    this.replayChecked(locked, at);
    return this.writeExpiry(tx, locked, at);
  }

  // ---------------------------------------------------------------------------------------------

  /** `points_redeemed` của top-up nếu top-up thuộc ví của tài xế; sai → `reference_mismatch`. */
  private async ownedTopUpPoints(
    tx: LedgerClient,
    driverId: number,
    topUpId: number,
  ): Promise<number> {
    const row = (
      await tx.query<{ points_redeemed: number; driver_id: string }>(
        `SELECT t.points_redeemed, c.driver_id FROM top_ups t
         JOIN credit_accounts c ON c.id = t.credit_account_id WHERE t.id=$1`,
        [topUpId],
      )
    ).rows[0];
    if (!row || Number(row.driver_id) !== driverId) {
      throw new LedgerPostRejected('reference_mismatch');
    }
    return Number(row.points_redeemed);
  }

  /**
   * Khoá tài khoản của tài xế; chưa có thì tạo rồi khoá. Khoá **trước**, chỉ INSERT khi thiếu: nếu
   * INSERT … ON CONFLICT chạy trước thì chính nó đứng chờ transaction đang giữ dòng, che mất việc
   * thiếu `FOR UPDATE` (test đột biến không bắt được).
   */
  private async lockOrCreate(tx: LedgerClient, driverId: number) {
    try {
      return await this.lock(tx, 'driver_id', driverId);
    } catch (err) {
      if (!(err instanceof LoyaltyAccountNotFound)) throw err;
    }
    await tx.query(
      'INSERT INTO loyalty_accounts(driver_id) VALUES($1) ON CONFLICT (driver_id) DO NOTHING',
      [driverId],
    );
    return this.lock(tx, 'driver_id', driverId);
  }

  /** Khoá `loyalty_accounts` rồi đọc toàn bộ sổ của tài khoản (sau khoá → thấy dòng đã commit). */
  private async lock(
    tx: LedgerClient,
    by: 'id' | 'driver_id',
    value: number,
  ): Promise<Locked & { balance: number }> {
    const acc = (
      await tx.query<{ id: string; points_balance: string }>(
        `SELECT id, points_balance FROM loyalty_accounts WHERE ${by}=$1 FOR UPDATE`,
        [value],
      )
    ).rows[0];
    if (!acc) throw new LoyaltyAccountNotFound(value);
    const accountId = Number(acc.id);
    return {
      accountId,
      balance: Number(acc.points_balance),
      rows: await this.loadRows(tx, accountId),
    };
  }

  /** Phát lại + kiểm `points_balance = Σ points`; lỗi ném trước mọi câu ghi. */
  private replayChecked(locked: Locked & { balance: number }, asOf: Date) {
    const state = replayLots(locked.rows, asOf);
    if (state.total !== locked.balance) throw new LoyaltyLedgerCorrupt('balance_mismatch');
    return state;
  }

  /**
   * Sổ của tài khoản theo `entry_no`, kèm `lot_id` = min(id) của các dòng **earn** cùng
   * `expires_at` (so chính xác trong SQL). Dòng có hạn không khớp lô earn nào → `lot_id` NULL.
   */
  private async loadRows(exec: LedgerClient, accountId: number): Promise<LoyaltyRow[]> {
    const raw = (
      await exec.query<RawRow>(
        `SELECT t.entry_no, t.transaction_type, t.points, t.expires_at, t.top_up_id, l.lot_id
         FROM loyalty_transactions t
         LEFT JOIN (
           SELECT expires_at, min(id) AS lot_id FROM loyalty_transactions
           WHERE loyalty_account_id=$1 AND transaction_type='earn' AND expires_at IS NOT NULL
           GROUP BY expires_at
         ) l ON l.expires_at = t.expires_at
         WHERE t.loyalty_account_id=$1 ORDER BY t.entry_no`,
        [accountId],
      )
    ).rows;
    return raw.map((r) => ({
      entryNo: Number(r.entry_no),
      type: r.transaction_type,
      points: Number(r.points),
      lotId: nullableNumber(r.lot_id),
      expiresAt: r.expires_at,
      topUpId: nullableNumber(r.top_up_id),
    }));
  }

  private async entriesOf(
    tx: LedgerClient,
    accountId: number,
    topUpId: number,
    types: LoyaltyTransactionType[],
  ): Promise<LoyaltyEntry[]> {
    return (
      await tx.query<EntryRow>(
        `SELECT id,entry_no,transaction_type,points,expires_at FROM loyalty_transactions
         WHERE loyalty_account_id=$1 AND top_up_id=$2 AND transaction_type = ANY($3::loyalty_transaction_type[])
         ORDER BY entry_no`,
        [accountId, topUpId, types],
      )
    ).rows.map(toEntry);
  }

  /** Phần expire của lô đã hết hạn tới `asOf`, dùng chung cho `expireDueForAccount` và restore. */
  private async writeExpiry(tx: LedgerClient, locked: Locked, asOf: Date): Promise<ExpireResult> {
    const parts = planExpiry(replayLots(locked.rows, asOf).lots, asOf);
    const entries = await this.write(
      tx,
      locked,
      parts.map((p) => ({ type: 'expire', points: -p.points, lotId: p.lotId, topUpId: null })),
    );
    return { expiredPoints: sum(parts), entries };
  }

  /**
   * Ghi các dòng (entry_no nối tiếp dòng cuối đã đọc dưới khoá), `expires_at` copy bằng SQL từ dòng
   * earn `lotId` (NULL khi không có lô), rồi cập nhật `points_balance`. Thêm dòng vừa ghi vào
   * `locked.rows` để lần phát lại sau trong cùng lời gọi thấy chúng.
   */
  private async write(tx: LedgerClient, locked: Locked, writes: Write[]): Promise<LoyaltyEntry[]> {
    if (!writes.length) return [];
    let entryNo = locked.rows.at(-1)?.entryNo ?? 0;
    const entries: LoyaltyEntry[] = [];
    for (const w of writes) {
      entryNo++;
      const row = (
        await tx.query<EntryRow>(
          `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at,top_up_id)
           VALUES($1,$2,$3,$4,(SELECT expires_at FROM loyalty_transactions WHERE id=$5),$6)
           RETURNING id,entry_no,transaction_type,points,expires_at`,
          [locked.accountId, entryNo, w.type, w.points, w.lotId, w.topUpId],
        )
      ).rows[0]!;
      const entry = toEntry(row);
      entries.push(entry);
      locked.rows.push({
        entryNo,
        type: w.type,
        points: w.points,
        lotId: w.lotId,
        expiresAt: entry.expiresAt,
        topUpId: w.topUpId,
      });
    }
    const delta = writes.reduce((s, w) => s + w.points, 0);
    if (delta !== 0) {
      await tx.query(
        'UPDATE loyalty_accounts SET points_balance=points_balance+$2,updated_at=now() WHERE id=$1',
        [locked.accountId, delta],
      );
    }
    return entries;
  }

  private async dbNow(exec: LedgerClient): Promise<Date> {
    return (await exec.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
  }
}

interface Write {
  type: LoyaltyTransactionType;
  points: number;
  lotId: number | null;
  topUpId: number | null;
}

const sum = (parts: LotPart[]) => parts.reduce((s, p) => s + p.points, 0);
