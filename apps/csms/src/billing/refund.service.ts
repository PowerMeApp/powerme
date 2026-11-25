/**
 * RefundService — gửi hoàn tiền về VNPay chạy nền (T32 Phần 9a; SD-2e phần 2, STM-10, decisions D1).
 *
 * Việc nền `refund-send` theo lease (D7): tx1 giữ chỗ một dòng `requested` → gọi VNPay NGOÀI
 * transaction → tx2 khoá theo thứ tự `top_ups` / `credit_accounts` → `refunds` (`lockLeased`,
 * `null` = mất lease, bỏ kết quả) → STM-10 → ghi. Đây là chỗ DUY NHẤT gọi `VnpayAdapter.refund`.
 *
 * Chống hoàn hai lần (`planRound`): chỉ gửi không cần hỏi ở lượt đầu thật sự. `unfinished_claims > 1`
 * nghĩa là lượt trước đã giữ chỗ mà chưa ghi được kết quả, có thể đã gửi rồi sập. Lượt nào cũng
 * querydr trước khi gửi lại, và querydr thấy giao dịch trả 01 / 00 chỉ được gửi ở lượt ngay sau
 * Admin retry: tài liệu VNPay không ghi querydr có đổi sang 02 / 03 sau khi hoàn, nên 01 / 00 không
 * chứng minh là chưa hoàn. Thà hết lượt rồi `failed` để Admin xem, còn hơn hoàn hai lần.
 *
 * Điều chỉnh hoá đơn khi `done`: Phần 9b.
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { BackgroundWork, BackgroundWorkRunner } from './background-work.js';
import { BACKGROUND_WORK_CONFIG, BackgroundWorkConfig } from './background-work.config.js';
import { RefundNotFound } from './billing-errors.js';
import type { LedgerClient } from './credit-ledger.service.js';
import { LeasedRow, lockLeased, runLeasedBatch } from './due-rows.js';
import {
  RefundErrorKind,
  RefundStateMachine,
  RefundStatus,
  RETRY_LIMIT,
} from './refund-state-machine.js';
import { nextRetry } from './retry-schedule.js';
import { RefundInput, RefundResult, VnpayAdapter } from './vnpay.adapter.js';

/** `BackgroundWork.name` của việc gửi hoàn (D7). */
export const REFUND_SEND_WORK = 'refund-send';

/** `last_error_message` cắt còn chừng này ký tự. */
const LAST_ERROR_MESSAGE_MAX = 500;

export type RefundKind = 'top_up' | 'late_payment' | 'account_closure';

export interface CreateRefundInput {
  topUpId: number;
  kind: RefundKind;
  amountVnd: number;
  /** `admins.user_id`; NULL chỉ cho `account_closure` (CHECK của 0015). */
  requestedBy: number | null;
}

export interface RefundRetryResult {
  refundId: number;
  status: RefundStatus;
  attemptCount: number;
}

/**
 * Cách chạy một lượt:
 * - `send`: lượt đầu thật sự, gửi luôn;
 * - `query_then_send`: lượt ngay sau Admin retry, querydr trước, thấy 01 / 00 thì gửi đúng một lần;
 * - `query_only`: mọi lượt khác, querydr và không bao giờ gửi.
 *
 * Dòng `requested` có `last_error_kind = 'data'` hoặc `attempt_count >= RETRY_LIMIT` chỉ có thể do
 * Admin retry (hai ca đó đều đã `failed`); `unfinished_claims = 1` bảo đảm lượt đó chưa chạy dở.
 */
export type RefundRoundPlan = 'send' | 'query_then_send' | 'query_only';

export function planRound(row: {
  attemptCount: number;
  lastErrorKind: RefundErrorKind | null;
  unfinishedClaims: number;
}): RefundRoundPlan {
  if (row.unfinishedClaims !== 1) return 'query_only';
  if (row.attemptCount === 0 && row.lastErrorKind === null) return 'send';
  if (row.lastErrorKind === 'data' || row.attemptCount >= RETRY_LIMIT) return 'query_then_send';
  return 'query_only';
}

