/**
 * Route guard by role (SRS Table 6). Not signed in → this area's login screen (16 or 26); signed in
 * with the other role → own home, so an Operator never reaches /admin/* and an Admin never /operator/*.
 */
import type { ReactNode } from 'react';
import type { DashboardRole } from '@powerme/shared';
import { Navigate, useLocation } from 'react-router';
import { homePath, loginPath } from '../core/auth/authSlice';
import { useAppSelector } from '../core/store/store';

export function RequireRole({ role, children }: { role: DashboardRole; children: ReactNode }) {
  const user = useAppSelector((s) => s.auth.user);
  const location = useLocation();
  if (!user) return <Navigate to={loginPath(role)} replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={homePath(user.role)} replace />;
  return <>{children}</>;
}
