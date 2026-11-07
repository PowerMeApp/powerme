/**
 * Module chủ: `users`.
 *
 * Quyết định T11: MỘT bảng `users` có cột `role`, cộng các bảng mở rộng theo subtype —
 * `drivers`, `operator_staff`. T11 ban đầu KHÔNG có `admins`; Ân duyệt 31/10/2026 ("ERD Alignment
 * Decisions", Physical ERD v1.0) thêm `admins` (migration 0011) cho đủ ba subtype.
 */
import { bigint, index, pgTable, text, timestamp, unique, varchar } from 'drizzle-orm/pg-core';
import { staffRoleEnum, userAccountStatusEnum, userRoleEnum } from './enums.js';
import { operators } from './stations.js';

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    email: varchar('email', { length: 254 }).notNull(),
    fullName: text('full_name').notNull(),
    phoneNumber: varchar('phone_number', { length: 16 }),
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
  consentVersion: varchar('consent_version', { length: 20 }).notNull(),
  consentGivenAt: timestamp('consent_given_at', { withTimezone: true }).notNull(),
});

/**
 * Bảng mở rộng của User với role = admin. PK = FK tới users (migration 0011, ERD alignment).
 * Không có thuộc tính riêng: bảng tồn tại để các FK "chỉ Admin" (vd policy_templates.created_by,
 * B1 — Nghĩa) có đích thật thay vì trỏ users và dựa vào role.
 */
export const admins = pgTable('admins', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
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
