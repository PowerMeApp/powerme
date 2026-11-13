/**
 * TopUpService — SD-2a: tài xế tạo top-up VNPay (T32 Phần 5, decisions D2); SD-2b: IPN cộng tiền
 * (T32 Phần 6, D3).
 *
 * Phần 5: `quote`, `create`, `get` — không ghi sổ cái, không trừ điểm, không hẹn timeout; `create`
 * đặt `next_attempt_at = expires_at + 2 phút` cho vòng quét querydr của Phần 8 (D7, T127).
 * Phần 6: `applyPaymentResult` — chỉ IPN có chữ ký hợp lệ mới cộng tiền (nguyên tắc 1); khoá
 * `top_ups` → `credit_accounts` → `loyalty_accounts` (thứ tự cố định ở mọi đường cộng tiền).
 *
 * Ba lớp chống trùng (nguyên tắc 2 của billing):
 *   1. Idempotency-Key theo tài khoản + `request_hash` (migration 0019);
 *   2. khoá `credit_accounts … FOR UPDATE` trước mọi kiểm tra: hai request cùng tài xế chạy nối
 *      tiếp, request sau thấy dòng của request trước (cùng key) hoặc top-up pending (khác key);
 *   3. UNIQUE `top_ups_account_idempotency_key_key` và partial UNIQUE
 *      `top_ups_one_pending_per_account_key`: nếu vẫn lọt 23505 (dòng ghi ngoài API) thì chạy lại
 *      transaction một lần, lần đó trả kết quả như bước 2 / bước 4, không ném 500.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { LoyaltyLedgerCorrupt, RedemptionRejected, TopUpRejected } from './billing-errors.js';
import { CreditLedgerService, LedgerClient } from './credit-ledger.service.js';
import { computeQuote } from './loyalty-lots.js';
import { LoyaltyService } from './loyalty.service.js';
import {
  TOP_UP_STATUSES,
  TopUpGuards,
  TopUpStateMachine,
  TopUpStatus,
} from './top-up-state-machine.js';
import {
  classifyIpn,
  IpnResultKind,
  newGatewayReference,
  parseVnpDate,
  VnpayAdapter,
} from './vnpay.adapter.js';

/** D7: top-up pending hết hạn thanh toán sau 15 phút (`expires_at = now() + PENDING_TIMEOUT_MS`). */
export const PENDING_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * T127 / D4: lần querydr đầu tiên lúc `expires_at + 2 phút` (IPN đang trên đường vẫn kịp tới).
 * `create` ghi `next_attempt_at = expires_at + QUERYDR_FIRST_DELAY_MS`; lịch lùi dần sau đó (+ 5, 10,
 * 20, 40, 60 phút) là việc của Phần 8. Mọi chỗ rời `pending` đặt `next_attempt_at = NULL`.
 */
export const QUERYDR_FIRST_DELAY_MS = 2 * 60 * 1000;
/** BR-P22 theo ADR-0013: mỗi lần nạp 50.000–2.000.000 VND, số dư sau nạp ≤ 5.000.000 VND. */
export const TOP_UP_MIN_VND = 50_000;
export const TOP_UP_MAX_VND = 2_000_000;
export const BALANCE_MAX_VND = 5_000_000;
/** Số lần sinh lại `gateway_reference` khi trùng UNIQUE (36^14 khả năng, gần như không xảy ra). */
export const GATEWAY_REFERENCE_ATTEMPTS = 5;

export interface CreateTopUpInput {
  amountVnd: number;
  /** Bỏ trống = 0 (không dùng điểm). */
  pointsToRedeem?: number;
}

export interface TopUpView {
  topUpId: number;
  status: TopUpStatus;
  amountVnd: number;
  pointsRedeemed: number;
  pointsDiscountVnd: number;
  amountPaidVnd: number;
  createdAt: Date;
  expiresAt: Date;
  /** Chỉ có khi `status = pending` và chưa quá `expires_at`; còn lại null. */
  paymentUrl: string | null;
}

