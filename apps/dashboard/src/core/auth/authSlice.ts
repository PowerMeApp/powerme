/**
 * Signed-in session (PKG-2: core/auth; D17). Token + user from POST /api/auth/v1/login, kept in
 * sessionStorage so a reload keeps the session; every storage access is try/catch (it can be
 * blocked). An expired session is never restored. Logging out only drops the token (ADR-0018).
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { DashboardRole, DashboardUser, LoginResponse } from '@powerme/shared';

export const SESSION_KEY = 'powerme.dashboard.session';

export interface AuthState {
  token: string | null;
  user: DashboardUser | null;
  /** Epoch ms when the token expires. */
  expiresAt: number | null;
}

const signedOut: AuthState = { token: null, user: null, expiresAt: null };

export function loadSession(now = Date.now()): AuthState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return signedOut;
    const s = JSON.parse(raw) as Partial<AuthState>;
    if (
      typeof s.token === 'string' &&
      typeof s.expiresAt === 'number' &&
      s.expiresAt > now &&
      (s.user?.role === 'operator_staff' || s.user?.role === 'admin')
    )
      return { token: s.token, user: s.user, expiresAt: s.expiresAt };
  } catch {
    /* unreadable or blocked storage: start signed out */
  }
  return signedOut;
}

export function saveSession(state: AuthState): void {
  try {
    if (state.token) sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* blocked storage: the session lives until the tab reloads */
  }
}

const authSlice = createSlice({
  name: 'auth',
  initialState: signedOut,
  reducers: {
    loggedIn: {
      reducer: (_, action: PayloadAction<LoginResponse & { at: number }>) => ({
        token: action.payload.access_token,
        user: action.payload.user,
        expiresAt: action.payload.at + action.payload.expires_in * 1000,
      }),
      prepare: (response: LoginResponse) => ({ payload: { ...response, at: Date.now() } }),
    },
    loggedOut: () => signedOut,
  },
});

export const { loggedIn, loggedOut } = authSlice.actions;
export const authReducer = authSlice.reducer;

export const homePath = (role: DashboardRole) => (role === 'admin' ? '/admin' : '/operator');
export const loginPath = (role: DashboardRole) => `${homePath(role)}/login`;
