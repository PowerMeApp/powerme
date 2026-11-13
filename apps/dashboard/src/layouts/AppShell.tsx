/**
 * Frame after sign-in: left rail (brand, this area's navigation, Đăng xuất) and a top bar with the
 * signed-in user (SRS: log out from every signed-in screen). The navigation lists only screens that
 * exist; each slice adds its own item.
 */
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { loggedOut, loginPath } from '../core/auth/authSlice';
import { useAppDispatch, useAppSelector } from '../core/store/store';

const STAFF_ROLE = { manager: 'Quản lý', technician: 'Kỹ thuật viên' } as const;

export function AppShell() {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  if (!user) return null;
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
