/**
 * Chặn route theo vai trò (SRS Table 6). Chưa đăng nhập → /login; sai vai trò → về trang chủ của
 * vai trò mình (Operator không bao giờ vào được /admin/*, và ngược lại).
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { homePathFor, useAuth } from '../core/context/AuthContext';
import type { Role } from '../types/domain';

export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={homePathFor(user.role)} replace />;
  return <>{children}</>;
}
