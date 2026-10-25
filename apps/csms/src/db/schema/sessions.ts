/**
 * Module chủ: `sessions`.
 * sessions, session_pauses, meter_values, rfid_cards, vehicles, vehicle_models.
 *
 * `meter_values` là bảng PARTITION theo tháng trên `received_at` (ADR-0007). Drizzle không
 * biểu diễn được partition: định nghĩa ở đây chỉ mô tả cột; `PARTITION BY RANGE` và các
 * partition con nằm trong `drizzle/0000_init.sql`. Hệ quả: PK của bảng là (id, received_at).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  billingModeEnum,
  connectorTypeEnum,
  pauseCauseEnum,
  paymentModeEnum,
  rfidCardKindEnum,
  rfidCardStatusEnum,
  sessionOriginEnum,
  sessionStatusEnum,
} from './enums.js';
import { chargePoints, connectors } from './stations.js';
import { promotions } from './tariffs.js';
import { drivers } from './users.js';

/** Sổ đăng ký thẻ (ADR-0012 gọi là `id_tags`; T11 chốt tên `rfid_cards`). */
export const rfidCards = pgTable(
  'rfid_cards',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Giá trị idTag trên dây (OCPP 1.6: tối đa 20 ký tự). */
    cardIdentifier: text('card_identifier').notNull(),
    cardKind: rfidCardKindEnum('card_kind').notNull(),
    driverId: bigint('driver_id', { mode: 'number' }).references(() => drivers.userId),
    status: rfidCardStatusEnum('status').notNull().default('unlinked'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rfid_cards_card_identifier_key').on(t.cardIdentifier),
    index('rfid_cards_driver_id_idx').on(t.driverId),
    check('rfid_cards_card_identifier_check', sql`char_length(${t.cardIdentifier}) <= 20`),
  ],
);

export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    brand: text('brand').notNull(),
    modelName: text('model_name').notNull(),
    connectorType: connectorTypeEnum('connector_type').notNull().default('ccs2'),
    batteryCapacityKwh: numeric('battery_capacity_kwh', { precision: 6, scale: 2 }),
    ratedRangeKm: integer('rated_range_km'),
    maxDcKw: numeric('max_dc_kw', { precision: 6, scale: 2 }),
    isVinfast: boolean('is_vinfast').notNull().default(false),
  },
  (t) => [unique('vehicle_models_brand_model_name_key').on(t.brand, t.modelName)],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    plateNumber: text('plate_number').notNull(),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    vehicleModelId: bigint('vehicle_model_id', { mode: 'number' })
      .notNull()
      .references(() => vehicleModels.id),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('vehicles_plate_number_key').on(t.plateNumber),
    index('vehicles_driver_id_idx').on(t.driverId),
    // Mỗi tài xế chỉ một xe mặc định.
    uniqueIndex('vehicles_one_default_per_driver')
      .on(t.driverId)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * Phiên sạc = một giao dịch OCPP. `transaction_no` là transactionId CSMS cấp cho trụ
 * (sequence riêng, kiểu integer vì OCPP 1.6 dùng int32).
 *
 * Khoá chống trùng StartTransaction (ADR-0010):
 * UNIQUE (charge_point_id, connector_no, id_tag, meter_start_wh, cp_started_at).
 * Bộ ba (connector_id, charge_point_id, connector_no) được FK tổng hợp giữ nhất quán.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    transactionNo: integer('transaction_no')
      .notNull()
      .default(sql`nextval('sessions_transaction_no_seq')`),
    connectorId: bigint('connector_id', { mode: 'number' }).notNull(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    connectorNo: smallint('connector_no').notNull(),
    /** idTag nguyên văn trong StartTransaction — kể cả khi không tra được thẻ. */
    idTag: text('id_tag').notNull(),
    driverId: bigint('driver_id', { mode: 'number' }).references(() => drivers.userId),
    vehicleId: bigint('vehicle_id', { mode: 'number' }).references(() => vehicles.id),
    rfidCardId: bigint('rfid_card_id', { mode: 'number' }).references(() => rfidCards.id),
    promotionId: bigint('promotion_id', { mode: 'number' }).references(() => promotions.id),
    origin: sessionOriginEnum('origin').notNull(),
    paymentMode: paymentModeEnum('payment_mode').notNull(),
    billingMode: billingModeEnum('billing_mode').notNull().default('full'),
    /** Ý nghĩa theo billing_mode: phút (timed) · Wh (energy_kwh) · VND (amount_vnd). Null khi full. */
    limitValue: bigint('limit_value', { mode: 'number' }),
    status: sessionStatusEnum('status').notNull().default('pending'),
    /** Đồng hồ trụ lúc StartTransaction — không tin cậy (ADR-0009). */
    cpStartedAt: timestamp('cp_started_at', { withTimezone: true }).notNull(),
    /** Đồng hồ CSMS lúc nhận StartTransaction — tin cậy. */
    receivedStartedAt: timestamp('received_started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Lần ĐẦU phiên sang orphaned (đồng hồ CSMS); giữ nguyên khi orphaned → active. Null = chưa từng. */
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
    cpStoppedAt: timestamp('cp_stopped_at', { withTimezone: true }),
    receivedStoppedAt: timestamp('received_stopped_at', { withTimezone: true }),
    meterStartWh: bigint('meter_start_wh', { mode: 'number' }).notNull(),
    meterStopWh: bigint('meter_stop_wh', { mode: 'number' }),
    /** Reason của StopTransaction, giữ nguyên văn (trụ báo gì cũng ghi được). */
    stopReason: text('stop_reason'),
    /** Do engine đối soát gán — phiên được trụ gửi bù sau khi nối lại (ADR-0009). */
    deliveredOffline: boolean('delivered_offline').notNull().default(false),
    /** Dẫn xuất = meter_stop_wh - meter_start_wh; cập nhật cùng transaction với lúc đóng phiên. */
    energyWh: bigint('energy_wh', { mode: 'number' }),
    /** Dẫn xuất = SUM(session_tariff_segments.amount_vnd) trừ khuyến mãi; cập nhật cùng transaction với ledger. */
    totalCostVnd: bigint('total_cost_vnd', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sessions_transaction_no_key').on(t.transactionNo),
    // ADR-0010 — khoá tự nhiên chống StartTransaction phát lại.
    unique('sessions_start_tx_natural_key').on(
      t.chargePointId,
      t.connectorNo,
      t.idTag,
      t.meterStartWh,
      t.cpStartedAt,
    ),
    foreignKey({
      name: 'sessions_connector_fk',
      columns: [t.connectorId, t.chargePointId, t.connectorNo],
      foreignColumns: [connectors.id, connectors.chargePointId, connectors.connectorNo],
    }),
    index('sessions_connector_id_received_started_at_idx').on(t.connectorId, t.receivedStartedAt),
    index('sessions_driver_id_idx').on(t.driverId),
    index('sessions_status_idx').on(t.status),
    check(
      'sessions_meter_check',
      sql`${t.meterStopWh} IS NULL OR ${t.meterStopWh} >= ${t.meterStartWh}`,
    ),
    check('sessions_limit_value_check', sql`${t.limitValue} IS NULL OR ${t.limitValue} > 0`),
  ],
);

/** Khoảng tạm dừng trong phiên (SuspendedEV / SuspendedEVSE). Bảng thật, không JSON (T11). */
export const sessionPauses = pgTable(
  'session_pauses',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id),
    pausedAt: timestamp('paused_at', { withTimezone: true }).notNull(),
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
    pauseCause: pauseCauseEnum('pause_cause').notNull(),
  },
  (t) => [
    unique('session_pauses_session_id_paused_at_key').on(t.sessionId, t.pausedAt),
    check(
      'session_pauses_resumed_check',
      sql`${t.resumedAt} IS NULL OR ${t.resumedAt} >= ${t.pausedAt}`,
    ),
  ],
);