type SendRow = {
  id: string;
  status: RefundStatus;
  kind: RefundKind;
  top_up_id: string;
  amount_vnd: string;
  attempt_count: number;
  last_error_kind: RefundErrorKind | null;
  requested_by: string | null;
  credit_account_id: string;
  gateway_reference: string;
  gateway_transaction_no: string | null;
  amount_paid_vnd: string;
  late_gateway_ref: string | null;
  late_amount_vnd: string | null;
  created_at: Date;
};

type LockedRefund = {
  id: string;
  status: RefundStatus;
  kind: RefundKind;
  top_up_id: string;
  attempt_count: number;
  unfinished_claims?: number;
};

/** Kết quả một lượt, đã quy về thứ STM-10 cần. */
type RoundOutcome =
  | {
      kind: 'done';
      refundNo: string | null;
      viaQuery: boolean;
      transactionType?: string;
      transactionStatus: string;
    }
  | { kind: RefundErrorKind; message: string; fields?: Record<string, unknown> };

type RefundLog = {
  level: 'log' | 'warn' | 'error';
  event: string;
  fields: Record<string, unknown>;
};

/** Tham số gửi VNPay theo kind (bảng 2.1); `null` + lý do khi dòng không gửi được. */
function refundInput(r: SendRow): { input: RefundInput } | { invalid: string } {
  const late = r.kind === 'late_payment';
  const transactionNo = late ? r.late_gateway_ref : r.gateway_transaction_no;
  const original = late ? r.late_amount_vnd : r.amount_paid_vnd;
  if (!transactionNo || original === null) return { invalid: 'missing_gateway_transaction_no' };
  const amountVnd = Number(r.amount_vnd);
  const originalAmountVnd = Number(original);
  if (amountVnd > originalAmountVnd) return { invalid: 'amount_exceeds_original' };
  return {
    input: {
      refundId: Number(r.id),
      gatewayReference: r.gateway_reference,
      originalTransactionNo: transactionNo,
      originalAmountVnd,
      createdAt: r.created_at,
      amountVnd,
      requestedBy: r.requested_by === null ? null : Number(r.requested_by),
    },
  };
}

function fromSend(result: RefundResult): RoundOutcome {
  switch (result.kind) {
    case 'accepted':
      return {
        kind: 'done',
        refundNo: result.refundNo,
        viaQuery: false,
        transactionStatus: result.transactionStatus,
      };
    case 'rejected':
      return {
        kind: 'data',
        message: `vnpay_rejected rc=${result.responseCode} ts=${result.transactionStatus ?? '-'}`,
      };
    case 'in_progress':
      return {
        kind: 'transient',
        message: 'vnpay_in_progress rc=94',
        fields: {
          verified: result.verified,
          ...(result.unverified && {
            unverified_response_code: result.unverified.responseCode ?? null,
            has_secure_hash: result.unverified.hasSecureHash,
          }),
        },
      };
    case 'unknown':
      return {
        kind: 'transient',
        message: `vnpay_unknown ${result.reason} rc=${result.responseCode ?? '-'}`,
        fields: unverifiedFields(result.unverified),
      };
  }
}

/** Mã thô CHƯA xác thực, chỉ để đọc log (như `querydr_result` của 8b). */
function unverifiedFields(
  u: { responseCode?: string; message?: string; hasSecureHash: boolean } | undefined,
): Record<string, unknown> {
  if (!u) return {};
  return {
    unverified_response_code: u.responseCode ?? null,
    unverified_message: u.message ?? null,
    has_secure_hash: u.hasSecureHash,
  };
}

