/**
 * Module chủ: `stations`.
 * operators, sites, charge_points, connectors, connector_status_events, charge_point_connections.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  chargePointLifecycleEnum,
  connectorStatusEnum,
  connectorTypeEnum,
  operatorStatusEnum,
} from './enums.js';

export const operators = pgTable(
  'operators',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taxCode: text('tax_code').notNull(),
    legalName: text('legal_name').notNull(),
    address: text('address'),
    status: operatorStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('operators_tax_code_key').on(t.taxCode)],
);

export const sites = pgTable(
  'sites',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    siteCode: text('site_code').notNull(),
    operatorId: bigint('operator_id', { mode: 'number' })
      .notNull()
      .references(() => operators.id),
    siteName: text('site_name').notNull(),
    address: text('address'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sites_site_code_key').on(t.siteCode),
    index('sites_operator_id_idx').on(t.operatorId),
  ],
);

/**
 * Trụ sạc (ChargingPillar trong ERD). Định danh kỹ thuật = serial_number (ADR-0009),
 * xuất hiện ở cuối URL `/ocpp/{serialNumber}`. `display_code` là mã người vận hành đọc.
 */
export const chargePoints = pgTable(
  'charge_points',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    serialNumber: text('serial_number').notNull(),
    /** `PM-{model}-{tỉnh}-{số thứ tự}`, ví dụ PM-D1-HCM-0001 (ADR-0009). Null tới khi onboard xong. */
    displayCode: text('display_code'),
    /** Null cho tới khi trụ được gắn vào site (onboarding). */
    siteId: bigint('site_id', { mode: 'number' }).references(() => sites.id),
    model: text('model'),
    firmwareVersion: text('firmware_version'),
    ratedPowerKw: numeric('rated_power_kw', { precision: 7, scale: 2 }),
    warrantyUntil: date('warranty_until'),
    lifecycle: chargePointLifecycleEnum('lifecycle').notNull().default('registered'),
    /** idTag mà trụ gửi khi ở chế độ free vend (ADR-0012). Null = trụ không bật free vend. */
    freeVendTag: text('free_vend_tag'),
    reportsSoc: boolean('reports_soc').notNull().default(false),
    supportsReservation: boolean('supports_reservation').notNull().default(false),
    /** Lần kết nối hiện tại; tăng 1 mỗi lần trụ nối lại. Khớp charge_point_connections.epoch. */
    currentEpoch: integer('current_epoch').notNull().default(0),
    /** Băm scrypt của mật khẩu Basic Auth, dạng `scrypt$N$r$p$salt$hash` (Security Profile 2, ADR-0011 sửa 25/10). Chỉ hiển thị một lần lúc onboarding. */
    basicAuthPasswordHash: text('basic_auth_password_hash'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('charge_points_serial_number_key').on(t.serialNumber),
    unique('charge_points_display_code_key').on(t.displayCode),
    index('charge_points_site_id_idx').on(t.siteId),
  ],
);

/**
 * Súng sạc. connector_no ∈ {1, 2} — `0` là toàn trụ theo OCPP 1.6 và KHÔNG phải một súng,
 * nên không có dòng ở đây (xem connector_status_events.connector_no cho sự kiện toàn trụ).
 */
export const connectors = pgTable(
  'connectors',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    connectorNo: smallint('connector_no').notNull(),
    connectorType: connectorTypeEnum('connector_type').notNull().default('ccs2'),
    maxPowerKw: numeric('max_power_kw', { precision: 7, scale: 2 }),
    status: connectorStatusEnum('status').notNull().default('Unavailable'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  },
  (t) => [
    unique('connectors_charge_point_id_connector_no_key').on(t.chargePointId, t.connectorNo),
    // Siêu khoá để sessions tham chiếu bộ ba (connector_id, charge_point_id, connector_no)
    // và đảm bảo ba cột ấy luôn nhất quán (khoá ADR-0010 dùng charge_point_id + connector_no).
    unique('connectors_id_charge_point_id_connector_no_key').on(
      t.id,
      t.chargePointId,
      t.connectorNo,
    ),
    check('connectors_connector_no_check', sql`${t.connectorNo} IN (1, 2)`),
  ],
);

/**
 * Nhật ký StatusNotification. CSMS phản chiếu, không từ chối: chuyển trạng thái bất thường
 * so với bảng OCPP được ghi và gắn cờ `unexpected_transition` (T13).
 * connector_no = 0 là sự kiện toàn trụ → connector_id NULL.
 */
export const connectorStatusEvents = pgTable(
  'connector_status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    connectorNo: smallint('connector_no').notNull(),
    connectorId: bigint('connector_id', { mode: 'number' }).references(() => connectors.id),
    status: connectorStatusEnum('status').notNull(),
    errorCode: text('error_code').notNull().default('NoError'),
    vendorErrorCode: text('vendor_error_code'),
    info: text('info'),
    /** Đồng hồ trụ (`timestamp` trong payload) — KHÔNG tin cậy (ADR-0009). */
    cpTimestamp: timestamp('cp_timestamp', { withTimezone: true }),
    /** Đồng hồ CSMS — tin cậy (ADR-0009). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    unexpectedTransition: boolean('unexpected_transition').notNull().default(false),
  },
  (t) => [
    unique('connector_status_events_cp_no_received_key').on(
      t.chargePointId,
      t.connectorNo,
      t.receivedAt,
    ),
    index('connector_status_events_connector_id_received_at_idx').on(t.connectorId, t.receivedAt),
    check('connector_status_events_connector_no_check', sql`${t.connectorNo} IN (0, 1, 2)`),
    check(
      'connector_status_events_connector_id_check',
      sql`(${t.connectorNo} = 0) = (${t.connectorId} IS NULL)`,
    ),
  ],
);

/**
 * Mỗi lần trụ mở WebSocket = một epoch. Nền của phát hiện phát lại (EXP-01):
 * bản tin có cp_timestamp sớm hơn opened_at của epoch hiện tại là ứng viên replay.
 */
export const chargePointConnections = pgTable(
  'charge_point_connections',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    epoch: integer('epoch').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Mã đóng WebSocket hoặc lý do CSMS tự đóng (ví dụ `1012 superseded`). */
    closeReason: text('close_reason'),
    remoteAddress: text('remote_address'),
  },
  (t) => [
    unique('charge_point_connections_charge_point_id_epoch_key').on(t.chargePointId, t.epoch),
    index('charge_point_connections_opened_at_idx').on(t.chargePointId, t.openedAt),
  ],
);
