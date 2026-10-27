/**
 * Phiên đăng nhập (PKG-2: core/context). Lưu trong sessionStorage để F5 không mất phiên; mọi truy
 * cập storage đều try/catch (trình duyệt có thể chặn). Vai trò quyết định khu vực được vào
 * (SRS Table 6 Screen Authorization: Operator → Fig 10, Admin → Fig 11).
 */
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import type { SessionUser } from '../../types/domain';

const KEY = 'powerme.dashboard.session';

interface AuthState {
  user: SessionUser | null;
  token: string | null;
}

interface AuthApi extends AuthState {
  signIn: (token: string, user: SessionUser) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthApi | null>(null);

function load(): AuthState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as AuthState;
  } catch {
    /* bỏ qua: chạy không cần storage */
  }
  return { user: null, token: null };
}

export function AuthProvider({
  children,
  initialUser,
}: {
  children: ReactNode;
  initialUser?: SessionUser | null;
}) {
  const [state, setState] = useState<AuthState>(() =>
    initialUser !== undefined ? { user: initialUser, token: initialUser ? 'test' : null } : load(),
  );

  const signIn = useCallback((token: string, user: SessionUser) => {
    const next = { token, user };
    setState(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* bỏ qua */
    }
  }, []);

  const signOut = useCallback(() => {
    setState({ user: null, token: null });
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* bỏ qua */
    }
  }, []);

  const value = useMemo(() => ({ ...state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải nằm trong <AuthProvider>');
  return ctx;
}

export function homePathFor(role: SessionUser['role']): string {
  return role === 'admin' ? '/admin' : '/operator';
}
