/**
 * User accounts (UC-ADM-01/02, screen 28, FE-19; driver picker of screen 30, T161) — types only,
 * snake_case as on the wire. Sources: apps/csms/src/operator-api/admin-users.ts (list) and
 * admin-user-actions.ts (create, edit, role, lock / unlock).
 */
import type { StaffRole } from './auth.js';

export type UserAccountStatus = 'active' | 'suspended' | 'closed';

/** One row of GET /api/admin/v1/users (OpenAPI `UserAccount`). */
export interface UserAccount {
  id: string;
  email: string;
  full_name: string;
  phone_number: string | null;
  role: 'driver' | 'operator_staff' | 'admin';
  account_status: UserAccountStatus;
  operator: { id: string; legal_name: string } | null;
  staff_role: 'manager' | 'technician' | null;
  created_at: string;
}

/** GET /api/admin/v1/users (OpenAPI `UserAccountPage`). */
export interface UserAccountPage {
  items: UserAccount[];
  total: number;
  page: number;
  page_size: number;
}

export type UserRole = UserAccount['role'];

/** GET /api/admin/v1/users filters; omitted = all. `q`: name / email contains, or phone equals. */
export interface UserQuery {
  role?: UserRole;
  account_status?: UserAccountStatus;
  operator_id?: string;
  q?: string;
}

/** POST /api/admin/v1/users — staff or admin only (drivers sign up themselves, BR-P05). */
export type CreateStaffUserRequest = {
  email: string;
  full_name: string;
  phone_number?: string | null;
  initial_password: string;
} & ({ role: 'admin' } | { role: 'operator_staff'; operator_id: string; staff_role: StaffRole });

/** PATCH /api/admin/v1/users/{id} — at least one field; `phone_number: null` clears it. */
export interface UpdateUserRequest {
  full_name?: string;
  phone_number?: string | null;
}

/** PUT /api/admin/v1/users/{id}/role */
export type SetRoleRequest =
  { role: 'admin' } | { role: 'operator_staff'; operator_id: string; staff_role: StaffRole };

/** POST /api/admin/v1/users/{id}/lock | unlock */
export interface NoteRequest {
  note: string;
}
