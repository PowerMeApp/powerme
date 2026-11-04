/**
 * Module chủ: `billing` (WP5).
 * credit_accounts, credit_transactions, top_ups, refunds (0015), e_invoices, invoice_adjustments,
 * loyalty_accounts, loyalty_transactions.
 *
 * Việc nền (refund, e-invoice, điều chỉnh) chạy bằng quét DB (WF-02 decisions D7): `status` +
 * `next_attempt_at` nằm trên dòng nghiệp vụ, có index `(status, next_attempt_at)`.
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
  varchar,
} from 'drizzle-orm/pg-core';
import {
  creditAccountStatusEnum,
  creditTransactionTypeEnum,
  eInvoiceErrorKindEnum,
  eInvoiceStatusEnum,
  loyaltyTransactionTypeEnum,
  refundKindEnum,
  refundStatusEnum,
  topUpStatusEnum,
} from './enums.js';
import { reservations } from './ops.js';
import { sessions } from './sessions.js';
import { admins, drivers } from './users.js';

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
    /**
     * Lúc mọi refund `account_closure` của ví đã `done` (BR-P21, SD-2f; nghĩa mới từ 0015 — hệ
     * thống tự hoàn, Admin không thao tác); không trước closed_at.
     */
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
    gatewayReference: varchar('gateway_reference', { length: 100 }).notNull(),
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
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    /** vnp_TransactionNo — mã phía VNPay, ghi khi IPN/querydr báo đã trả (SD-2b). UNIQUE khi có. */
    gatewayTransactionNo: varchar('gateway_transaction_no', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Hết hạn thanh toán (BR-P13: tạo + 15 phút). Không có DEFAULT — TopUpService đặt. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Lúc Admin quyết định hoàn top-up (STM-4 #7). Có giá trị ⇔ status = refunded. Admin nào:
     * refunds.requestedBy (kind top_up) — cột refunded_by bỏ ở 0015 (B5).
     */
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    /** Thanh toán sau cửa sổ 1 giờ (BR-P13, SD-2c D): ba cột late_* ghi cùng lúc, chỉ khi expired. */
    lateGatewayRef: varchar('late_gateway_ref', { length: 100 }),
    latePaidAt: timestamp('late_paid_at', { withTimezone: true }),
    lateAmountVnd: bigint('late_amount_vnd', { mode: 'number' }),
    /** Lúc refund `late_payment` của top-up chuyển `done` (SD-2e, nghĩa từ 0015). */
    lateRefundedAt: timestamp('late_refunded_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('top_ups_gateway_reference_key').on(t.gatewayReference),
    unique('top_ups_idempotency_key_key').on(t.idempotencyKey),
    unique('top_ups_late_gateway_ref_key').on(t.lateGatewayRef),
    // Một giao dịch VNPay cộng cho đúng một top-up (BR-P13); partial vì NULL tới khi cổng báo trả.
    uniqueIndex('top_ups_gateway_transaction_no_key')
      .on(t.gatewayTransactionNo)
      .where(sql`${t.gatewayTransactionNo} IS NOT NULL`),
    index('top_ups_credit_account_id_idx').on(t.creditAccountId),
    // Quét top-up pending quá hạn 15 phút (SD-2d, D7; migration 0015).
    index('top_ups_status_expires_at_idx').on(t.status, t.expiresAt),
    check(
      'top_ups_amount_check',
      sql`${t.amountVnd} > 0 AND ${t.pointsDiscountVnd} >= 0 AND ${t.amountPaidVnd} = ${t.amountVnd} - ${t.pointsDiscountVnd}`,
    ),
    check('top_ups_points_redeemed_check', sql`${t.pointsRedeemed} >= 0`),
    // Có điểm ⇔ có giảm giá (BR-P35); tỉ lệ điểm/VND là chính sách, không ghi cứng.
    check('top_ups_points_check', sql`(${t.pointsRedeemed} = 0) = (${t.pointsDiscountVnd} = 0)`),
    check('top_ups_expires_at_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'top_ups_refunded_check',
      sql`(${t.status} = 'refunded') = (${t.refundedAt} IS NOT NULL)`,
    ),
    check(
      'top_ups_late_payment_check',
      sql`(${t.lateGatewayRef} IS NULL AND ${t.latePaidAt} IS NULL AND ${t.lateAmountVnd} IS NULL) OR (${t.lateGatewayRef} IS NOT NULL AND ${t.latePaidAt} IS NOT NULL AND ${t.lateAmountVnd} IS NOT NULL AND ${t.lateAmountVnd} >= 0)`,
    ),
    check(
      'top_ups_late_refunded_check',
      sql`${t.lateRefundedAt} IS NULL OR (${t.latePaidAt} IS NOT NULL AND ${t.lateRefundedAt} >= ${t.latePaidAt})`,
    ),
    // Chỉ top-up expired nhận khoản muộn (SD-2c D). Cửa sổ 1 giờ do service kiểm (tham số cấu hình).
    check(
      'top_ups_late_payment_status_check',
      sql`${t.lateGatewayRef} IS NULL OR ${t.status} = 'expired'`,
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
      .references(() => creditAccounts.id, { onDelete: 'restrict' }),
    entryNo: bigint('entry_no', { mode: 'number' }).notNull(),
    transactionType: creditTransactionTypeEnum('transaction_type').notNull(),
    /** Dương = cộng ví, âm = trừ ví. */
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    /** Dẫn xuất = số dư sau dòng này; cập nhật cùng transaction với credit_accounts.balance_vnd. */
    balanceAfterVnd: bigint('balance_after_vnd', { mode: 'number' }).notNull(),
    sessionId: bigint('session_id', { mode: 'number' }).references(() => sessions.id),
    topUpId: bigint('top_up_id', { mode: 'number' }).references(() => topUps.id),
    /**
     * Đặt chỗ mà dòng phí no-show này thu (migration 0011, BR-P27/P29). Có giá trị ⇔
     * transaction_type = 'reservation_fee'; UNIQUE ⇒ mỗi reservation tối đa một khoản phí.
     */
    reservationId: bigint('reservation_id', { mode: 'number' }).references(() => reservations.id),
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
    // BR-P27/P29: phí no-show ⇔ có reservation_id; một khoản phí cho mỗi reservation.
    unique('credit_transactions_reservation_id_key').on(t.reservationId),
    check(
      'credit_transactions_reservation_fee_check',
      sql`(${t.transactionType} = 'reservation_fee') = (${t.reservationId} IS NOT NULL)`,
    ),
  ],
);

/** Hoá đơn điện tử cho top-up đã credited — một hoá đơn cho mỗi top-up (UNIQUE top_up_id). */
export const eInvoices = pgTable(
  'e_invoices',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Số hoá đơn do nhà cung cấp HĐĐT cấp; null khi còn `requested`/`failed`. */
    invoiceNo: varchar('invoice_no', { length: 20 }),
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
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Lúc worker được xử lý (D7, 0015): now() khi tạo, +5 phút / 30 phút / 2 giờ sau lỗi tạm thời. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique('e_invoices_invoice_no_key').on(t.invoiceNo),
    unique('e_invoices_top_up_id_key').on(t.topUpId),
    index('e_invoices_status_next_attempt_at_idx').on(t.status, t.nextAttemptAt),
    check(
      'e_invoices_issued_check',
      sql`${t.status} <> 'issued' OR (${t.invoiceNo} IS NOT NULL AND ${t.issuedAt} IS NOT NULL)`,
    ),
    check(
      'e_invoices_last_error_check',
      sql`${t.lastErrorKind} IS NULL OR ${t.lastAttemptAt} IS NOT NULL`,
    ),
    check(
      'e_invoices_next_attempt_check',
      sql`${t.status} NOT IN ('requested', 'failed') OR ${t.nextAttemptAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Hoàn tiền về nguồn thanh toán (STM-10, migration 0015). Tạo cùng transaction với quyết định hoàn
 * (D1 phần 1); `RefundService.send` gọi VNPay từ worker quét DB (D1 phần 2, D7).
 */
export const refunds = pgTable(
  'refunds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    topUpId: bigint('top_up_id', { mode: 'number' })
      .notNull()
      .references(() => topUps.id),
    kind: refundKindEnum('kind').notNull(),
    /** VND > 0; không vượt số đã trả của top-up (RefundService kiểm, DB không kiểm chéo bảng). */
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    status: refundStatusEnum('status').notNull().default('requested'),
    /** Số lần đã gọi VNPay refund; tối đa 4, Admin retry không reset. */
    attemptCount: integer('attempt_count').notNull().default(0),
    /**
     * admins.user_id của Admin quyết định hoàn (thay top_ups.refunded_by, B5);
     * NULL = hệ thống tạo (account_closure, SD-2f).
     */
    requestedBy: bigint('requested_by', { mode: 'number' }).references(() => admins.userId),
    /** Dùng chung enum với e_invoices: transient = hẹn thử lại · data = bị từ chối → failed. */
    lastErrorKind: eInvoiceErrorKindEnum('last_error_kind'),
    lastErrorMessage: text('last_error_message'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** Mã hoàn VNPay trả về; bắt buộc khi done, UNIQUE. */
    gatewayRefundNo: varchar('gateway_refund_no', { length: 20 }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Có giá trị ⇔ status = done. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('refunds_gateway_refund_no_key').on(t.gatewayRefundNo),
    // Mỗi top-up hoàn tối đa một lần theo từng loại do Admin quyết; account_closure không chặn.
    uniqueIndex('refunds_one_per_top_up_and_kind')
      .on(t.topUpId, t.kind)
      .where(sql`${t.kind} IN ('top_up', 'late_payment')`),
    index('refunds_top_up_id_idx').on(t.topUpId),
    index('refunds_requested_by_idx').on(t.requestedBy),
    index('refunds_status_next_attempt_at_idx').on(t.status, t.nextAttemptAt),
    check('refunds_amount_check', sql`${t.amountVnd} > 0`),
    check('refunds_attempt_count_check', sql`${t.attemptCount} >= 0`),
    check(
      'refunds_requested_by_check',
      sql`${t.kind} = 'account_closure' OR ${t.requestedBy} IS NOT NULL`,
    ),
    check('refunds_completed_check', sql`(${t.status} = 'done') = (${t.completedAt} IS NOT NULL)`),
    check(
      'refunds_gateway_refund_no_check',
      sql`${t.status} <> 'done' OR ${t.gatewayRefundNo} IS NOT NULL`,
    ),
    check(
      'refunds_last_error_check',
      sql`${t.lastErrorKind} IS NULL OR ${t.lastAttemptAt} IS NOT NULL`,
    ),
    check(
      'refunds_next_attempt_check',
      sql`${t.status} <> 'requested' OR ${t.nextAttemptAt} IS NOT NULL`,
    ),
  ],
);

/** Điều chỉnh hoá đơn, tạo sau khi refund done (D5); trạng thái và retry giống e_invoices (STM-7). */
export const invoiceAdjustments = pgTable(
  'invoice_adjustments',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    eInvoiceId: bigint('e_invoice_id', { mode: 'number' })
      .notNull()
      .references(() => eInvoices.id, { onDelete: 'restrict' }),
    adjustmentNo: smallint('adjustment_no').notNull(),
    reason: text('reason').notNull(),
    /** Dương = điều chỉnh tăng, âm = giảm. */
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    /** Từ 0015: NULL tới khi issued (trước là NOT NULL DEFAULT now()). */
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    /** Refund đã done sinh ra điều chỉnh này (Refund 1 – 0..1 InvoiceAdjustment). */
    refundId: bigint('refund_id', { mode: 'number' }).references(() => refunds.id),
    status: eInvoiceStatusEnum('status').notNull().default('requested'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastErrorKind: eInvoiceErrorKindEnum('last_error_kind'),
    lastErrorMessage: text('last_error_message'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
    /** Số điều chỉnh do nhà cung cấp HĐĐT cấp; bắt buộc khi issued. */
    providerAdjustmentNo: varchar('provider_adjustment_no', { length: 20 }),
    /** Thêm ở 0015 (C2): issued_at nay NULL tới khi issued nên cần thời điểm tạo riêng. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('invoice_adjustments_invoice_adjustment_no_key').on(t.eInvoiceId, t.adjustmentNo),
    unique('invoice_adjustments_refund_id_key').on(t.refundId),
    unique('invoice_adjustments_provider_adjustment_no_key').on(t.providerAdjustmentNo),
    index('invoice_adjustments_status_next_attempt_at_idx').on(t.status, t.nextAttemptAt),
    check('invoice_adjustments_adjustment_no_check', sql`${t.adjustmentNo} >= 1`),
    check('invoice_adjustments_attempt_count_check', sql`${t.attemptCount} >= 0`),
    check(
      'invoice_adjustments_issued_check',
      sql`${t.status} <> 'issued' OR (${t.issuedAt} IS NOT NULL AND ${t.providerAdjustmentNo} IS NOT NULL)`,
    ),
    check(
      'invoice_adjustments_last_error_check',
      sql`${t.lastErrorKind} IS NULL OR ${t.lastAttemptAt} IS NOT NULL`,
    ),
    check(
      'invoice_adjustments_next_attempt_check',
      sql`${t.status} NOT IN ('requested', 'failed') OR ${t.nextAttemptAt} IS NOT NULL`,
    ),
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
      .references(() => loyaltyAccounts.id, { onDelete: 'restrict' }),
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
