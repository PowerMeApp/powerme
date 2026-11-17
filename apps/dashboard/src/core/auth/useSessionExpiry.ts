import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store/store';
import { loggedOut, sessionEndsAt } from './authSlice';

/**
 * Signs the user out when the session ends (D17), without waiting for a failed request: when the
 * refresh token expires (T125), or the access token for a session without one. An expired access
 * token alone is renewed by the API layer on the next 401.
 */
export function useSessionExpiry(): void {
  const expiresAt = useAppSelector((s) => sessionEndsAt(s.auth));
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (expiresAt === null) return;
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      dispatch(loggedOut());
      return;
    }
    const timer = setTimeout(() => dispatch(loggedOut()), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiresAt, dispatch]);
}
