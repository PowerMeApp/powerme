/**
 * Bảng route = các trạng thái của Fig 10 (Operator Dashboard) và Fig 11 (Admin Console).
 * Đánh số màn hình theo SRS Table 5 (screen 16–33).
 */
import { Navigate, RouteObject } from 'react-router';
import { homePathFor, useAuth } from '../core/context/AuthContext';
import { AppShell } from '../layouts/AppShell';
import { LoginPage } from '../pages/LoginPage';
import { AdminDashboardPage } from '../pages/admin/AdminDashboardPage';
import { BillingExceptionsPage } from '../pages/admin/BillingExceptionsPage';
import { CardRegistryPage } from '../pages/admin/CardRegistryPage';
import { DeviceRegistryPage } from '../pages/admin/DeviceRegistryPage';
import { PolicyTemplatesPage, SystemHealthPage } from '../pages/admin/ShouldPages';
import { UsersPage } from '../pages/admin/UsersPage';
import { FaultAlertsPage } from '../pages/operator/FaultAlertsPage';
import { OperatorDashboardPage } from '../pages/operator/OperatorDashboardPage';
import { PillarDetailPage } from '../pages/operator/PillarDetailPage';
import { PillarListPage } from '../pages/operator/PillarListPage';
import { PricingPage } from '../pages/operator/PricingPage';
import { SessionsReviewPage } from '../pages/operator/SessionsReviewPage';
import { AnalyticsPage, TicketsPage } from '../pages/operator/ShouldPages';
import { RequireRole } from './RequireRole';

function RootRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? homePathFor(user.role) : '/login'} replace />;
}

export const routes: RouteObject[] = [
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: <LoginPage /> }, // screen 16 / 26
  {
    path: '/operator',
    element: (
      <RequireRole role="operator">
        <AppShell />
      </RequireRole>
    ),
    children: [
      { index: true, element: <OperatorDashboardPage /> }, // 17
      { path: 'pillars', element: <PillarListPage /> }, // 18 (+19 onboarding sheet)
      { path: 'pillars/:id', element: <PillarDetailPage /> }, // 20
      { path: 'alerts', element: <FaultAlertsPage /> }, // 21
      { path: 'sessions', element: <SessionsReviewPage /> }, // 22
      { path: 'pricing', element: <PricingPage /> }, // 23
      { path: 'tickets', element: <TicketsPage /> }, // 24 Should
      { path: 'analytics', element: <AnalyticsPage /> }, // 25 Should
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
      { index: true, element: <AdminDashboardPage /> }, // 27
      { path: 'users', element: <UsersPage /> }, // 28
      { path: 'devices', element: <DeviceRegistryPage /> }, // 29
      { path: 'cards', element: <CardRegistryPage /> }, // 30
      { path: 'billing', element: <BillingExceptionsPage /> }, // 31
      { path: 'policies', element: <PolicyTemplatesPage /> }, // 32 Should
      { path: 'health', element: <SystemHealthPage /> }, // 33 Should
    ],
  },
  { path: '*', element: <RootRedirect /> },
];
