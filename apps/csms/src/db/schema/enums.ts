/**
 * Enum Postgres (`CREATE TYPE ... AS ENUM`) dùng chung cho toàn schema.
 *
 * Giá trị PHẢI khớp chính xác với state machine T12/T13 và migration
 * `drizzle/0000_init.sql` + `drizzle/0001_quyet-dinh-be-11.sql`. Thêm giá trị mới = thêm
 * migration `ALTER TYPE ... ADD VALUE` (giá trị mới không dùng được trong cùng transaction).
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// ---- users ----
export const userRoleEnum = pgEnum('user_role', ['driver', 'operator_staff', 'admin']);
export const userAccountStatusEnum = pgEnum('user_account_status', [
  'active',
  'suspended',
  'closed',
]);
export const staffRoleEnum = pgEnum('staff_role', ['manager', 'technician']);

// ---- stations ----
export const operatorStatusEnum = pgEnum('operator_status', ['active', 'suspended', 'closed']);
export const chargePointLifecycleEnum = pgEnum('charge_point_lifecycle', [
  'registered',
  'awaiting_connection',
  'in_service',
  'offline',
  'disabled',
  'decommissioned',
]);
/** Đủ 9 giá trị ChargePointStatus của OCPP 1.6, giữ nguyên chữ hoa/thường (T13). */
export const connectorStatusEnum = pgEnum('connector_status', [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);
export const connectorTypeEnum = pgEnum('connector_type', ['ccs2', 'chademo', 'gbt', 'type2']);

// ---- sessions ----
export const sessionStatusEnum = pgEnum('session_status', [
  'pending',
  'active',
  'paused',
  'stopping',
  'closed',
  'review',
  'reconciled',
  'orphaned',
  'failed',
]);
export const sessionOriginEnum = pgEnum('session_origin', [
  'app_qr',
  'rfid',
  'hmi_password',
  'free_vend',
]);
export const paymentModeEnum = pgEnum('payment_mode', [
  'csms_billed',
  'station_wallet',
  'free',
  'unattributed',
]);
export const billingModeEnum = pgEnum('billing_mode', [
  'full',
  'timed',
  'energy_kwh',
  'amount_vnd',
]);
export const pauseCauseEnum = pgEnum('pause_cause', ['ev', 'evse']);
export const rfidCardKindEnum = pgEnum('rfid_card_kind', ['online', 'wallet', 'free_vend']);
export const rfidCardStatusEnum = pgEnum('rfid_card_status', ['unlinked', 'active', 'blocked']);

// ---- tariffs ----
export const tariffBandEnum = pgEnum('tariff_band', ['off_peak', 'normal', 'peak']);
export const discountTypeEnum = pgEnum('discount_type', ['percent', 'fixed_vnd']);

// ---- reconciliation ----
export const reconciliationRecordTypeEnum = pgEnum('reconciliation_record_type', [
  'replay',
  'duplicate',
  'meter_gap',
  'orphan_stop',
  'unknown_id_tag',
  'conflict',
  'late_sample',
]);

// ---- billing ----
export const creditAccountStatusEnum = pgEnum('credit_account_status', [
  'active',
  'in_shortfall',
  'closed',
]);
export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'top_up',
  'session_debit',
  'refund',
  'adjustment',
]);
export const topUpStatusEnum = pgEnum('top_up_status', [
  'pending',
  'credited',
  'failed',
  'expired',
  'refunded',
]);
export const eInvoiceStatusEnum = pgEnum('e_invoice_status', [
  'requested',
  'issued',
  'failed',
  'needs_review',
]);
export const loyaltyTransactionTypeEnum = pgEnum('loyalty_transaction_type', [
  'earn',
  'redeem',
  'expire',
  'adjust',
]);

// ---- ops ----
export const faultSourceEnum = pgEnum('fault_source', ['ocpp', 'driver_report', 'operator']);
export const faultEventStatusEnum = pgEnum('fault_event_status', [
  'raised',
  'acknowledged',
  'resetting',
  'resolved',
]);
export const maintenanceTicketStatusEnum = pgEnum('maintenance_ticket_status', [
  'open',
  'in_progress',
  'closed',
]);
export const reservationStatusEnum = pgEnum('reservation_status', [
  'active',
  'fulfilled',
  'cancelled_free',
  'cancelled_late',
  'expired_no_show',
  'voided',
]);
export const reservationHoldModeEnum = pgEnum('reservation_hold_mode', [
  'reserve_now',
  'csms_only',
]);

// ---- ocpp-gateway ----
export const ocppDirectionEnum = pgEnum('ocpp_direction', ['in', 'out']);
/** Vòng đời lệnh CSMS → trụ (bảng remote_commands, migration 0001). */
export const remoteCommandStatusEnum = pgEnum('remote_command_status', [
  'pending',
  'sent',
  'accepted',
  'rejected',
  'timeout',
  'failed',
]);
