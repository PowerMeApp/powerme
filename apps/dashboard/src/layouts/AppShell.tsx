/**
 * Frame after sign-in (Mantine AppShell): left navigation (brand, this area's screens, Đăng xuất)
 * and a top bar with the signed-in user (SRS: log out from every signed-in screen). Under 62em (md) the
 * navigation folds behind a menu button. The navigation lists only screens that exist; pending
 * work shows as a red count on its item (Operator: open faults, sessions to handle; the Admin's
 * pending work is on its home page).
 */
import {
  AppShell as Shell,
  Burger,
  Group,
  NavLink,
  ScrollArea,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { NavLink as RouterNavLink, Outlet, useNavigate } from 'react-router';
import { CountBadge } from '../components/CountBadge';
import { Icon } from '../components/Icon';
import { useOperatorSummaryQuery } from '../core/api/api';
import { loggedOut, loginPath } from '../core/auth/authSlice';
import { useAppDispatch, useAppSelector } from '../core/store/store';

const STAFF_ROLE = { manager: 'Quản lý', technician: 'Kỹ thuật viên' } as const;

function Item({
  to,
  icon,
  label,
  end,
  badge,
  onNavigate,
}: {
  to: string;
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  end?: boolean;
  badge?: ReactNode;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      component={RouterNavLink}
      to={to}
      end={end}
      className="nav-link"
      label={label}
      leftSection={<Icon name={icon} />}
      rightSection={badge}
      onClick={onNavigate}
    />
  );
}

export function AppShell() {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [opened, { toggle, close }] = useDisclosure(false);
  const admin = user?.role === 'admin';
  // Pending work on the menu: same summary as the home page, refreshed every 10 s.
  const { data: summary } = useOperatorSummaryQuery(undefined, {
    skip: !user || admin,
    pollingInterval: 10_000,
    skipPollingIfUnfocused: true,
  });
  if (!user) return null;
  const pendingSessions =
    (summary?.sessions_to_review ?? 0) + (summary?.unattributed_sessions ?? 0);
  const home = admin ? '/admin' : '/operator';
  const area = admin ? 'Quản trị nền tảng' : 'Vận hành';

  return (
    <Shell
      className="shell"
      header={{ height: 60 }}
      navbar={{ width: 256, breakpoint: 'md', collapsed: { mobile: !opened } }}
      padding={0}
    >
      <Shell.Header className="topbar">
        <Group h="100%" px="lg" gap="md" wrap="nowrap">
          <Burger
            opened={opened}
            onClick={toggle}
            hiddenFrom="md"
            size="sm"
            aria-label={opened ? 'Đóng menu' : 'Mở menu'}
          />
          <UnstyledButton
            className="brand"
            onClick={() => navigate(home)}
            aria-label={`PowerMe, ${admin ? 'Trang quản trị' : 'Trang đơn vị vận hành'}`}
          >
            <img
              className="brand-mark"
              src="/brand/powerme-master-icon.png"
              alt=""
              width={34}
              height={33}
            />
            <span>
              <span className="brand-name">
                Power<b>Me</b>
              </span>
              <span className="brand-sub">
                {admin ? 'Trang quản trị' : 'Trang đơn vị vận hành'}
              </span>
            </span>
          </UnstyledButton>
          <div className="spacer" />
          <div className="who">
            {user.full_name}
            <small>
              {admin
                ? 'Quản trị viên · toàn nền tảng'
                : `${user.staff_role ? STAFF_ROLE[user.staff_role] : 'Operator'} · ${user.operator_name ?? ''}`}
            </small>
          </div>
        </Group>
      </Shell.Header>
      <Shell.Navbar className="rail">
        <Shell.Section grow component={ScrollArea} type="never">
          <nav aria-label={area}>
            <Text className="rail-section">{area}</Text>
            <Item to={home} end icon="dashboard" label="Tổng quan" onNavigate={close} />
            {!admin && (
              <>
                <Item to="/operator/charge-points" icon="plug" label="Trụ sạc" onNavigate={close} />
                <Item
                  to="/operator/faults"
                  icon="alert"
                  label="Cảnh báo sự cố"
                  onNavigate={close}
                  badge={<CountBadge count={summary?.open_faults?.total} label="sự cố đang mở" />}
                />
                <Item
                  to="/operator/sessions"
                  icon="sessions"
                  label="Phiên cần xử lý"
                  onNavigate={close}
                  badge={<CountBadge count={pendingSessions} label="phiên cần xử lý" />}
                />
                <Item
                  to="/operator/pricing"
                  icon="tag"
                  label="Giá & khuyến mãi"
                  onNavigate={close}
                />
              </>
            )}
            {admin && (
              <>
                <Item
                  to="/admin/users"
                  icon="users"
                  label="Tài khoản & vai trò"
                  onNavigate={close}
                />
                <Item
                  to="/admin/network"
                  icon="network"
                  label="Giám sát mạng lưới"
                  onNavigate={close}
                />
                <Item
                  to="/admin/charge-points"
                  icon="plug"
                  label="Sổ đăng ký trụ"
                  onNavigate={close}
                />
                <Item to="/admin/rfid-cards" icon="card" label="Thẻ RFID" onNavigate={close} />
                <Item
                  to="/admin/billing"
                  icon="receipt"
                  label="Ngoại lệ thanh toán"
                  onNavigate={close}
                />
              </>
            )}
            <Item
              to={admin ? '/admin/revenue' : '/operator/revenue'}
              icon="revenue"
              label={admin ? 'Giao dịch & doanh thu' : 'Doanh thu'}
              onNavigate={close}
            />
          </nav>
        </Shell.Section>
        <Shell.Section className="rail-foot">
          <NavLink
            component="button"
            type="button"
            className="nav-link"
            label="Đăng xuất"
            leftSection={<Icon name="logout" />}
            onClick={() => {
              dispatch(loggedOut());
              navigate(loginPath(user.role), { replace: true });
            }}
          />
        </Shell.Section>
      </Shell.Navbar>
      <Shell.Main className="main">
        <div className="content">
          <Outlet />
        </div>
      </Shell.Main>
    </Shell>
  );
}