/**
 * Lịch sử chuyển trạng thái phiên (BM02 F13, migration 0001): mỗi chuyển state machine chấp nhận
 * = một dòng, ghi cùng transaction với UPDATE sessions.status. Append-only (trigger chặn
 * UPDATE/DELETE); FK ON DELETE RESTRICT vì CASCADE sẽ đụng trigger chặn DELETE.
 * `fromStatus` null cho chuyển từ INITIAL (T13 #1, #2). `occurredAt` = đồng hồ CSMS.
 */
export const sessionStatusHistory = pgTable(
  'session_status_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    fromStatus: sessionStatusEnum('from_status'),
    toStatus: sessionStatusEnum('to_status').notNull(),
    /** Tên event của state machine: START_TRANSACTION, STATION_OFFLINE, RECONCILE_OK… */
    event: text('event').notNull(),
    /** station = frame của trụ · system = CSMS tự quyết · hoặc users.id (operator). */
    actor: text('actor').notNull().default('system'),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_status_history_session_id_occurred_at_idx').on(t.sessionId, t.occurredAt)],
);

/**
 * Một SampledValue của MeterValues = một dòng. PARTITION BY RANGE (received_at) — xem SQL.
 * Business key (session_id, cp_timestamp, measurand) của ERD KHÔNG thể là UNIQUE trên bảng
 * partition vì Postgres bắt UNIQUE phải chứa khoá partition; dedupe là việc của engine đối soát
 * (reconciliation_records.record_type = duplicate). Ở đây chỉ có index thường.
 */
export const meterValues = pgTable(
  'meter_values',
  {
    id: bigint('id', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id),
    /** Đồng hồ trụ (`timestamp` của MeterValue) — không tin cậy. */
    cpTimestamp: timestamp('cp_timestamp', { withTimezone: true }).notNull(),
    /** Đồng hồ CSMS — tin cậy; đồng thời là khoá partition. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Measurand OCPP nguyên văn: Energy.Active.Import.Register, Power.Active.Import, SoC, Voltage, Current.Import... */
    measurand: text('measurand').notNull(),
    value: numeric('value', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit'),
    context: text('context'),
    phase: text('phase'),
    /** ReplayDetector phán frame chứa mẫu này là phát lại. Dòng trước migration 0001 = false (chưa phân loại). */
    replayed: boolean('replayed').notNull().default(false),
    /** charge_point_connections.epoch lúc frame tới; null với dòng trước migration 0001. */
    epoch: integer('epoch'),
  },
  (t) => [
    primaryKey({ name: 'meter_values_pkey', columns: [t.id, t.receivedAt] }),
    index('meter_values_session_id_cp_timestamp_idx').on(t.sessionId, t.cpTimestamp, t.measurand),
  ],
);
