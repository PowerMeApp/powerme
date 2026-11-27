/**
 * Screen 19 form rules (FE-02, D43: zod), the same as the CSMS (`parseOnboardBody` and
 * `ChargePointOnboardingService.validateConnectors`): serial 3–25 of [A-Za-z0-9._-] after trimming,
 * one of the Operator's stations, 1–2 connectors numbered 1 / 2, optional power in kW.
 */
import { z } from 'zod';

/** OCPP identity = Basic-auth user name (`serialField` in console.router.ts). */
export const SERIAL_RE = /^[A-Za-z0-9._-]{3,25}$/;
/** numeric(7, 2) columns (rated_power_kw, max_power_kw). */
export const MAX_KW = 99_999.99;

export const serialField = z
  .string()
  .trim()
  .regex(SERIAL_RE, 'Serial 3–25 ký tự: chữ, số, dấu . _ -');

/** Optional kW as typed: empty, or a number above 0 and at most MAX_KW. */
export const optionalKw = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      if (v === '') return true;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= MAX_KW;
    }, message);

export const CONNECTOR_TYPES = ['ccs2', 'chademo', 'gbt', 'type2'] as const;

export const onboardSchema = z.object({
  serial_number: serialField,
  site_id: z.string().min(1, 'Chọn một trạm sạc'),
  connectors: z
    .array(
      z.object({
        connector_no: z.union([z.literal(1), z.literal(2)]),
        connector_type: z.enum(CONNECTOR_TYPES),
        max_power_kw: optionalKw('Công suất phải lớn hơn 0 kW'),
      }),
    )
    .min(1, 'Trụ có 1 hoặc 2 súng')
    .max(2, 'Trụ có 1 hoặc 2 súng'),
});

export type OnboardForm = z.input<typeof onboardSchema>;
export type OnboardValues = z.output<typeof onboardSchema>;
