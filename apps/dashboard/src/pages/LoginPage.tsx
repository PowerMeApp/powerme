/**
 * Screen 16 (Login — Dashboard) và 26 (Login — Console). Một form; vai trò của tài khoản quyết định
 * đi tới Operator Dashboard hay Admin Console (Fig 10/11: "log in [Operator role]" / "[Admin role]").
 */
import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { errorMessage, useLoginMutation } from '../core/api/api';
import { homePathFor, useAuth } from '../core/context/AuthContext';

const DEMO = [
  { label: 'Operator', email: 'operator@powerme.local' },
  { label: 'Admin', email: 'admin@powerme.local' },
];

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [login, { isLoading }] = useLoginMutation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={homePathFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await login({ email, password });
    if ('error' in res) {
      setError(errorMessage(res.error));
      return;
    }
    signIn(res.data.token, res.data.user);
    navigate(homePathFor(res.data.user.role), { replace: true });
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
          Vận hành mạng trụ sạc <span>theo thời gian thực</span>.
        </h1>
        <p className="muted">
          Operator Dashboard cho đối tác vận hành trụ · Admin Console cho quản trị nền tảng.
        </p>
      </div>
      <div className="auth-form">
        <form onSubmit={submit} aria-label="Đăng nhập">
          <h2 style={{ fontSize: 24 }}>Đăng nhập</h2>
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
              {error}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={isLoading}>
            {isLoading ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
          <div className="hint">
            Tài khoản mô phỏng (mật khẩu <span className="mono">powerme123</span>):
            <div className="btn-row" style={{ marginTop: 8 }}>
              {DEMO.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setEmail(d.email);
                    setPassword('powerme123');
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
