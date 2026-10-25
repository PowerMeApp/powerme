/**
 * Module chủ: `ocpp-gateway`.
 *
 * `ocpp_message_log` — nhật ký mọi frame OCPP cả hai chiều, ghi TRƯỚC khi gọi handler
 * (ADR-0005). Append-only: chỉ INSERT, không UPDATE/DELETE, trừ xoá partition cũ.
 * PARTITION BY RANGE (received_at) theo tháng (ADR-0007) — chỉ có trong SQL viết tay;
 * hệ quả: PK là (id, received_at).
 *
 * Cột khớp định dạng trace của lab (`apps/csms/lab/README.md`): received_at, cp, dir, type,
 * id, action, cp_timestamp, epoch, raw.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ocppDirectionEnum, remoteCommandStatusEnum } from './enums.js';
import { chargePoints } from './stations.js';
import { users } from './users.js';

export const ocppMessageLog = pgTable(
  'ocpp_message_log',
  {
    id: bigint('id', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    /** Lần kết nối (charge_point_connections.epoch) lúc frame đi qua. */
    epoch: integer('epoch').notNull(),
    direction: ocppDirectionEnum('direction').notNull(),
    /** 2 = CALL · 3 = CALLRESULT · 4 = CALLERROR. */
    messageType: smallint('message_type').notNull(),
    /** MessageId của frame OCPP-J; dùng ghép CALL với CALLRESULT/CALLERROR. */
    uniqueId: text('unique_id').notNull(),
    /** Chỉ có ở CALL (type 2). */
    action: text('action'),
    /** Trường timestamp trong payload nếu có — đồng hồ trụ, không tin cậy. */
    cpTimestamp: timestamp('cp_timestamp', { withTimezone: true }),
    /** Đồng hồ CSMS; khoá partition. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Frame nguyên văn, đã parse JSON. */
    raw: jsonb('raw').notNull(),
    /**
     * Phán quyết ReplayDetector lúc ghi; null = không phân loại được (không có cp_timestamp, hoặc
     * không phải CALL chiều vào). Phải truyền ngay lúc INSERT vì bảng append-only.
     */
    replayed: boolean('replayed'),
  },
  (t) => [
    primaryKey({ name: 'ocpp_message_log_pkey', columns: [t.id, t.receivedAt] }),
    index('ocpp_message_log_cp_received_at_idx').on(t.chargePointId, t.receivedAt),
    index('ocpp_message_log_cp_unique_id_idx').on(t.chargePointId, t.uniqueId),
    index('ocpp_message_log_action_idx').on(t.action, t.receivedAt),
    check('ocpp_message_log_message_type_check', sql`${t.messageType} IN (2, 3, 4)`),
    check('ocpp_message_log_action_check', sql`(${t.messageType} = 2) = (${t.action} IS NOT NULL)`),
  ],
);

/**
 * `remote_commands` — lệnh CSMS → trụ, bất đồng bộ (API trả `202 + commandId`, kết quả cập nhật
 * dòng này): pending → sent → accepted | rejected | timeout | failed (BM02 F08, migration 0001).
 * Chỉ có bảng; code gửi lệnh là việc của BE-04.
 */
export const remoteCommands = pgTable(
  'remote_commands',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chargePointId: bigint('charge_point_id', { mode: 'number' })
      .notNull()
      .references(() => chargePoints.id),
    /** Null = lệnh cho cả trụ; 0 = connector 0 của OCPP. */
    connectorNo: smallint('connector_no'),
    /** Tên action OCPP nguyên văn (RemoteStartTransaction, Reset, TriggerMessage, DataTransfer…). */
    action: text('action').notNull(),
    payload: jsonb('payload'),
    status: remoteCommandStatusEnum('status').notNull().default('pending'),
    /** users.id người/hệ thống yêu cầu; null = CSMS tự phát sinh. */
    requestedBy: bigint('requested_by', { mode: 'number' }).references(() => users.id),
    /** Chống tạo trùng khi client retry. */
    idempotencyKey: text('idempotency_key'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /** Payload CALLRESULT của trụ. */
    response: jsonb('response'),
    error: text('error'),
  },
  (t) => [
    // DESC mặc định của Postgres là NULLS FIRST; Drizzle sinh NULLS LAST nếu không nói rõ → nói rõ.
    index('remote_commands_cp_requested_at_idx').on(
      t.chargePointId,
      t.requestedAt.desc().nullsFirst(),
    ),
    index('remote_commands_in_flight_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('pending', 'sent')`),
    uniqueIndex('remote_commands_idempotency_key_key')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    check(
      'remote_commands_connector_no_check',
      sql`${t.connectorNo} IS NULL OR ${t.connectorNo} IN (0, 1, 2)`,
    ),
    check(
      'remote_commands_sent_check',
      sql`${t.sentAt} IS NULL OR ${t.sentAt} >= ${t.requestedAt}`,
    ),
    check(
      'remote_commands_responded_check',
      sql`${t.respondedAt} IS NULL OR (${t.sentAt} IS NOT NULL AND ${t.respondedAt} >= ${t.sentAt})`,
    ),
  ],
);