@Injectable()
export class RefundService implements BackgroundWork, OnModuleInit {
  readonly name = REFUND_SEND_WORK;
  private readonly stm = new RefundStateMachine();
  private readonly logger = new Logger(RefundService.name);
  private warnedUnconfigured = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vnpay: VnpayAdapter,
    @Optional() private readonly runner?: BackgroundWorkRunner,
    @Optional()
    @Inject(BACKGROUND_WORK_CONFIG)
    private readonly workConfig?: BackgroundWorkConfig,
  ) {}

  /** Luôn đăng ký, kể cả khi `BILLING_WORKER_ENABLED=false` (billing/CLAUDE.md). */
  onModuleInit(): void {
    this.runner?.register(this);
  }

  /** STM-10 #1: tạo refund `requested` trong transaction quyết định hoàn của bên gọi. */
  async create(c: LedgerClient, input: CreateRefundInput): Promise<number> {
    const row = (
      await c.query<{ id: string }>(
        `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, requested_by)
         VALUES ($1, $2::refund_kind, $3, $4::refund_status, $5) RETURNING id`,
        [input.topUpId, input.kind, input.amountVnd, this.stm.initial(), input.requestedBy],
      )
    ).rows[0]!;
    return Number(row.id);
  }

  /** Chạy sớm việc gửi hoàn (gọi SAU commit). Không có runner (test dựng tay) → bỏ qua. */
  kickSend(): void {
    this.runner?.kick(this.name);
  }

  /**
   * Vòng quét (D7): `status = 'requested' AND next_attempt_at <= now()`. VNPay chưa cấu hình → không
   * giữ chỗ dòng nào, trả 0, warn một lần mỗi tiến trình.
   */
  async runDue(limit: number, signal: AbortSignal): Promise<number> {
    if (!this.workConfig) throw new Error('refund_send_missing_config');
    if (!this.vnpay.configured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.log('warn', 'refund_send_unconfigured', {
          detail: 'thiếu VNPAY_TMN_CODE / VNPAY_HASH_SECRET, refund requested giữ nguyên',
        });
      }
      return 0;
    }
    return runLeasedBatch(
      this.db.$client,
      {
        table: 'refunds',
        statuses: ['requested'],
        leaseMs: this.workConfig.leaseMs,
        limit,
        onExhausted: (locked, c) => this.onClaimsExhausted(c, locked as LockedRefund),
      },
      (row) => this.send(row, signal),
      signal,
      this.logger,
    );
  }

  /** SD-2e `send` cho MỘT dòng đã giữ chỗ: gọi VNPay ngoài transaction → tx2 → STM-10 → ghi. */
  async send(row: LeasedRow, signal?: AbortSignal): Promise<void> {
    const r = (
      await this.db.$client.query<SendRow>(
        `SELECT f.id, f.status, f.kind, f.top_up_id, f.amount_vnd, f.attempt_count,
                f.last_error_kind, f.requested_by, t.credit_account_id, t.gateway_reference,
                t.gateway_transaction_no, t.amount_paid_vnd, t.late_gateway_ref, t.late_amount_vnd,
                t.created_at
         FROM refunds f JOIN top_ups t ON t.id = f.top_up_id WHERE f.id = $1`,
        [row.id],
      )
    ).rows[0];
    if (!r || r.status !== 'requested') return;

    const outcome = await this.callGateway(r, row, signal);
    // `null` = shutdown giữa querydr và gửi: chưa gửi gì. Đã có kết quả thì vẫn chạy tx2 dù signal đã
    // abort: bỏ một kết quả `accepted` có thể dẫn tới hoàn hai lần qua Admin retry. Runner chờ lượt
    // này xong trước khi DbModule đóng pool; pool đã đóng thì tx2 lỗi, dòng giữ lease như khi sập.
    if (outcome === null) return;

    const log = await this.transaction(async (c) => {
      // Khoá bảng cha TRƯỚC `refunds`: `refundLatePayment` giữ `top_ups` rồi INSERT `refunds`, đóng
      // tài khoản giữ `credit_accounts` rồi INSERT `refunds`; ngược thứ tự sẽ deadlock.
      if (outcome.kind === 'done') {
        if (r.kind === 'late_payment')
          await c.query('SELECT 1 FROM top_ups WHERE id = $1 FOR UPDATE', [r.top_up_id]);
        else if (r.kind === 'account_closure')
          await c.query('SELECT 1 FROM credit_accounts WHERE id = $1 FOR UPDATE', [
            r.credit_account_id,
          ]);
      }
      const locked = await lockLeased<LockedRefund>(c, 'refunds', row);
      if (!locked) {
        return {
          level: 'log',
          event: 'refund_lease_lost',
          fields: { refund_id: row.id, outcome: outcome.kind },
        } as RefundLog;
      }
      return this.applyOutcome(c, locked, r, outcome);
    });
    this.log(log.level, log.event, log.fields);
  }

  /**
   * Admin retry (STM-10 #5; route, phân quyền ở Phần 10): `failed → requested`, GIỮ `attempt_count`,
   * `unfinished_claims = 0`, đến hạn ngay. Lượt kế luôn querydr trước.
   *
   * **Admin retry là khẳng định "đã kiểm trên cổng VNPay là chưa hoàn"**: nếu querydr thấy giao dịch
   * trả 01 / 00, lượt này được gửi đúng một lần. Phần 10 phải hiện cảnh báo này trên nút retry.
   *
   * @throws RefundNotFound — không có refund
   * @throws InvalidTransition('STM-10', from, 'ADMIN_RETRY') — trạng thái khác `failed`
   */
  async retry(refundId: number, adminId: number): Promise<RefundRetryResult> {
    const out = await this.transaction(async (c) => {
      const row = (
        await c.query<LockedRefund>(
          'SELECT id, status, kind, top_up_id, attempt_count FROM refunds WHERE id = $1 FOR UPDATE',
          [refundId],
        )
      ).rows[0];
      if (!row) throw new RefundNotFound(refundId);
      const step = this.stm.apply(row.status, 'ADMIN_RETRY');
      await c.query(
        `UPDATE refunds SET status = $2::refund_status, next_attempt_at = now(),
           unfinished_claims = 0, updated_at = now() WHERE id = $1`,
        [refundId, step.to],
      );
      return { refundId, status: step.to, attemptCount: Number(row.attempt_count) };
    });
    this.log('log', 'refund_admin_retry', {
      refund_id: out.refundId,
      admin_id: adminId,
      attempt_count: out.attemptCount,
    });
    try {
      this.kickSend();
    } catch (error) {
      // Đã commit: chạy sớm chỉ là tối ưu, vòng quét vẫn bắt dòng đến hạn.
      this.log('error', 'refund_admin_retry_kick_failed', {
        refund_id: out.refundId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return out;
  }

  /** Gọi VNPay theo `planRound`. `null` = đang shutdown giữa querydr và gửi. */
  private async callGateway(
    r: SendRow,
    row: LeasedRow,
    signal?: AbortSignal,
  ): Promise<RoundOutcome | null> {
    const built = refundInput(r);
    if ('invalid' in built) return { kind: 'data', message: built.invalid };
    const plan = planRound({
      attemptCount: Number(r.attempt_count),
      lastErrorKind: r.last_error_kind,
      unfinishedClaims: row.unfinishedClaims,
    });
    if (plan === 'send') return fromSend(await this.vnpay.refund(built.input, signal));

    const q = await this.vnpay.queryRefundState(built.input, signal);
    switch (q.kind) {
      case 'refunded':
        return {
          kind: 'done',
          refundNo: null,
          viaQuery: true,
          transactionType: q.transactionType,
          transactionStatus: q.transactionStatus,
        };
      case 'refund_rejected':
        return { kind: 'data', message: `vnpay_refund_rejected ts=${q.transactionStatus}` };
      case 'payment_only':
        if (plan === 'query_only') return { kind: 'transient', message: 'querydr_payment_only' };
        if (signal?.aborted) return null;
        return fromSend(await this.vnpay.refund(built.input, signal));
      case 'unresolved':
        return {
          kind: 'transient',
          message: `querydr_unresolved ${q.reason} rc=${q.responseCode ?? '-'}`,
          fields: unverifiedFields(q.unverified),
        };
    }
  }

  /**
   * Hết lượt giữ chỗ (D7): tx riêng của `runLeasedBatch`, dòng đã khoá bằng lease, KHÔNG gọi VNPay.
   * `requested → failed` (#4), `attempt_count = max(+1, RETRY_LIMIT)`. Log sau commit.
   */
  private async onClaimsExhausted(
    c: LedgerClient,
    locked: LockedRefund,
  ): Promise<() => Promise<void>> {
    const id = Number(locked.id);
    const attemptCount = Math.max(Number(locked.attempt_count) + 1, RETRY_LIMIT);
    const step = this.stm.apply(locked.status, 'ATTEMPT_FAILED', {
      errorKind: 'transient',
      attemptCount,
    });
    await c.query(
      `UPDATE refunds SET status = $2::refund_status, attempt_count = $3,
         last_error_kind = 'transient', last_error_message = 'retry_exhausted',
         last_attempt_at = now(), next_attempt_at = NULL, updated_at = now()
       WHERE id = $1`,
      [id, step.to, attemptCount],
    );
    const fields = {
      refund_id: id,
      top_up_id: Number(locked.top_up_id),
      attempt_count: attemptCount,
      reason: 'retry_exhausted',
      unfinished_claims: locked.unfinished_claims ?? null,
    };
    return async () => this.log('error', 'refund_failed', fields);
  }

  /** tx2: áp kết quả lên dòng đã khoá theo lease. */
  private async applyOutcome(
    c: PoolClient,
    locked: LockedRefund,
    r: SendRow,
    outcome: RoundOutcome,
  ): Promise<RefundLog> {
    const id = Number(locked.id);
    const attemptCount = Number(locked.attempt_count) + 1;
    const base = {
      refund_id: id,
      top_up_id: Number(locked.top_up_id),
      attempt_count: attemptCount,
    };

    if (outcome.kind === 'done') {
      const step = this.stm.apply(locked.status, 'GATEWAY_CONFIRMED');
      await c.query(
        `UPDATE refunds SET status = $2::refund_status, gateway_refund_no = $3,
           confirmed_via_query = $4, completed_at = now(), next_attempt_at = NULL,
           attempt_count = $5, last_attempt_at = now(), updated_at = now()
         WHERE id = $1`,
        [id, step.to, outcome.refundNo, outcome.viaQuery, attemptCount],
      );
      if (r.kind === 'late_payment')
        await c.query(
          `UPDATE top_ups t SET late_refunded_at = f.completed_at, updated_at = now()
           FROM refunds f WHERE f.id = $1 AND t.id = f.top_up_id`,
          [id],
        );
      else if (r.kind === 'account_closure')
        await c.query(
          `UPDATE credit_accounts a SET closure_refunded_at = now(), updated_at = now()
           WHERE a.id = $1 AND a.status = 'closed' AND a.closure_refunded_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM refunds f JOIN top_ups t ON t.id = f.top_up_id
               WHERE t.credit_account_id = a.id AND f.kind = 'account_closure'
                 AND f.status <> 'done')`,
          [r.credit_account_id],
        );
      return outcome.viaQuery
        ? {
            level: 'log',
            event: 'refund_done_via_query',
            fields: {
              ...base,
              vnp_TransactionType: outcome.transactionType,
              vnp_TransactionStatus: outcome.transactionStatus,
            },
          }
        : {
            level: 'log',
            event: 'refund_done',
            fields: {
              ...base,
              gateway_refund_no: outcome.refundNo,
              vnp_TransactionStatus: outcome.transactionStatus,
            },
          };
    }

    const step = this.stm.apply(locked.status, 'ATTEMPT_FAILED', {
      errorKind: outcome.kind,
      attemptCount,
    });
    const message = outcome.message.slice(0, LAST_ERROR_MESSAGE_MAX);
    let delayMs: number | null = null;
    if (step.retry) {
      const next = nextRetry(attemptCount);
      if (next.exhausted) throw new Error('refund_retry_schedule_mismatch');
      delayMs = next.delayMs;
    }
    const updated = (
      await c.query<{ next_attempt_at: string | null }>(
        `UPDATE refunds SET status = $2::refund_status, attempt_count = $3,
           last_error_kind = $4::e_invoice_error_kind, last_error_message = $5,
           last_attempt_at = now(),
           next_attempt_at = CASE WHEN $6::bigint IS NULL THEN NULL
                                  ELSE now() + $6::bigint * interval '1 millisecond' END,
           updated_at = now()
         WHERE id = $1
         RETURNING next_attempt_at::text AS next_attempt_at`,
        [id, step.to, attemptCount, outcome.kind, message, delayMs],
      )
    ).rows[0]!;
    const fields = {
      ...base,
      last_error_kind: outcome.kind,
      last_error_message: message,
      ...outcome.fields,
    };
    return step.to === 'failed'
      ? { level: 'error', event: 'refund_failed', fields }
      : {
          level: 'warn',
          event: 'refund_attempt_failed',
          fields: { ...fields, next_attempt_at: updated.next_attempt_at },
        };
  }

  private log(level: 'log' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
    this.logger[level](JSON.stringify({ event, ...fields }));
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
