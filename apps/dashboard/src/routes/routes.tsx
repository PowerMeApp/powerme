/**
 * Routes = the states of Fig 10 (Operator Dashboard) and Fig 11 (Admin Console), numbered as SRS
 * Table 5. Each later slice adds its screen as a child of its area.
 */
import { Navigate, type RouteObject } from 'react-router';
import { homePath } from '../core/auth/authSlice';
import { useAppSelector } from '../core/store/store';
import { AppShell } from '../layouts/AppShell';
import { AdminHomePage } from '../pages/admin/AdminHomePage';
import { LoginPage } from '../pages/LoginPage';
import { OperatorHomePage } from '../pages/operator/OperatorHomePage';
import { RequireRole } from './RequireRole';

function RootRedirect() {
  const user = useAppSelector((s) => s.auth.user);
  return <Navigate to={user ? homePath(user.role) : '/operator/login'} replace />;
}

export const routes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },
  { path: '/operator/login', element: <LoginPage role="operator_staff" /> }, // 16
  { path: '/admin/login', element: <LoginPage role="admin" /> }, // 26
  {
    path: '/operator',
    element: (
      <RequireRole role="operator_staff">
        <AppShell />
      </RequireRole>
    ),
    children: [
      { index: true, element: <OperatorHomePage /> }, // 17
      { path: '*', element: <Navigate to="/operator" replace /> },
    ],
  },
  {
    path: '/admin',
    element: (
      <RequireRole role="admin">
        <AppShell />
      </RequireRole>
    ),
    children: [
      { index: true, element: <AdminHomePage /> }, // 27
      { path: '*', element: <Navigate to="/admin" replace /> },
    ],
  },
  { path: '*', element: <RootRedirect /> },
];
