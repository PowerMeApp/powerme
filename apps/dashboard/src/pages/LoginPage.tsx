/**
 * Screen 16 (Login — Operator Dashboard) and 26 (Login — Admin Console): one form, one endpoint
 * (POST /api/auth/v1/login, ADR-0018). Each screen accepts only its own role (D31, SRS Table 6):
 * a token of the other role is discarded and the user is pointed to the right screen.
 */
import { Anchor, Button, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import type { DashboardRole } from '@powerme/shared';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { errorMessage, useLoginMutation } from '../core/api/api';
import { homePath, loggedIn, loginPath } from '../core/auth/authSlice';
import { useAppDispatch, useAppSelector } from '../core/store/store';
import { Notice } from '../ui/Notice';

const AREA: Record<DashboardRole, { name: string; other: DashboardRole; account: string }> = {
  operator_staff: { name: 'Trang đơn vị vận hành', other: 'admin', account: 'Đơn vị vận hành' },
  admin: { name: 'Trang quản trị', other: 'operator_staff', account: 'Quản trị viên' },
};

export function LoginPage({ role }: { role: DashboardRole }) {
  const user = useAppSelector((s) => s.auth.user);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [login, { isLoading }] = useLoginMutation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ text: string; to?: DashboardRole } | null>(null);
  const area = AREA[role];
  const other = AREA[area.other];

  if (user) return <Navigate to={homePath(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await login({ email, password }).unwrap();
      if (res.user.role !== role) {
        setError({
          text: `Đây là tài khoản ${other.account} — hãy đăng nhập ở trang ${other.name}.`,
          to: area.other,
        });
        return;
      }
      dispatch(loggedIn(res));
      navigate(from?.startsWith(homePath(role)) ? from : homePath(role), { replace: true });
    } catch (err) {
      setError({ text: errorMessage(err) });
    }
  };

  return (
    <div className="auth">
      <div className="auth-hero">
        <img
          className="auth-logo"
          src="/brand/powerme-master-lockup.png"
          alt="PowerMe — Empowering every journey home"
          width={260}
          height={151}
        />
        <h1>
          {area.name} <span>· vận hành mạng trụ sạc</span>
        </h1>
      </div>
      <div className="auth-form">
        <form onSubmit={submit} aria-label="Đăng nhập">
          <Paper p="xl" withBorder className="tile">
            <Stack gap="md">
              <Title order={2} fz="1.5rem">
                Đăng nhập {area.name}
              </Title>
              <TextInput
                label="Email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                required
                withAsterisk={false}
              />
              <TextInput
                label="Mật khẩu"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                required
                withAsterisk={false}
              />
              {error && (
                <Notice tone="error" className="form-error">
                  {error.text}
                  {error.to && (
                    <>
                      {' '}
                      <Anchor component={Link} to={loginPath(error.to)}>
                        Mở trang đăng nhập {AREA[error.to].name}
                      </Anchor>
                    </>
                  )}
                </Notice>
              )}
              <Button type="submit" fullWidth disabled={isLoading}>
                {isLoading ? 'Đang đăng nhập…' : 'Đăng nhập'}
              </Button>
              <Text size="sm" c="dimmed">
                Tài khoản {other.account}?{' '}
                <Anchor component={Link} to={loginPath(area.other)} size="sm">
                  Đăng nhập {other.name}
                </Anchor>
              </Text>
            </Stack>
          </Paper>
        </form>
      </div>
    </div>
  );
}
