/**
 * Screen 28 form rules (FE-19, D43: zod), the same as the CSMS (`admin-user-actions.ts`): email
 * ≤ 254, full name 1–100, optional phone (the server normalises it), initial password 8–128; staff
 * need an Operator and manager / technician; lock / unlock need a note of 1–500 characters.
 */
import { z } from 'zod';

const roleFields = {
  role: z.enum(['operator_staff', 'admin']),
  operator_id: z.string(),
  staff_role: z.enum(['manager', 'technician']),
};

/** Operator and staff role are required only for operator staff. */
function staffNeedsOperator(
  v: { role: 'operator_staff' | 'admin'; operator_id: string },
  ctx: z.RefinementCtx,
) {
  if (v.role === 'operator_staff' && !v.operator_id)
    ctx.addIssue({ code: 'custom', path: ['operator_id'], message: 'Chọn Operator' });
}

export const createUserSchema = z
  .object({
    email: z.string().trim().max(254, 'Tối đa 254 ký tự').email('Email không hợp lệ'),
    full_name: z.string().trim().min(1, 'Nhập họ tên').max(100, 'Tối đa 100 ký tự'),
    phone_number: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\+?[0-9 .()-]{9,20}$/.test(v), 'Số điện thoại không hợp lệ'),
    initial_password: z.string().min(8, 'Ít nhất 8 ký tự').max(128, 'Tối đa 128 ký tự'),
    ...roleFields,
  })
  .superRefine(staffNeedsOperator);
export type CreateUserForm = z.input<typeof createUserSchema>;
export type CreateUserValues = z.output<typeof createUserSchema>;

export const editUserSchema = z.object({
  full_name: z.string().trim().min(1, 'Nhập họ tên').max(100, 'Tối đa 100 ký tự'),
  phone_number: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\+?[0-9 .()-]{9,20}$/.test(v), 'Số điện thoại không hợp lệ'),
});
export type EditUserForm = z.input<typeof editUserSchema>;

export const roleSchema = z.object(roleFields).superRefine(staffNeedsOperator);
export type RoleForm = z.input<typeof roleSchema>;
export type RoleValues = z.output<typeof roleSchema>;

export const noteSchema = z.object({
  note: z.string().trim().min(1, 'Nhập ghi chú').max(500, 'Tối đa 500 ký tự'),
});
export type NoteForm = z.input<typeof noteSchema>;
