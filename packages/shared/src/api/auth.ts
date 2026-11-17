/**
 * Dashboard login API (FE-01a, ADR-0018; refresh token T125, contract §2.2b) — types only,
 * snake_case as on the wire.
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
  /** Access token life in seconds (900). */
  expires_in: number;
  /** Exchanged at POST /api/auth/v1/refresh for a new access token; not rotated. */
  refresh_token: string;
  /** Refresh token life in seconds, counted from login (default 43 200 = 12 h). */
  refresh_expires_in: number;
  user: DashboardUser;
}

/** POST /api/auth/v1/refresh */
export interface RefreshRequest {
  refresh_token: string;
}

/** No new refresh token and no `user` (call /me for a fresh profile). */
export interface RefreshResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** GET /api/operator/v1/me and /api/admin/v1/me */
export type DashboardMe = DashboardUser;

/** Every error body of the operator API. */
export interface ApiErrorBody {
  error: string;
  detail: string;
}
