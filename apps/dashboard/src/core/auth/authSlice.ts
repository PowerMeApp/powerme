/**
 * Signed-in session (PKG-2: core/auth; D17). Tokens + user from POST /api/auth/v1/login, kept in
 * sessionStorage so a reload keeps the session; every storage access is try/catch (it can be
 * blocked). The access token lives 900 s and is renewed with the refresh token (T125, contract
 * §2.2b) until the refresh token itself expires; a session with neither still valid is never
 * restored. Logging out only drops the tokens (ADR-0018).
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { DashboardRole, DashboardUser, LoginResponse, RefreshResponse } from '@powerme/shared';

export const SESSION_KEY = 'powerme.dashboard.session';

export interface AuthState {
  token: string | null;
  user: DashboardUser | null;
  /** Epoch ms when the access token expires. */
  expiresAt: number | null;
  /** Absent when signed out (or for a session saved before T125). */
  refreshToken?: string | null;
  /** Epoch ms when the refresh token expires: the session ends there. */
  refreshExpiresAt?: number | null;
}

/** When the session ends for good: the refresh token's expiry, else the access token's. */
export const sessionEndsAt = (s: AuthState): number | null =>
  s.refreshToken && s.refreshExpiresAt ? s.refreshExpiresAt : s.expiresAt;

const signedOut: AuthState = { token: null, user: null, expiresAt: null };

export function loadSession(now = Date.now()): AuthState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return signedOut;
    const s = JSON.parse(raw) as Partial<AuthState>;
    const refresh =
      typeof s.refreshToken === 'string' && typeof s.refreshExpiresAt === 'number'
        ? { refreshToken: s.refreshToken, refreshExpiresAt: s.refreshExpiresAt }
        : {};
    const ends = refresh.refreshExpiresAt ?? s.expiresAt;
    if (
      typeof s.token === 'string' &&
      typeof s.expiresAt === 'number' &&
      typeof ends === 'number' &&
      ends > now &&
      (s.user?.role === 'operator_staff' || s.user?.role === 'admin')
    )
      return { token: s.token, user: s.user, expiresAt: s.expiresAt, ...refresh };
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
      reducer: (_, action: PayloadAction<LoginResponse & { at: number }>) => {
        const { at, access_token, expires_in, refresh_token, refresh_expires_in, user } =
          action.payload;
        return {
          token: access_token,
          user,
          expiresAt: at + expires_in * 1000,
          ...(refresh_token && refresh_expires_in
            ? { refreshToken: refresh_token, refreshExpiresAt: at + refresh_expires_in * 1000 }
            : {}),
        };
      },
      prepare: (response: LoginResponse) => ({ payload: { ...response, at: Date.now() } }),
    },
    /** New access token from POST /api/auth/v1/refresh; user and refresh token stay. */
    tokenRefreshed: {
      reducer: (state, action: PayloadAction<RefreshResponse & { at: number }>) => {
        if (!state.user) return state;
        state.token = action.payload.access_token;
        state.expiresAt = action.payload.at + action.payload.expires_in * 1000;
      },
      prepare: (response: RefreshResponse) => ({ payload: { ...response, at: Date.now() } }),
    },
    loggedOut: () => signedOut,
  },
});

export const { loggedIn, loggedOut, tokenRefreshed } = authSlice.actions;
export const authReducer = authSlice.reducer;

export const homePath = (role: DashboardRole) => (role === 'admin' ? '/admin' : '/operator');
export const loginPath = (role: DashboardRole) => `${homePath(role)}/login`;
