/**
 * Screen 24 form rules (FE-06, D43: zod), the same as the CSMS (`operator-pricing.ts`).
 * Tariff: effective date, 1–24 periods of band / HH:MM–HH:MM|24:00 / price ≥ 0 that cover the whole
 * day with no gap or overlap (BR-P02). Each coverage problem is reported on the row that causes it.
 * Promotion: code A–Z 0–9 _ - (3–20), percent 0–100 or fixed VND ≥ 0, end after start.
 */
import { z } from 'zod';

export const BANDS = ['off_peak', 'normal', 'peak'] as const;
const START_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const END_RE = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const price = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)), message);

export const tariffSchema = z
  .object({
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Chọn ngày áp dụng'),
    periods: z
      .array(
        z.object({
          band: z.enum(BANDS),
          time_start: z.string().trim().regex(START_RE, 'Giờ dạng HH:MM'),
          time_end: z.string().trim().regex(END_RE, 'Giờ dạng HH:MM hoặc 24:00'),
          price_per_kwh_vnd: price('Giá là số nguyên VND, không âm'),
        }),
      )
      .min(1, 'Cần ít nhất một khung giờ')
      .max(24, 'Tối đa 24 khung giờ'),
  })
  .superRefine((v, ctx) => {
    // Only check coverage once every time is well formed (format errors show first).
    if (v.periods.some((p) => !START_RE.test(p.time_start) || !END_RE.test(p.time_end))) return;
    const order = v.periods
      .map((p, i) => ({ ...p, i }))
      .sort((a, b) => minutes(a.time_start) - minutes(b.time_start));
    let at = 0;
    for (const p of order) {
      const start = minutes(p.time_start);
      const end = minutes(p.time_end);
      if (start !== at) {
        const prev = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
        ctx.addIssue({
          code: 'custom',
          path: ['periods', p.i, 'time_start'],
          message:
            at === 0
              ? 'Khung đầu tiên phải bắt đầu lúc 00:00'
              : start < at
                ? `Chồng lên khung trước (kết thúc ${prev})`
                : `Hở giờ: khung trước kết thúc ${prev}`,
        });
        return;
      }
      if (end <= start) {
        ctx.addIssue({
          code: 'custom',
          path: ['periods', p.i, 'time_end'],
          message: 'Giờ kết thúc phải sau giờ bắt đầu',
        });
        return;
      }
      at = end;
    }
    if (at !== 24 * 60)
      ctx.addIssue({
        code: 'custom',
        path: ['periods', order.at(-1)!.i, 'time_end'],
        message: 'Khung cuối cùng phải kết thúc lúc 24:00',
      });
  });

export type TariffForm = z.input<typeof tariffSchema>;
export type TariffValues = z.output<typeof tariffSchema>;

export const promotionSchema = z
  .object({
    promotion_code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_-]{3,20}$/, 'Mã 3–20 ký tự: chữ in hoa, số, _ -'),
    discount_type: z.enum(['percent', 'fixed_vnd']),
    discount_value: price('Giá trị là số nguyên, không âm'),
    valid_from: z.string().min(1, 'Chọn thời điểm bắt đầu'),
    valid_to: z.string().min(1, 'Chọn thời điểm kết thúc'),
  })
  .superRefine((v, ctx) => {
    if (v.discount_type === 'percent' && Number(v.discount_value) > 100)
      ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'Phần trăm từ 0 đến 100' });
    if (v.valid_from && v.valid_to && new Date(v.valid_to) <= new Date(v.valid_from))
      ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'Kết thúc phải sau bắt đầu' });
  });

export type PromotionForm = z.input<typeof promotionSchema>;
export type PromotionValues = z.output<typeof promotionSchema>;
