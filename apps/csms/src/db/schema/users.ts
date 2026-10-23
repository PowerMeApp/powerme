/**
 * Module chủ: `users`.
 *
 * Quyết định T11: MỘT bảng `users` có cột `role`, cộng hai bảng mở rộng chỉ khi subtype
 * có thuộc tính riêng — `drivers`, `operator_staff`. KHÔNG có bảng `admins`
 * (Admin không có thuộc tính riêng; `role = 'admin'` là đủ).
 */
import { bigint, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { staffRoleEnum, userAccountStatusEnum, userRoleEnum } from './enums.js';
import { operators } from './stations.js';

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phoneNumber: text('phone_number'),
    role: userRoleEnum('role').notNull(),
    accountStatus: userAccountStatusEnum('account_status').notNull().default('active'),
    /** Băm argon2; null với tài khoản chưa đặt mật khẩu (đăng nhập OTP / social). */
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('users_email_key').on(t.email), index('users_phone_number_idx').on(t.phoneNumber)],
);

/** Bảng mở rộng của User với role = driver. PK = FK tới users. */
export const drivers = pgTable('drivers', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  consentVersion: text('consent_version').notNull(),
  consentGivenAt: timestamp('consent_given_at', { withTimezone: true }).notNull(),
});

/** Bảng mở rộng của User với role = operator_staff. PK = FK tới users. */
export const operatorStaff = pgTable(
  'operator_staff',
  {
    userId: bigint('user_id', { mode: 'number' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    operatorId: bigint('operator_id', { mode: 'number' })
      .notNull()
      .references(() => operators.id),
    staffRole: staffRoleEnum('staff_role').notNull(),
  },
  (t) => [index('operator_staff_operator_id_idx').on(t.operatorId)],
);
