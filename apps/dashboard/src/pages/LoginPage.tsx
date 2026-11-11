/**
 * Screen 16 (Login — Operator Dashboard) and 26 (Login — Admin Console): one form, one endpoint
 * (POST /api/auth/v1/login, ADR-0018). Each screen accepts only its own role (D31, SRS Table 6):
 * a token of the other role is discarded and the user is pointed to the right screen.
 */
import { useState, type FormEvent } from 'react';
import type { DashboardRole } from '@powerme/shared';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { errorMessage, useLoginMutation } from '../core/api/api';
import { homePath, loggedIn, loginPath } from '../core/auth/authSlice';
import { useAppDispatch, useAppSelector } from '../core/store/store';

const AREA: Record<DashboardRole, { name: string; other: DashboardRole; account: string }> = {
  operator_staff: { name: 'Operator Dashboard', other: 'admin', account: 'Operator' },
  admin: { name: 'Admin Console', other: 'operator_staff', account: 'Admin' },
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
        <div className="brand">
          <div className="brand-mark">P</div>
          <div className="brand-name">
            Power<b>Me</b>
          </div>
        </div>
        <h1>
          {area.name} <span>· vận hành mạng trụ sạc</span>
        </h1>
        <p className="muted">
          {role === 'admin'
            ? 'Admin Console cho quản trị nền tảng PowerMe.'
            : 'Operator Dashboard cho nhân viên của Operator đối tác.'}
        </p>
      </div>
      <div className="auth-form">
        <form onSubmit={submit} aria-label="Đăng nhập">
          <h2 style={{ fontSize: 24 }}>Đăng nhập {area.name}</h2>
          <label className="field">
            Email
            <input
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            Mật khẩu
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error.text}
              {error.to && (
                <>
                  {' '}
                  <Link to={loginPath(error.to)}>Mở trang đăng nhập {AREA[error.to].name}</Link>
                </>
              )}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={isLoading}>
            {isLoading ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
          <p className="hint">
            Tài khoản {other.account}?{' '}
            <Link to={loginPath(area.other)}>Đăng nhập {other.name}</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
