import { describe, expect, it } from 'vitest';
import {
  authReducer,
  loadSession,
  loggedIn,
  loggedOut,
  saveSession,
  sessionEndsAt,
  SESSION_KEY,
  tokenRefreshed,
} from '../src/core/auth/authSlice';
import { session, STAFF } from './render';

describe('authSlice (D17)', () => {
  it('loggedIn keeps token, user and the expiry from expires_in; loggedOut clears it', () => {
    const before = Date.now();
    const state = authReducer(
      undefined,
      loggedIn({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'r',
        refresh_expires_in: 43200,
        user: STAFF,
      }),
    );
    expect(state.token).toBe('t');
    expect(state.user).toEqual(STAFF);
    expect(state.expiresAt! - before).toBeGreaterThanOrEqual(900_000);
    expect(authReducer(state, loggedOut())).toEqual({ token: null, user: null, expiresAt: null });
  });

  it('restores a saved session, but never an expired or malformed one', () => {
    saveSession(session(STAFF));
    expect(loadSession().token).toBe('token-10');
    saveSession(session(STAFF, -1));
    expect(loadSession().token).toBeNull();
    sessionStorage.setItem(SESSION_KEY, '{"token":"x","expiresAt":9e15,"user":{"role":"driver"}}');
    expect(loadSession().token).toBeNull();
    sessionStorage.setItem(SESSION_KEY, 'not json');
    expect(loadSession().token).toBeNull();
    saveSession({ token: null, user: null, expiresAt: null });
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('T125: keeps the refresh token, renews only the access token, restores while refresh is valid', () => {
    const at = Date.now();
    let state = authReducer(
      undefined,
      loggedIn({
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'r',
        refresh_expires_in: 43200,
        user: STAFF,
      }),
    );
    expect(state.refreshToken).toBe('r');
    expect(state.refreshExpiresAt! - at).toBeGreaterThanOrEqual(43_200_000);
    expect(sessionEndsAt(state)).toBe(state.refreshExpiresAt);
    state = authReducer(
      state,
      tokenRefreshed({ access_token: 't2', token_type: 'Bearer', expires_in: 900 }),
    );
    expect(state).toMatchObject({ token: 't2', refreshToken: 'r', user: STAFF });
    // Access token expired, refresh still valid: the session comes back after a reload.
    saveSession({ ...session(STAFF, -1), refreshToken: 'r', refreshExpiresAt: at + 60_000 });
    expect(loadSession()).toMatchObject({ token: 'token-10', refreshToken: 'r' });
    saveSession({ ...session(STAFF, -1), refreshToken: 'r', refreshExpiresAt: at - 1 });
    expect(loadSession().token).toBeNull();
    // A refresh after logout never brings the session back.
    expect(
      authReducer(
        authReducer(state, loggedOut()),
        tokenRefreshed({ access_token: 'x', token_type: 'Bearer', expires_in: 900 }),
      ).token,
    ).toBeNull();
  });
});
