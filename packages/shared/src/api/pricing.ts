/**
 * Pricing & Promotions (UC-OPS-06/07, screen 24, FE-06) — types only, snake_case as on the wire.
 * Source: apps/csms/src/operator-api/operator-pricing.ts.
 */

/** BR-P02: three time-of-day bands (DB `tariff_band`). */
export type TariffBand = 'off_peak' | 'normal' | 'peak';

export interface TariffPeriod {
  band: TariffBand;
  /** HH:MM, local time (Asia/Ho_Chi_Minh). */
  time_start: string;
  /** HH:MM or 24:00 (end of day), exclusive. */
  time_end: string;
  price_per_kwh_vnd: number;
}

/** One schedule: periods covering the whole day from `effective_from`. */
export interface TariffSchedule {
  effective_from: string;
  effective_to: string | null;
  periods: TariffPeriod[];
}

/** GET /api/operator/v1/tariffs */
export interface TariffScheduleView {
  current: TariffSchedule | null;
  upcoming: TariffSchedule[];
}

/** PUT /api/operator/v1/tariffs */
export interface TariffScheduleRequest {
  effective_from: string;
  periods: TariffPeriod[];
}

export type DiscountType = 'percent' | 'fixed_vnd';

export interface Promotion {
  id: string;
  promotion_code: string;
  discount_type: DiscountType;
  /** percent: 0–100; fixed_vnd: VND. */
  discount_value: number;
  valid_from: string;
  valid_to: string;
  /** valid_from ≤ now < valid_to */
  active: boolean;
}

export interface PromotionPage {
  items: Promotion[];
  total: number;
  page: number;
  page_size: number;
}

export interface PromotionCreate {
  promotion_code: string;
  discount_type: DiscountType;
  discount_value: number;
  valid_from: string;
  valid_to: string;
}

/** The code never changes. */
export type PromotionPatch = Partial<Omit<PromotionCreate, 'promotion_code'>>;
