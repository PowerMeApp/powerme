/**
 * Khung sau đăng nhập: thanh điều hướng trái (bản desktop của NavigationBar trong app) + thanh
 * trên có tên người dùng, nhãn "dữ liệu mô phỏng" và nút đăng xuất (SRS: log out ở mọi màn hình).
 * Mục điều hướng lấy theo vai trò — đúng các trạng thái của Fig 10 (Operator) / Fig 11 (Admin).
 */
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { env } from '../core/config/env';
import { useAuth } from '../core/context/AuthContext';
import { LIVE_POLL_MS } from '../core/realtime/polling';
import { useAdminSummaryQuery, useOperatorSummaryQuery } from '../core/api/api';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  should?: boolean;
  count?: number;
}

function OperatorNav() {
  const { data } = useOperatorSummaryQuery(undefined, { pollingInterval: LIVE_POLL_MS });
  const items: NavItem[] = [
    { to: '/operator', label: 'Tổng quan', icon: 'dashboard', end: true },
    { to: '/operator/pillars', label: 'Trụ sạc', icon: 'pillar' },
    {
      to: '/operator/alerts',
      label: 'Cảnh báo sự cố',
      icon: 'alert',
      count: data?.openAlerts.total,
    },
    {
      to: '/operator/sessions',
      label: 'Phiên cần xử lý',
      icon: 'session',
      count: data ? data.sessionsToReview + data.stuckStarts : undefined,
    },
    { to: '/operator/pricing', label: 'Biểu giá & khuyến mãi', icon: 'tariff' },
    { to: '/operator/tickets', label: 'Phiếu bảo trì', icon: 'ticket', should: true },
    { to: '/operator/analytics', label: 'Doanh thu', icon: 'chart', should: true },
  ];
  return <NavList section="Vận hành" items={items} />;
}

function AdminNav() {
  const { data } = useAdminSummaryQuery(undefined, { pollingInterval: LIVE_POLL_MS });
  const billing = data
    ? data.billingExceptions.topUps +
      data.billingExceptions.latePayments +
      data.billingExceptions.invoices +
      data.billingExceptions.closedAccounts
    : undefined;
  const items: NavItem[] = [
    { to: '/admin', label: 'Tổng quan', icon: 'dashboard', end: true },
    { to: '/admin/users', label: 'Người dùng & vai trò', icon: 'users' },
    { to: '/admin/devices', label: 'Sổ thiết bị', icon: 'device' },
    { to: '/admin/cards', label: 'Thẻ RFID & free vend', icon: 'card' },
    { to: '/admin/billing', label: 'Ngoại lệ thanh toán', icon: 'billing', count: billing },
    { to: '/admin/policies', label: 'Mẫu chính sách', icon: 'policy', should: true },
    { to: '/admin/health', label: 'Sức khoẻ hệ thống', icon: 'health', should: true },
  ];
  return <NavList section="Quản trị nền tảng" items={items} />;
}

function NavList({ section, items }: { section: string; items: NavItem[] }) {
  return (
    <nav aria-label={section}>
      <div className="rail-section">{section}</div>
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          <Icon name={it.icon} />
          <span>{it.label}</span>
          {it.should && <span className="should">Should</span>}
          {!it.should && it.count ? <span className="count">{it.count}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const isAdmin = user.role === 'admin';
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-name">
              Power<b>Me</b>
            </div>
            <div className="brand-sub">{isAdmin ? 'Admin Console' : 'Operator Dashboard'}</div>
          </div>
        </div>
        {isAdmin ? <AdminNav /> : <OperatorNav />}
        <div className="rail-foot">
          <button
            type="button"
            className="nav-link btn ghost"
            style={{ width: '100%', justifyContent: 'flex-start' }}
            onClick={() => {
              signOut();
              navigate('/login', { replace: true });
            }}
          >
            <Icon name="logout" />
            Đăng xuất
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          {env.useMock && (
            <span className="pill gold" title="Chưa nối REST API của CSMS — src/mocks">
              Dữ liệu mô phỏng
            </span>
          )}
          <div className="spacer" />
          <div className="who">
            {user.name}
            <small>
              {isAdmin ? 'Admin · toàn nền tảng' : `Operator · ${user.operatorName ?? ''}`}
            </small>
          </div>
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
