import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store/store';
import { loggedOut } from './authSlice';

/** Signs the user out when the token expires (D17), without waiting for a failed request. */
export function useSessionExpiry(): void {
  const expiresAt = useAppSelector((s) => s.auth.expiresAt);
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
