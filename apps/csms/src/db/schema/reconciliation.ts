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
import { users } from './users.js';

export const reconciliationRecords = pgTable(
  'reconciliation_records',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id),
    /** Số thứ tự trong phiên, bắt đầu từ 1. */
    recordNo: smallint('record_no').notNull(),
    recordType: reconciliationRecordTypeEnum('record_type').notNull(),
    gapStart: timestamp('gap_start', { withTimezone: true }),
    gapEnd: timestamp('gap_end', { withTimezone: true }),
    /** Chênh lệch Wh giữa chuỗi meter và meter_stop - meter_start; integer Wh (ADR-0009). */
    energyDifferenceWh: bigint('energy_difference_wh', { mode: 'number' }),
    /** Người vận hành xử lý (users.id với role operator_staff/admin). Null = chưa xử lý. */
    reviewedBy: bigint('reviewed_by', { mode: 'number' }).references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('reconciliation_records_session_id_record_no_key').on(t.sessionId, t.recordNo),
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