export interface TopUpQuote {
  /** Điểm còn sống (D11), không phải `points_balance`. */
  pointsAvailable: number;
  /** Số điểm tối đa dùng được cho số tiền này; 0 khi dưới 500 điểm (không phải lỗi). */
  maxPoints: number;
  maxDiscountVnd: number;
}

/**
 * `request_hash` = sha256 hex của `JSON.stringify([amount_vnd, points_to_redeem])` — đúng cách băm
 * của `sessions/driver-charging.service.ts` (inline, không export). Chỉ băm giá trị tài xế gửi
 * sau chuẩn hoá (`points_to_redeem` bỏ trống → 0), không băm giá trị server tính.
 */
export function topUpRequestHash(amountVnd: number, pointsToRedeem = 0): string {
  return createHash('sha256')
    .update(JSON.stringify([amountVnd, pointsToRedeem]))
    .digest('hex');
}

/** RspCode trả VNPay (tài liệu PAY 2.1.0; câu Message theo code mẫu PHP). */
export type IpnRspCode = '00' | '01' | '02' | '04' | '97' | '99';
export interface IpnReply {
  RspCode: IpnRspCode;
  Message: string;
}
const IPN_MESSAGE: Record<IpnRspCode, string> = {
  '00': 'Confirm Success',
  '01': 'Order not found',
  '02': 'Order already confirmed',
  '04': 'invalid amount',
  '97': 'Invalid signature',
  '99': 'Unknow error',
};
export function ipnReply(code: IpnRspCode): IpnReply {
  return { RspCode: code, Message: IPN_MESSAGE[code] };
}

/** Kết quả đã commit của một IPN; truyền cho `afterPaymentCommitted`. */
export interface PaymentResultCommitted {
  topUpId: number;
  outcome: 'credited' | 'failed' | 'late_payment';
}

interface IpnTopUpRow {
  id: string;
  status: TopUpStatus;
  credit_account_id: string;
  amount_vnd: string;
  amount_paid_vnd: string;
  points_redeemed: number;
  gateway_transaction_no: string | null;
  late_gateway_ref: string | null;
}

interface IpnInput {
  ref: string;
  amountRaw: string;
  kind: IpnResultKind;
  oneZero: boolean;
  transactionNo: string;
}

interface TopUpRow {
  id: string;
  status: TopUpStatus;
  amount_vnd: string;
  points_redeemed: number;
  points_discount_vnd: string;
  amount_paid_vnd: string;
  gateway_reference: string;
  created_at: Date;
  expires_at: Date;
  request_hash: string | null;
  /** `status = 'pending' AND expires_at > now()`, tính bằng đồng hồ DB. */
  payable: boolean;
}

const cols = (t: string) =>
  `${t}.id, ${t}.status, ${t}.amount_vnd, ${t}.points_redeemed, ${t}.points_discount_vnd,
   ${t}.amount_paid_vnd, ${t}.gateway_reference, ${t}.created_at, ${t}.expires_at, ${t}.request_hash,
   (${t}.status = 'pending' AND ${t}.expires_at > now()) AS payable`;

/** 23505 trên hai ràng buộc chống trùng của 0019 → đọc lại thay vì 500. */
const RACE_CONSTRAINTS = new Set([
  'top_ups_account_idempotency_key_key',
  'top_ups_one_pending_per_account_key',
]);

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string } | null;
  return e && e.code === '23505' ? (e.constraint ?? '') : null;
}

const REDEMPTION_CODE = {
  below_minimum: 'points_below_minimum',
  insufficient_points: 'points_unavailable',
  exceeds_cap: 'points_exceed_cap',
} as const;

@Injectable()
export class TopUpService {
  private readonly stm = new TopUpStateMachine();
  private readonly logger = new Logger(TopUpService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: CreditLedgerService,
    private readonly loyalty: LoyaltyService,
    private readonly vnpay: VnpayAdapter,
  ) {}

