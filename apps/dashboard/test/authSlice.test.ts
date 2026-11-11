import { describe, expect, it } from 'vitest';
import {
  authReducer,
  loadSession,
  loggedIn,
  loggedOut,
  saveSession,
  SESSION_KEY,
} from '../src/core/auth/authSlice';
import { session, STAFF } from './render';

describe('authSlice (D17)', () => {
  it('loggedIn keeps token, user and the expiry from expires_in; loggedOut clears it', () => {
    const before = Date.now();
    const state = authReducer(
      undefined,
      loggedIn({ access_token: 't', token_type: 'Bearer', expires_in: 28800, user: STAFF }),
    );
    expect(state.token).toBe('t');
    expect(state.user).toEqual(STAFF);
    expect(state.expiresAt! - before).toBeGreaterThanOrEqual(28_800_000);
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
});
