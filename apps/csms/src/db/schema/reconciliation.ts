/**
 * Module chủ: `reconciliation`.
 * reconciliation_records — kết quả của engine đối soát (BE-07): replay, duplicate, meter_gap,
 * orphan_stop, unknown_id_tag (ADR-0012).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { reconciliationRecordTypeEnum } from './enums.js';
import { sessions } from './sessions.js';
import { operatorStaff } from './users.js';

export const reconciliationRecords = pgTable(
  'reconciliation_records',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    /** Số thứ tự trong phiên, bắt đầu từ 1. */
    recordNo: smallint('record_no').notNull(),
    recordType: reconciliationRecordTypeEnum('record_type').notNull(),
    gapStart: timestamp('gap_start', { withTimezone: true }),
    gapEnd: timestamp('gap_end', { withTimezone: true }),
    /** Chênh lệch Wh giữa chuỗi meter và meter_stop - meter_start; integer Wh (ADR-0009). */
    energyDifferenceWh: bigint('energy_difference_wh', { mode: 'number' }),
    /**
     * Nhân viên vận hành xử lý (operator_staff.user_id). Null = chưa xử lý. D14 / migration 0012:
     * chỉ operator_staff duyệt — trước đây trỏ users và chỉ dựa vào role.
     */
    reviewedBy: bigint('reviewed_by', { mode: 'number' }).references(() => operatorStaff.userId),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('reconciliation_records_session_id_record_no_key').on(t.sessionId, t.recordNo),
    index('reconciliation_records_reviewed_by_idx').on(t.reviewedBy),
    index('reconciliation_records_unreviewed_idx')
      .on(t.recordType, t.createdAt)
      .where(sql`${t.reviewedAt} IS NULL`),
    check('reconciliation_records_record_no_check', sql`${t.recordNo} >= 1`),
    check(
      'reconciliation_records_reviewed_check',
      sql`(${t.reviewedBy} IS NULL) = (${t.reviewedAt} IS NULL)`,
    ),
  ],
);
