/**
 * Module chủ: `billing` (WP5).
 * credit_accounts, credit_transactions, top_ups, e_invoices, invoice_adjustments,
 * loyalty_accounts, loyalty_transactions.
 *
 * Mọi số tiền là VND integer (`bigint`, ADR-0009). Cột dẫn xuất (/x trong ERD) — balance_vnd,
 * balance_after_vnd, amount_paid_vnd, points_balance — là cột thường, phải cập nhật CÙNG
 * transaction với dòng ledger tương ứng.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  creditAccountStatusEnum,
  creditTransactionTypeEnum,
  eInvoiceErrorKindEnum,
  eInvoiceStatusEnum,
  loyaltyTransactionTypeEnum,
  topUpStatusEnum,
} from './enums.js';
import { sessions } from './sessions.js';
import { drivers, users } from './users.js';

/** Ví tín dụng — đúng một ví cho mỗi tài xế (UNIQUE driver_id). */
export const creditAccounts = pgTable(
  'credit_accounts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    status: creditAccountStatusEnum('status').notNull().default('active'),
    /** Dẫn xuất = SUM(credit_transactions.amount_vnd); cập nhật cùng transaction với dòng ledger. */
    balanceVnd: bigint('balance_vnd', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Lúc ví đóng (UC-ACC-02). Có giá trị ⇔ status = closed (migration 0003). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Lúc Admin hoàn xong số dư chưa dùng khi đóng ví (BR-P21); không trước closed_at. */
    closureRefundedAt: timestamp('closure_refunded_at', { withTimezone: true }),
  },
  (t) => [
    unique('credit_accounts_driver_id_key').on(t.driverId),
    check(
      'credit_accounts_closed_check',
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
    check(
      'credit_accounts_closure_refunded_check',
      sql`${t.closureRefundedAt} IS NULL OR (${t.closedAt} IS NOT NULL AND ${t.closureRefundedAt} >= ${t.closedAt})`,
    ),
  ],
);

/** Nạp tiền qua cổng thanh toán (VNPay sandbox, QA-04). */
export const topUps = pgTable(
  'top_ups',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /**
     * vnp_TxnRef — mã do CSMS sinh lúc tạo top-up (SD-2a); BK, UNIQUE, NOT NULL từ migration 0003.
     * (Trước 0003 cột này mô tả là vnp_TransactionNo; nay mã đó nằm ở `gatewayTransactionNo`.)
     */
    gatewayReference: text('gateway_reference').notNull(),
    creditAccountId: bigint('credit_account_id', { mode: 'number' })
      .notNull()
      .references(() => creditAccounts.id),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    /** Số điểm thưởng dùng cho top-up (BR-P35); `pointsDiscountVnd` là tiền giảm tương ứng. */
    pointsRedeemed: integer('points_redeemed').notNull().default(0),
    pointsDiscountVnd: bigint('points_discount_vnd', { mode: 'number' }).notNull().default(0),
    /** Dẫn xuất = amount_vnd - points_discount_vnd; ghi lúc tạo top-up. */
    amountPaidVnd: bigint('amount_paid_vnd', { mode: 'number' }).notNull(),
    status: topUpStatusEnum('status').notNull().default('pending'),
    /** Khoá chống tạo trùng từ app khi retry (UNIQUE). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** vnp_TransactionNo — mã giao dịch phía VNPay, ghi khi IPN/querydr báo đã trả (SD-2b). */
    gatewayTransactionNo: text('gateway_transaction_no'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Hết hạn thanh toán (BR-P13: tạo + 15 phút). Không có DEFAULT — TopUpService đặt. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Lúc Admin hoàn top-up (STM-4 #7). Có giá trị ⇔ status = refunded. */
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** users.id của Admin hoàn (UC-ADM-08); DB không kiểm role. */
    refundedBy: bigint('refunded_by', { mode: 'number' }).references(() => users.id),
    /** Thanh toán tới sau cửa sổ 1 giờ (BR-P13, SD-2c D): ba cột late_* ghi cùng lúc. UNIQUE. */
    lateGatewayRef: text('late_gateway_ref'),
    latePaidAt: timestamp('late_paid_at', { withTimezone: true }),
    lateAmountVnd: bigint('late_amount_vnd', { mode: 'number' }),
    lateRefundedAt: timestamp('late_refunded_at', { withTimezone: true }),
  },
  (t) => [
    unique('top_ups_gateway_reference_key').on(t.gatewayReference),
    unique('top_ups_idempotency_key_key').on(t.idempotencyKey),
    unique('top_ups_late_gateway_ref_key').on(t.lateGatewayRef),
    index('top_ups_credit_account_id_idx').on(t.creditAccountId),
    check(
      'top_ups_amount_check',
      sql`${t.amountVnd} > 0 AND ${t.pointsDiscountVnd} >= 0 AND ${t.amountPaidVnd} = ${t.amountVnd} - ${t.pointsDiscountVnd}`,
    ),
    check('top_ups_points_redeemed_check', sql`${t.pointsRedeemed} >= 0`),
    check('top_ups_expires_at_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'top_ups_refunded_check',
      sql`(${t.status} = 'refunded') = (${t.refundedAt} IS NOT NULL)`,
    ),
    check('top_ups_refunded_by_check', sql`${t.refundedBy} IS NULL OR ${t.refundedAt} IS NOT NULL`),
    check(
      'top_ups_late_payment_check',
      sql`(${t.lateGatewayRef} IS NULL AND ${t.latePaidAt} IS NULL AND ${t.lateAmountVnd} IS NULL) OR (${t.lateGatewayRef} IS NOT NULL AND ${t.latePaidAt} IS NOT NULL AND ${t.lateAmountVnd} IS NOT NULL AND ${t.lateAmountVnd} >= 0)`,
    ),
    check(
      'top_ups_late_refunded_check',
      sql`${t.lateRefundedAt} IS NULL OR (${t.latePaidAt} IS NOT NULL AND ${t.lateRefundedAt} >= ${t.latePaidAt})`,
    ),
  ],
);

/** Sổ cái ví tín dụng, append-only. entry_no tăng dần trong từng ví. */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    creditAccountId: bigint('credit_account_id', { mode: 'number' })
      .notNull()
      .references(() => creditAccounts.id),
    entryNo: bigint('entry_no', { mode: 'number' }).notNull(),
    transactionType: creditTransactionTypeEnum('transaction_type').notNull(),
    /** Dương = cộng ví, âm = trừ ví. */
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    /** Dẫn xuất = số dư sau dòng này; cập nhật cùng transaction với credit_accounts.balance_vnd. */
    balanceAfterVnd: bigint('balance_after_vnd', { mode: 'number' }).notNull(),
    sessionId: bigint('session_id', { mode: 'number' }).references(() => sessions.id),
    topUpId: bigint('top_up_id', { mode: 'number' }).references(() => topUps.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('credit_transactions_account_entry_no_key').on(t.creditAccountId, t.entryNo),
    // Một phiên tối đa một dòng trừ tiền.
    uniqueIndex('credit_transactions_one_debit_per_session')
      .on(t.sessionId)
      .where(sql`${t.transactionType} = 'session_debit'`),
    // Một top-up tối đa một dòng mỗi loại: một `top_up` + một `refund` (migration 0003, SD-2c E).
    uniqueIndex('credit_transactions_one_per_top_up_and_type')
      .on(t.topUpId, t.transactionType)
      .where(sql`${t.topUpId} IS NOT NULL`),
    check(
      'credit_transactions_session_debit_check',
      sql`${t.transactionType} <> 'session_debit' OR ${t.sessionId} IS NOT NULL`,
    ),
    check(
      'credit_transactions_top_up_check',
      sql`${t.transactionType} <> 'top_up' OR ${t.topUpId} IS NOT NULL`,
    ),
  ],
);

/** Hoá đơn điện tử cho top-up đã credited — một hoá đơn cho mỗi top-up (UNIQUE top_up_id). */
export const eInvoices = pgTable(
  'e_invoices',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Số hoá đơn do nhà cung cấp HĐĐT cấp; null khi còn `requested`/`failed`. */
    invoiceNo: text('invoice_no'),
    topUpId: bigint('top_up_id', { mode: 'number' })
      .notNull()
      .references(() => topUps.id),
    status: eInvoiceStatusEnum('status').notNull().default('requested'),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    vatAmountVnd: bigint('vat_amount_vnd', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Lỗi lần gọi gần nhất (BR-P44, SD-2b): transient = tự thử lại · data = needs_review. */
    lastErrorKind: eInvoiceErrorKindEnum('last_error_kind'),
    lastErrorMessage: text('last_error_message'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  },
  (t) => [
    unique('e_invoices_invoice_no_key').on(t.invoiceNo),
    unique('e_invoices_top_up_id_key').on(t.topUpId),
    check(
      'e_invoices_issued_check',
      sql`${t.status} <> 'issued' OR (${t.invoiceNo} IS NOT NULL AND ${t.issuedAt} IS NOT NULL)`,
    ),
    check(
      'e_invoices_last_error_check',
      sql`${t.lastErrorKind} IS NULL OR ${t.lastAttemptAt} IS NOT NULL`,
    ),
  ],
);

export const invoiceAdjustments = pgTable(
  'invoice_adjustments',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    eInvoiceId: bigint('e_invoice_id', { mode: 'number' })
      .notNull()
      .references(() => eInvoices.id),
    adjustmentNo: smallint('adjustment_no').notNull(),
    reason: text('reason').notNull(),
    /** Dương = điều chỉnh tăng, âm = giảm. */
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoice_adjustments_invoice_adjustment_no_key').on(t.eInvoiceId, t.adjustmentNo),
    check('invoice_adjustments_adjustment_no_check', sql`${t.adjustmentNo} >= 1`),
  ],
);

/** Tài khoản điểm thưởng — đúng một cho mỗi tài xế. */
export const loyaltyAccounts = pgTable(
  'loyalty_accounts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    /** Dẫn xuất = SUM(loyalty_transactions.points); cập nhật cùng transaction với ledger. */
    pointsBalance: bigint('points_balance', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('loyalty_accounts_driver_id_key').on(t.driverId)],
);

export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    loyaltyAccountId: bigint('loyalty_account_id', { mode: 'number' })
      .notNull()
      .references(() => loyaltyAccounts.id),
    entryNo: bigint('entry_no', { mode: 'number' }).notNull(),
    transactionType: loyaltyTransactionTypeEnum('transaction_type').notNull(),
    /** Dương = cộng điểm, âm = trừ điểm. */
    points: bigint('points', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    sessionId: bigint('session_id', { mode: 'number' }).references(() => sessions.id),
    topUpId: bigint('top_up_id', { mode: 'number' }).references(() => topUps.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('loyalty_transactions_account_entry_no_key').on(t.loyaltyAccountId, t.entryNo),
    index('loyalty_transactions_session_id_idx').on(t.sessionId),
    index('loyalty_transactions_top_up_id_idx').on(t.topUpId),
  ],
);