  /** Báo giá dùng điểm cho số tiền nạp (BR-P35). Chỉ đọc. */
  async quote(driverId: number, amountVnd: number): Promise<TopUpQuote> {
    checkAmount(amountVnd);
    const pointsAvailable = await this.loyalty.livePoints(this.db.$client, driverId);
    try {
      const q = computeQuote(pointsAvailable, amountVnd);
      return { pointsAvailable, maxPoints: q.points, maxDiscountVnd: q.discountVnd };
    } catch (error) {
      if (
        error instanceof RedemptionRejected &&
        (error.reason === 'below_minimum' || error.reason === 'exceeds_cap')
      )
        return { pointsAvailable, maxPoints: 0, maxDiscountVnd: 0 };
      throw error;
    }
  }

  /**
   * Tạo top-up `pending` (SD-2a). `created = false` khi gửi lại cùng key cùng body (route trả 200
   * thay vì 201).
   *
   * @throws TopUpRejected
   */
  async create(
    driverId: number,
    key: string,
    input: CreateTopUpInput,
    ip: string,
  ): Promise<{ created: boolean; topUp: TopUpView }> {
    if (!this.vnpay.configured) throw new TopUpRejected('payment_unconfigured');
    const points = input.pointsToRedeem ?? 0;
    const hash = topUpRequestHash(input.amountVnd, points);
    const run = () =>
      this.transaction((c) => this.createIn(c, driverId, key, input.amountVnd, points, hash, ip));
    try {
      return await run();
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === null || !RACE_CONSTRAINTS.has(constraint)) throw error;
      // Lọt 23505 dù đã khoá credit_accounts (dòng ghi ngoài API): đọc lại, gặp bước 2 hoặc 4.
      return run();
    }
  }

  /** Top-up của tài xế; không có hoặc của người khác → `not_found`. */
  async get(driverId: number, topUpId: number, ip: string): Promise<TopUpView> {
    const row = (
      await this.db.$client.query<TopUpRow>(
        `SELECT ${cols('t')} FROM top_ups t JOIN credit_accounts a ON a.id = t.credit_account_id
         WHERE t.id = $1 AND a.driver_id = $2`,
        [topUpId, driverId],
      )
    ).rows[0];
    if (!row) throw new TopUpRejected('not_found');
    return this.view(row, ip);
  }

  /**
   * SD-2b: áp kết quả thanh toán VNPay báo qua IPN (`GET /billing/vnpay/ipn`, D3). Nhận tham số
   * query thô; luôn trả `{RspCode, Message}` (route trả HTTP 200), không ném.
   *
   * Kiểm request (không ghi gì nếu lỗi): thiếu cấu hình → 99; chữ ký sai / thiếu / `vnp_TmnCode`
   * khác → 97; không thấy `vnp_TxnRef` → 01; `vnp_Amount ≠ amount_paid_vnd × 100` → 04. Chưa ngã ngũ
   * (`classifyIpn`) → không ghi gì, 00. Còn lại đi qua `TopUpStateMachine` trong MỘT transaction:
   * #2 cộng tiền + trừ điểm, #3 failed, khoản trễ ghi `late_*`, lặp → 02, mâu thuẫn → 02 + log error.
   * Lỗi bất ngờ → rollback, 99 (VNPay gọi lại).
   */
  async applyPaymentResult(params: Record<string, string>): Promise<IpnReply> {
    try {
      return await this.applyPaymentResultOrThrow(params);
    } catch (error) {
      this.log('error', 'ipn_unexpected_error', {
        gateway_reference: params['vnp_TxnRef'] ?? null,
        vnp_TransactionNo: params['vnp_TransactionNo'] ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return ipnReply('99');
    }
  }

  /**
   * Điểm gọi sau commit (Phần 6 chưa làm gì). Phần 7: `EInvoiceService.requestForTopUp` khi
   * `credited`. Realtime số dư mới: repo chưa có kênh realtime cho tài xế (chờ module `realtime`).
   */
  protected async afterPaymentCommitted(_result: PaymentResultCommitted): Promise<void> {}

  private async applyPaymentResultOrThrow(p: Record<string, string>): Promise<IpnReply> {
    if (!this.vnpay.configured) {
      // 99 để VNPay gọi lại khi đã cấu hình (thiếu secret thì không kiểm được chữ ký).
      this.log('error', 'ipn_unconfigured', { gateway_reference: p['vnp_TxnRef'] ?? null });
      return ipnReply('99');
    }
    const sig = this.vnpay.verifyIpn(p);
    if (!sig.ok) {
      this.log('warn', 'ipn_invalid_signature', {
        reason: sig.reason,
        gateway_reference: p['vnp_TxnRef'] ?? null,
      });
      return ipnReply('97');
    }
    const ref = p['vnp_TxnRef'] ?? '';
    const amountRaw = p['vnp_Amount'] ?? '';
    const transactionNo = p['vnp_TransactionNo'] ?? '';
    const { kind, oneZero } = classifyIpn(p['vnp_ResponseCode'], p['vnp_TransactionStatus']);
    // Chữ ký đúng mà thiếu / sai dạng trường bắt buộc: không ghi gì, 99 để VNPay gọi lại.
    // vnp_TransactionNo chỉ đọc ở nhánh thành công (giao dịch huỷ có thể mang số 0).
    if (
      !/^[A-Za-z0-9]{1,100}$/.test(ref) ||
      !/^\d{1,15}$/.test(amountRaw) ||
      (kind === 'succeeded' && !/^\d{1,15}$/.test(transactionNo))
    ) {
      this.log('error', 'ipn_malformed', {
        gateway_reference: ref || null,
        vnp_Amount: amountRaw || null,
        vnp_TransactionNo: transactionNo || null,
      });
      return ipnReply('99');
    }

    const result = await this.transaction((c) =>
      this.applyIpnIn(c, p, { ref, amountRaw, kind, oneZero, transactionNo }),
    );
    if (result.committed) {
      // Đã commit: lỗi việc sau commit không được đổi RspCode (trả 99 sẽ làm VNPay gọi lại một IPN
      // đã áp dụng). Phần 7 (e-invoice) có vòng quét DB bắt lại.
      try {
        await this.afterPaymentCommitted(result.committed);
      } catch (error) {
        this.log('error', 'ipn_after_commit_failed', {
          top_up_id: result.committed.topUpId,
          outcome: result.committed.outcome,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ipnReply(result.code);
  }

  private async applyIpnIn(
    c: PoolClient,
    p: Record<string, string>,
    v: IpnInput,
  ): Promise<{ code: IpnRspCode; committed?: PaymentResultCommitted }> {
    // Thứ tự khoá cố định: top_ups → credit_accounts (→ loyalty_accounts trong redeemForTopUp).
    const top = (
      await c.query<IpnTopUpRow>(
        `SELECT id, status, credit_account_id, amount_vnd, amount_paid_vnd, points_redeemed,
                gateway_transaction_no, late_gateway_ref
         FROM top_ups WHERE gateway_reference = $1 FOR UPDATE`,
        [v.ref],
      )
    ).rows[0];
    if (!top) return { code: '01' };
    const account = (
      await c.query<{ id: string; driver_id: string }>(
        'SELECT id, driver_id FROM credit_accounts WHERE id = $1 FOR UPDATE',
        [top.credit_account_id],
      )
    ).rows[0]!;
    const topUpId = Number(top.id);
    const codes = {
      vnp_ResponseCode: p['vnp_ResponseCode'] ?? null,
      vnp_TransactionStatus: p['vnp_TransactionStatus'] ?? null,
    };

    if (BigInt(v.amountRaw) !== BigInt(top.amount_paid_vnd) * 100n) {
      this.log('warn', 'ipn_amount_mismatch', {
        top_up_id: topUpId,
        gateway_reference: v.ref,
        vnp_Amount: v.amountRaw,
        amount_paid_vnd: Number(top.amount_paid_vnd),
      });
      return { code: '04' };
    }

    if (v.kind === 'unresolved') {
      // Không ghi gì; querydr (Phần 8) hỏi lại theo next_attempt_at khi còn pending.
      const fields = { top_up_id: topUpId, gateway_reference: v.ref, status: top.status, ...codes };
      if (top.status === 'pending' && v.oneZero)
        this.log('warn', 'ipn_unresolved_one_zero', fields);
      else this.log('log', 'ipn_unresolved', fields);
      return { code: '00' };
    }

    const event = v.kind === 'succeeded' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED';
    const guards: TopUpGuards =
      v.kind === 'succeeded'
        ? {
            transactionNo: v.transactionNo,
            appliedTransactionNo: top.gateway_transaction_no ?? undefined,
            recordedLateRef: top.late_gateway_ref,
          }
        : {};
    const step = this.stm.apply(top.status, event, guards);

    switch (step.outcome) {
      case 'transition':
        if (step.to === 'credited') {
          await this.credit(c, top, Number(account.id), Number(account.driver_id), v.transactionNo);
          return { code: '00', committed: { topUpId, outcome: 'credited' } };
        }
        await c.query(
          `UPDATE top_ups SET status = $2::top_up_status, completed_at = now(),
             next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
          [topUpId, step.to],
        );
        return { code: '00', committed: { topUpId, outcome: 'failed' } };
      case 'late_payment':
        // Giữ trạng thái; không cộng, không trừ điểm, không hoá đơn (D4).
        await c.query(
          `UPDATE top_ups SET late_gateway_ref = $2, late_paid_at = COALESCE($3::timestamptz, now()),
             late_amount_vnd = $4, updated_at = now() WHERE id = $1`,
          [topUpId, v.transactionNo, parseVnpDate(p['vnp_PayDate']), Number(top.amount_paid_vnd)],
        );
        return { code: '00', committed: { topUpId, outcome: 'late_payment' } };
      case 'conflicting_result':
        // Khoản thứ ba trên cùng top-up, hoặc báo lỗi trên top-up đã cộng: Admin xử lý ngoài hệ thống.
        this.log('error', 'ipn_conflicting_result', {
          top_up_id: topUpId,
          gateway_reference: v.ref,
          status: top.status,
          vnp_TransactionNo: v.transactionNo || null,
          gateway_transaction_no: top.gateway_transaction_no,
          late_gateway_ref: top.late_gateway_ref,
          vnp_Amount: v.amountRaw,
          amount_paid_vnd: Number(top.amount_paid_vnd),
          ...codes,
        });
        return { code: '02' };
      case 'already_applied':
      case 'stale':
      case 'rejected':
        return { code: '02' };
    }
  }

  /** #2: pending → credited, ghi sổ cái, trừ điểm (D3). Bên gọi đã khoá top_ups + credit_accounts. */
  private async credit(
    c: PoolClient,
    top: IpnTopUpRow,
    accountId: number,
    driverId: number,
    transactionNo: string,
  ): Promise<void> {
    const topUpId = Number(top.id);
    await c.query(
      `UPDATE top_ups SET status = 'credited', gateway_transaction_no = $2, completed_at = now(),
         next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
      [topUpId, transactionNo],
    );
    // in_shortfall → active khi số dư ≥ 0 do post lo.
    await this.ledger.post(c, accountId, 'top_up', Number(top.amount_vnd), { topUpId });
    if (Number(top.points_redeemed) === 0) return;

    // Lỗi sổ điểm không được rollback việc cộng tiền (D3 ⊕, chốt Ân 13/11): SAVEPOINT bỏ mọi dòng
    // điểm ghi dở, không ghi adjust, đánh dấu exception_kind để Admin xem. Lỗi khác → rollback hết.
    await c.query('SAVEPOINT ipn_loyalty');
    try {
      await this.loyalty.redeemForTopUp(c, driverId, topUpId);
      await c.query('RELEASE SAVEPOINT ipn_loyalty');
    } catch (error) {
      if (!(error instanceof LoyaltyLedgerCorrupt)) throw error;
      await c.query('ROLLBACK TO SAVEPOINT ipn_loyalty');
      await c.query(
        `UPDATE top_ups SET exception_kind = 'loyalty_error', updated_at = now() WHERE id = $1`,
        [topUpId],
      );
      const loyaltyAccount = (
        await c.query<{ id: string }>('SELECT id FROM loyalty_accounts WHERE driver_id = $1', [
          driverId,
        ])
      ).rows[0];
      this.log('error', 'ipn_loyalty_ledger_corrupt', {
        reason: error.reason,
        entry_no: error.entryNo,
        top_up_id: topUpId,
        loyalty_account_id: loyaltyAccount ? Number(loyaltyAccount.id) : null,
        points_redeemed: Number(top.points_redeemed),
      });
    }
  }

  private log(level: 'log' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
    this.logger[level](JSON.stringify({ event, ...fields }));
  }

  /** Sinh `gateway_reference` (tách ra để test va chạm UNIQUE). */
  protected nextGatewayReference(): string {
    return newGatewayReference();
  }

  private async createIn(
    c: PoolClient,
    driverId: number,
    key: string,
    amountVnd: number,
    points: number,
    hash: string,
    ip: string,
  ): Promise<{ created: boolean; topUp: TopUpView }> {
    // 1. Tài khoản (D9), khoá trước mọi kiểm tra.
    await this.ledger.ensureAccounts(driverId, c);
    const account = (
      await c.query<{ id: string; status: string; balance_vnd: string }>(
        'SELECT id, status, balance_vnd FROM credit_accounts WHERE driver_id = $1 FOR UPDATE',
        [driverId],
      )
    ).rows[0]!;

    // 2. Gửi lại cùng key: cùng body → top-up cũ (không báo giá lại); khác / NULL → conflict.
    const prior = (
      await c.query<TopUpRow>(
        `SELECT ${cols('t')} FROM top_ups t WHERE t.credit_account_id = $1 AND t.idempotency_key = $2`,
        [account.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash) throw new TopUpRejected('idempotency_conflict');
      return { created: false, topUp: this.view(prior, ip) };
    }

    // 3. Tài khoản đóng (active và in_shortfall đều được tạo — SD-2a).
    if (account.status === 'closed') throw new TopUpRejected('account_closed');

    // 4. Đang có top-up mở (chỉ `pending`, D2 ⊕).
    const open = (
      await c.query<TopUpRow>(
        `SELECT ${cols('t')} FROM top_ups t
         WHERE t.credit_account_id = $1 AND t.status = ANY($2::top_up_status[]) ORDER BY t.id LIMIT 1`,
        [account.id, TOP_UP_STATUSES.filter((s) => this.stm.isOpen(s))],
      )
    ).rows[0];
    if (open) {
      if (open.payable)
        throw new TopUpRejected('top_up_pending', {
          topUpId: Number(open.id),
          paymentUrl: this.paymentUrl(open, ip),
        });
      // Đã quá expires_at nhưng KHÔNG tự chuyển expired ở đây: theo T117 / D4 ⊕ ĐIỀU KIỆN chỉ
      // querydr trả lời dứt khoát "chưa trả" (Phần 8) mới được pending → expired. Tài xế có thể đã
      // trả mà IPN tới chậm; tự expire sẽ biến tiền thật thành khoản trễ Admin phải hoàn tay. Tài xế
      // chờ (thường ~2 phút sau expires_at, tối đa ~1 giờ) là hành vi cố ý của D2.
      throw new TopUpRejected('pending_top_up_confirming', { topUpId: Number(open.id) });
    }

    // 5. Hạn mức BR-P22 (ADR-0013). Ví được cộng đủ amount_vnd dù trả bớt bằng điểm.
    checkAmount(amountVnd);
    if (Number(account.balance_vnd) + amountVnd > BALANCE_MAX_VND)
      throw new TopUpRejected('balance_limit_exceeded');

    // 6. Điểm (BR-P35): không tự hạ số điểm, không trừ điểm ở đây.
    let discountVnd = 0;
    if (points > 0) {
      try {
        discountVnd = (
          await this.loyalty.quoteRedemption(c, driverId, amountVnd, { requestedPoints: points })
        ).discountVnd;
      } catch (error) {
        if (error instanceof RedemptionRejected && error.reason in REDEMPTION_CODE)
          throw new TopUpRejected(REDEMPTION_CODE[error.reason as keyof typeof REDEMPTION_CODE]);
        throw error;
      }
    }

    // 7. Ghi top-up pending (#1). Trùng gateway_reference → sinh lại trong SAVEPOINT.
    const row = await this.insert(c, {
      accountId: account.id,
      amountVnd,
      points,
      discountVnd,
      key,
      hash,
    });
    return { created: true, topUp: this.view(row, ip) };
  }

  private async insert(
    c: LedgerClient,
    v: {
      accountId: string;
      amountVnd: number;
      points: number;
      discountVnd: number;
      key: string;
      hash: string;
    },
  ): Promise<TopUpRow> {
    for (let attempt = 1; ; attempt++) {
      await c.query('SAVEPOINT top_up_insert');
      try {
        const row = (
          await c.query<TopUpRow>(
            `INSERT INTO top_ups AS t (gateway_reference, credit_account_id, amount_vnd,
               points_redeemed, points_discount_vnd, amount_paid_vnd, status, idempotency_key,
               request_hash, expires_at, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10::float8),
               now() + make_interval(secs => $10::float8) + make_interval(secs => $11::float8))
             RETURNING ${cols('t')}`,
            [
              this.nextGatewayReference(),
              v.accountId,
              v.amountVnd,
              v.points,
              v.discountVnd,
              v.amountVnd - v.discountVnd,
              this.stm.initial(),
              v.key,
              v.hash,
              PENDING_TIMEOUT_MS / 1000,
              QUERYDR_FIRST_DELAY_MS / 1000,
            ],
          )
        ).rows[0]!;
        await c.query('RELEASE SAVEPOINT top_up_insert');
        return row;
      } catch (error) {
        if (
          uniqueViolation(error) === 'top_ups_gateway_reference_key' &&
          attempt < GATEWAY_REFERENCE_ATTEMPTS
        ) {
          await c.query('ROLLBACK TO SAVEPOINT top_up_insert');
          continue;
        }
        throw error;
      }
    }
  }

  private paymentUrl(row: TopUpRow, ip: string): string {
    return this.vnpay.buildPaymentUrl(
      {
        gatewayReference: row.gateway_reference,
        amountPaidVnd: Number(row.amount_paid_vnd),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      },
      ip,
    );
  }

  private view(row: TopUpRow, ip: string): TopUpView {
    return {
      topUpId: Number(row.id),
      status: row.status,
      amountVnd: Number(row.amount_vnd),
      pointsRedeemed: Number(row.points_redeemed),
      pointsDiscountVnd: Number(row.points_discount_vnd),
      amountPaidVnd: Number(row.amount_paid_vnd),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      // Dòng tạo khi chưa cấu hình VNPay không có (create chặn trước); GET khi thiếu cấu hình → null.
      paymentUrl: row.payable && this.vnpay.configured ? this.paymentUrl(row, ip) : null,
    };
  }

  private async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.$client.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function checkAmount(amountVnd: number): void {
  if (!Number.isSafeInteger(amountVnd) || amountVnd < TOP_UP_MIN_VND || amountVnd > TOP_UP_MAX_VND)
    throw new TopUpRejected('amount_out_of_range');
}
