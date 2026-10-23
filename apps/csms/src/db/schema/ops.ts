/**
 * Module chủ: `stations` (fault_events, fault_reports, maintenance_tickets, reservations)
 * và `users` (policy_templates) — gom một file vì cùng thuộc LERD-2 Operations & Administration.
 *
 * maintenance_tickets, policy_templates, reservations là «Should» trong ERD: vẫn tạo với
 * thuộc tính tối thiểu để ERD và DB khớp nhau.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  faultEventStatusEnum,
  faultSourceEnum,
  maintenanceTicketStatusEnum,
  reservationHoldModeEnum,
  reservationStatusEnum,
} from './enums.js';
import { chargePoints, connectors } from './stations.js';
import { drivers, operatorStaff, users } from './users.js';

/** Sự cố trên trụ/súng: từ StatusNotification Faulted, từ báo cáo tài xế, hoặc do operator tạo. */
export const faultEvents = pgTable(
  'fault_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    eventNo: bigint('event_no', { mode: 'number' })
      .notNull()
      .default(sql`nextval('fault_events_event_no_seq')`),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    connectorId: bigint('connector_id', { mode: 'number' }).references(() => connectors.id),
    source: faultSourceEnum('source').notNull(),
    /** ChargePointErrorCode của OCPP 1.6 hoặc mã do nguồn khác cung cấp; giữ nguyên văn. */
    errorCode: text('error_code'),
    status: faultEventStatusEnum('status').notNull().default('raised'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedBy: bigint('acknowledged_by', { mode: 'number' }).references(
      () => operatorStaff.userId,
    ),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    unique('fault_events_event_no_key').on(t.eventNo),
    index('fault_events_charge_point_id_raised_at_idx').on(t.chargePointId, t.raisedAt),
    index('fault_events_open_idx')
      .on(t.status)
      .where(sql`${t.status} <> 'resolved'`),
  ],
);

/** Tài xế báo lỗi từ app; có thể được gắn vào một fault_event. */
export const faultReports = pgTable(
  'fault_reports',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    reportNo: bigint('report_no', { mode: 'number' })
      .notNull()
      .default(sql`nextval('fault_reports_report_no_seq')`),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    connectorId: bigint('connector_id', { mode: 'number' })
      .notNull()
      .references(() => connectors.id),
    description: text('description').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
    faultEventId: bigint('fault_event_id', { mode: 'number' }).references(() => faultEvents.id),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: bigint('cleared_by', { mode: 'number' }).references(() => operatorStaff.userId),
  },
  (t) => [
    unique('fault_reports_report_no_key').on(t.reportNo),
    index('fault_reports_connector_id_idx').on(t.connectorId),
    index('fault_reports_fault_event_id_idx').on(t.faultEventId),
  ],
);

/** «Should» — phiếu bảo trì mở từ một fault_event. */
export const maintenanceTickets = pgTable(
  'maintenance_tickets',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ticketNo: bigint('ticket_no', { mode: 'number' })
      .notNull()
      .default(sql`nextval('maintenance_tickets_ticket_no_seq')`),
    faultEventId: bigint('fault_event_id', { mode: 'number' })
      .notNull()
      .references(() => faultEvents.id),
    /** Null khi phiếu mở mà chưa giao cho ai. */
    assignedTo: bigint('assigned_to', { mode: 'number' }).references(() => operatorStaff.userId),
    status: maintenanceTicketStatusEnum('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    unique('maintenance_tickets_ticket_no_key').on(t.ticketNo),
    index('maintenance_tickets_fault_event_id_idx').on(t.faultEventId),
    check(
      'maintenance_tickets_closed_check',
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
  ],
);

/** «Should» — mẫu chính sách (điều khoản, thông báo) do admin soạn. */
export const policyTemplates = pgTable(
  'policy_templates',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    templateCode: text('template_code').notNull(),
    /** users.id với role = admin (không có bảng admins — T11). */
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    templateType: text('template_type').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('policy_templates_template_code_key').on(t.templateCode)],
);

/**
 * «Should» — đặt chỗ súng sạc. reservation_no là reservationId gửi xuống trụ (int32 OCPP).
 * EXP-02: tính duy nhất "một đặt chỗ active cho mỗi connector và mỗi driver" phải nằm ở DB
 * (partial UNIQUE WHERE status = 'active'), không ở thư viện.
 */
export const reservations = pgTable(
  'reservations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    reservationNo: integer('reservation_no')
      .notNull()
      .default(sql`nextval('reservations_reservation_no_seq')`),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    connectorId: bigint('connector_id', { mode: 'number' })
      .notNull()
      .references(() => connectors.id),
    status: reservationStatusEnum('status').notNull().default('active'),
    /** reserve_now: gửi ReserveNow xuống trụ · csms_only: chỉ giữ chỗ phía CSMS (trụ không hỗ trợ). */
    holdMode: reservationHoldModeEnum('hold_mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('reservations_reservation_no_key').on(t.reservationNo),
    uniqueIndex('reservations_one_active_per_connector')
      .on(t.connectorId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('reservations_one_active_per_driver')
      .on(t.driverId)
      .where(sql`${t.status} = 'active'`),
    check('reservations_expires_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
