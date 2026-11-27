import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { sessions } from './sessions.js';
import { creditAccounts } from './billing.js';
import { remoteCommands } from './ocpp-log.js';

export const rfidCreditHolds = pgTable(
  'rfid_credit_holds',
  {
    sessionId: bigint('session_id', { mode: 'number' })
      .primaryKey()
      .references(() => sessions.id),
    creditAccountId: bigint('credit_account_id', { mode: 'number' })
      .notNull()
      .references(() => creditAccounts.id),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    state: varchar('state', { length: 16 }).notNull().default('held'),
    reason: varchar('reason', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    check('rfid_credit_holds_amount_vnd_check', sql`${t.amountVnd}>=0`),
    check('rfid_credit_holds_state_check', sql`${t.state} IN ('held','released')`),
    check(
      'rfid_credit_holds_release_check',
      sql`(${t.state}='released')=(${t.releasedAt} IS NOT NULL)`,
    ),
    index('rfid_credit_holds_account_idx').on(t.creditAccountId),
    index('rfid_credit_holds_outstanding_account_idx')
      .on(t.creditAccountId, t.sessionId)
      .where(sql`${t.state}='held'`),
  ],
);
export const rfidStopJobs = pgTable(
  'rfid_stop_jobs',
  {
    sessionId: bigint('session_id', { mode: 'number' })
      .primaryKey()
      .references(() => sessions.id),
    reason: varchar('reason', { length: 64 }).notNull(),
    state: varchar('state', { length: 20 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    attemptLimit: integer('attempt_limit').notNull(),
    currentCommandId: bigint('current_command_id', { mode: 'number' }).references(
      () => remoteCommands.id,
    ),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'rfid_stop_jobs_state_check',
      sql`${t.state} IN ('pending','inflight','awaiting_stop','retry','exhausted','completed')`,
    ),
    check(
      'rfid_stop_jobs_attempts_check',
      sql`${t.attempts}>=0 AND ${t.attempts}<=${t.attemptLimit}`,
    ),
    check('rfid_stop_jobs_attempt_limit_check', sql`${t.attemptLimit}>0`),
    check(
      'rfid_stop_jobs_exhausted_check',
      sql`${t.state}<>'exhausted' OR ${t.exhaustedAt} IS NOT NULL`,
    ),
    index('rfid_stop_jobs_command_idx').on(t.currentCommandId),
    index('rfid_stop_jobs_due_idx')
      .on(t.nextAttemptAt, t.sessionId)
      .where(sql`${t.state} NOT IN ('completed','exhausted')`),
  ],
);
