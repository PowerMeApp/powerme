/**
 * Dashboard login API (FE-01a, ADR-0018) — types only, snake_case as on the wire.
 * Source: apps/csms/src/users/auth.ts and src/operator-api/operator-api.http.ts.
 */
export type DashboardRole = 'operator_staff' | 'admin';
export type StaffRole = 'manager' | 'technician';

/** POST /api/auth/v1/login */
export interface LoginRequest {
  email: string;
  password: string;
}

export interface DashboardUser {
  user_id: string;
  email: string;
  full_name: string;
  role: DashboardRole;
  operator_id?: string;
  operator_name?: string;
  staff_role?: StaffRole;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds (8 h). */
  expires_in: number;
  user: DashboardUser;
}

/** GET /api/operator/v1/me and /api/admin/v1/me */
export type DashboardMe = DashboardUser;

/** Every error body of the operator API. */
export interface ApiErrorBody {
  error: string;
  detail: string;
}
