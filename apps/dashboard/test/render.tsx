/** Dựng app thật (route + store + mock server) ở một URL, với người dùng đã đăng nhập sẵn hoặc chưa. */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { AppRoutes, Providers } from '../src/App';
import type { SessionUser } from '../src/types/domain';

export const OPERATOR: SessionUser = {
  id: 10,
  email: 'operator@powerme.local',
  name: 'Trần Trọng Nghĩa',
  role: 'operator',
  operatorId: 1,
  operatorName: 'SaiGon EV Partners',
};

export const ADMIN: SessionUser = {
  id: 1,
  email: 'admin@powerme.local',
  name: 'PowerMe Admin',
  role: 'admin',
  operatorId: null,
  operatorName: null,
};

/** Ghi đường dẫn hiện tại vào DOM để test kiểm điều hướng. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

export function currentPath(): string {
  return document.querySelector('[data-testid="location"]')?.textContent ?? '';
}

export function renderApp(
  path: string,
  user: SessionUser | null = null,
  opts: { fakeTimers?: boolean } = {},
) {
  const ue = opts.fakeTimers
    ? userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) })
    : userEvent.setup();
  const utils = render(
    <Providers initialUser={user}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, user: ue };
}
