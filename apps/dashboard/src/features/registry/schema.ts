/**
 * Screen 29 "Đăng ký trụ" form rules (FE-15, D43: zod), the same as the CSMS (`parseRegisterBody`):
 * serial 3–25 of [A-Za-z0-9._-] after trimming, optional model of at most 20 characters, optional
 * rated power in kW.
 */
import { z } from 'zod';
import { optionalKw, serialField } from '../chargePoints/onboardSchema';
import { MAX_MODEL } from './format';

export const registerSchema = z.object({
  serial_number: serialField,
  model: z.string().trim().max(MAX_MODEL, `Model tối đa ${MAX_MODEL} ký tự`),
  rated_power_kw: optionalKw('Công suất phải là số lớn hơn 0'),
});

export type RegisterForm = z.input<typeof registerSchema>;
export type RegisterValues = z.output<typeof registerSchema>;
