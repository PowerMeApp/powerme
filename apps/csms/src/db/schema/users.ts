/**
 * Module chủ: `users`.
 *
 * Quyết định T11: MỘT bảng `users` có cột `role`, cộng các bảng mở rộng theo subtype —
 * `drivers`, `operator_staff`. T11 ban đầu KHÔNG có `admins`; Ân duyệt 31/10/2026 ("ERD Alignment
 * Decisions", Physical ERD v1.0) thêm `admins` (migration 0011) cho đủ ba subtype.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { staffRoleEnum, userAccountStatusEnum, userRoleEnum } from './enums.js';
import { operators } from './stations.js';

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    email: varchar('email', { length: 254 }).notNull(),
    fullName: text('full_name').notNull(),
    /** E.164, chuẩn hoá bởi Driver API (BE-30, `driver/phone-number.ts`); UNIQUE từ 0017. */
    phoneNumber: varchar('phone_number', { length: 16 }),
    role: userRoleEnum('role').notNull(),
    accountStatus: userAccountStatusEnum('account_status').notNull().default('active'),
    /** Băm scrypt (`scrypt$N$r$p$salt$hash`, ADR-0011); null khi chưa đặt mật khẩu. */
    passwordHash: text('password_hash'),
    /** BE-49 (0033): tăng khi tài xế đăng xuất; token có claim `ver` khác số này bị từ chối. */
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // 0017: UNIQUE thường (NULL không đụng nhau) thay index thường users_phone_number_idx của 0000.
  (t) => [
    unique('users_email_key').on(t.email),
    unique('users_phone_number_key').on(t.phoneNumber),
    check('users_token_version_check', sql`${t.tokenVersion} >= 0`),
  ],
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

/**
 * BE-49 (migration 0033): refresh token đã bị thu hồi khi tài xế "đăng xuất thiết bị này". `jti` là
 * mã phiên thiết bị (jti của refresh token = claim `sid` của access token). Chỉ ghi thêm; dòng quá
 * `expires_at` vô hại (token đã hết hạn) và có thể dọn sau.
 */
export const driverRefreshRevocations = pgTable(
  'driver_refresh_revocations',
  {
    jti: uuid('jti').primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.userId),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('driver_refresh_revocations_user_id_idx').on(t.userId)],
);
