/**
 * Frame after sign-in: left rail (brand, this area's navigation, Đăng xuất) and a top bar with the
 * signed-in user (SRS: log out from every signed-in screen). The navigation lists only screens that
 * exist; each slice adds its own item.
 */
import { NavLink, Outlet, useNavigate } from 'react-router';
import { CountBadge } from '../components/CountBadge';
import { Icon } from '../components/Icon';
import { useOperatorSummaryQuery } from '../core/api/api';
import { loggedOut, loginPath } from '../core/auth/authSlice';
import { useAppDispatch, useAppSelector } from '../core/store/store';

const STAFF_ROLE = { manager: 'Quản lý', technician: 'Kỹ thuật viên' } as const;

export function AppShell() {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  // Pending work on the menu (Operator only): same summary as the home page, refreshed every 10 s.
  const { data: summary } = useOperatorSummaryQuery(undefined, {
    skip: !user || user.role === 'admin',
    pollingInterval: 10_000,
    skipPollingIfUnfocused: true,
  });
  if (!user) return null;
  const pendingSessions =
    (summary?.sessions_to_review ?? 0) + (summary?.unattributed_sessions ?? 0);
  const admin = user.role === 'admin';
  const home = admin ? '/admin' : '/operator';

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-name">
              Power<b>Me</b>
            </div>
            <div className="brand-sub">{admin ? 'Admin Console' : 'Operator Dashboard'}</div>
          </div>
        </div>
        <nav aria-label={admin ? 'Quản trị nền tảng' : 'Vận hành'}>
          <div className="rail-section">{admin ? 'Quản trị nền tảng' : 'Vận hành'}</div>
          <NavLink
            to={home}
            end
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <Icon name="dashboard" />
            <span>Tổng quan</span>
          </NavLink>
          {!admin && (
            <NavLink
              to="/operator/charge-points"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="plug" />
              <span>Trụ sạc</span>
            </NavLink>
          )}
          {!admin && (
            <NavLink
              to="/operator/faults"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="alert" />
              <span>Cảnh báo sự cố</span>
              <CountBadge count={summary?.open_faults?.total} label="sự cố đang mở" />
            </NavLink>
          )}
          {!admin && (
            <NavLink
              to="/operator/sessions"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="sessions" />
              <span>Phiên cần xử lý</span>
              <CountBadge count={pendingSessions} label="phiên cần xử lý" />
            </NavLink>
          )}
          {admin && (
            <NavLink
              to="/admin/network"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="alert" />
              <span>Giám sát mạng lưới</span>
            </NavLink>
          )}
          {admin && (
            <NavLink
              to="/admin/charge-points"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="plug" />
              <span>Sổ đăng ký trụ</span>
            </NavLink>
          )}
          {admin && (
            <NavLink
              to="/admin/rfid-cards"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="card" />
              <span>Thẻ RFID</span>
            </NavLink>
          )}
          {!admin && (
            <NavLink
              to="/operator/pricing"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name="tag" />
              <span>Giá &amp; khuyến mãi</span>
            </NavLink>
          )}
          <NavLink
            to={admin ? '/admin/revenue' : '/operator/revenue'}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <Icon name="revenue" />
            <span>{admin ? 'Giao dịch & doanh thu' : 'Doanh thu'}</span>
          </NavLink>
        </nav>
        <div className="rail-foot">
          <button
            type="button"
            className="nav-link btn ghost"
            onClick={() => {
              dispatch(loggedOut());
              navigate(loginPath(user.role), { replace: true });
            }}
          >
            <Icon name="logout" />
            Đăng xuất
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <div className="spacer" />
          <div className="who">
            {user.full_name}
            <small>
              {admin
                ? 'Admin · toàn nền tảng'
                : `${user.staff_role ? STAFF_ROLE[user.staff_role] : 'Operator'} · ${user.operator_name ?? ''}`}
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
