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
  eInvoiceStatusEnum,
  loyaltyTransactionTypeEnum,
  topUpStatusEnum,
} from './enums.js';
import { sessions } from './sessions.js';
import { drivers } from './users.js';

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
  },
  (t) => [unique('credit_accounts_driver_id_key').on(t.driverId)],
);

/** Nạp tiền qua cổng thanh toán (VNPay sandbox, QA-04). */
export const topUps = pgTable(
  'top_ups',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Mã giao dịch phía cổng (vnp_TransactionNo). Null tới khi cổng trả về; UNIQUE khi có. */
    gatewayReference: text('gateway_reference'),
    creditAccountId: bigint('credit_account_id', { mode: 'number' })
      .notNull()
      .references(() => creditAccounts.id),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    pointsDiscountVnd: bigint('points_discount_vnd', { mode: 'number' }).notNull().default(0),
    /** Dẫn xuất = amount_vnd - points_discount_vnd; ghi lúc tạo top-up. */
    amountPaidVnd: bigint('amount_paid_vnd', { mode: 'number' }).notNull(),
    status: topUpStatusEnum('status').notNull().default('pending'),
    /** Khoá chống tạo trùng từ app khi retry (UNIQUE). */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('top_ups_gateway_reference_key').on(t.gatewayReference),
    unique('top_ups_idempotency_key_key').on(t.idempotencyKey),
    index('top_ups_credit_account_id_idx').on(t.creditAccountId),
    check(
      'top_ups_amount_check',
      sql`${t.amountVnd} > 0 AND ${t.pointsDiscountVnd} >= 0 AND ${t.amountPaidVnd} = ${t.amountVnd} - ${t.pointsDiscountVnd}`,
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
    // Một top-up tối đa một dòng ledger.
    uniqueIndex('credit_transactions_one_per_top_up')
      .on(t.topUpId)
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
  },
  (t) => [
    unique('e_invoices_invoice_no_key').on(t.invoiceNo),
    unique('e_invoices_top_up_id_key').on(t.topUpId),
    check(
      'e_invoices_issued_check',
      sql`${t.status} <> 'issued' OR (${t.invoiceNo} IS NOT NULL AND ${t.issuedAt} IS NOT NULL)`,
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
