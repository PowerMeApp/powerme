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
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { ocppDirectionEnum } from './enums.js';
import { chargePoints } from './stations.js';

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
