/**
 * Module chủ: `tariffs` (WP5).
 * tariff_periods, promotions, session_tariff_segments.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { discountTypeEnum, tariffBandEnum } from './enums.js';
import { sessions } from './sessions.js';
import { operators } from './stations.js';

/** Khung giá theo giờ trong ngày của một operator. Giá VND/kWh integer (ADR-0009). */
export const tariffPeriods = pgTable(
  'tariff_periods',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    operatorId: bigint('operator_id', { mode: 'number' })
      .notNull()
      .references(() => operators.id),
    band: tariffBandEnum('band').notNull(),
    /** Giờ địa phương Asia/Ho_Chi_Minh; khung qua nửa đêm thì tách thành hai dòng. */
    timeStart: time('time_start').notNull(),
    timeEnd: time('time_end').notNull(),
    pricePerKwhVnd: bigint('price_per_kwh_vnd', { mode: 'number' }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
  },
  (t) => [
    unique('tariff_periods_operator_band_range_key').on(
      t.operatorId,
      t.band,
      t.timeStart,
      t.timeEnd,
      t.effectiveFrom,
    ),
    check('tariff_periods_price_check', sql`${t.pricePerKwhVnd} >= 0`),
    check(
      'tariff_periods_effective_check',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

export const promotions = pgTable(
  'promotions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    promotionCode: text('promotion_code').notNull(),
    operatorId: bigint('operator_id', { mode: 'number' })
      .notNull()
      .references(() => operators.id),
    discountType: discountTypeEnum('discount_type').notNull(),
    /** percent: 0..100 · fixed_vnd: số VND integer. */
    discountValue: bigint('discount_value', { mode: 'number' }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('promotions_promotion_code_key').on(t.promotionCode),
    index('promotions_operator_id_idx').on(t.operatorId),
    check(
      'promotions_discount_value_check',
      sql`${t.discountValue} >= 0 AND (${t.discountType} <> 'percent' OR ${t.discountValue} <= 100)`,
    ),
    check('promotions_valid_check', sql`${t.validTo} > ${t.validFrom}`),
  ],
);

/** Phiên cắt theo khung giá: một phiên qua nhiều khung giờ thì có nhiều segment. */
export const sessionTariffSegments = pgTable(
  'session_tariff_segments',
  {
    sessionId: bigint('session_id', { mode: 'number' })
      .notNull()
      .references(() => sessions.id),
    tariffPeriodId: bigint('tariff_period_id', { mode: 'number' })
      .notNull()
      .references(() => tariffPeriods.id),
    segmentStart: timestamp('segment_start', { withTimezone: true }).notNull(),
    segmentEnd: timestamp('segment_end', { withTimezone: true }).notNull(),
    energyWh: bigint('energy_wh', { mode: 'number' }).notNull(),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    exactAmountMilliVnd: numeric('exact_amount_milli_vnd', { precision: 40, scale: 0 }),
  },
  (t) => [
    primaryKey({
      name: 'session_tariff_segments_pkey',
      columns: [t.sessionId, t.tariffPeriodId, t.segmentStart],
    }),
    check('session_tariff_segments_range_check', sql`${t.segmentEnd} >= ${t.segmentStart}`),
    check('session_tariff_segments_nonneg_check', sql`${t.energyWh} >= 0 AND ${t.amountVnd} >= 0`),
  ],
);
