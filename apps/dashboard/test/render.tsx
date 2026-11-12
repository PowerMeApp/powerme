/** Renders the real app (routes + store) at a URL, with a fake CSMS behind `fetch`. */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardUser } from '@powerme/shared';
import { MemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';
import { AppRoutes, Providers } from '../src/App';
import type { AuthState } from '../src/core/auth/authSlice';
import { createStore } from '../src/core/store/store';

export const STAFF: DashboardUser = {
  user_id: '10',
  email: 'staff@powerme.test',
  full_name: 'Trần Trọng Nghĩa',
  role: 'operator_staff',
  operator_id: '1',
  operator_name: 'SaiGon EV Partners',
  staff_role: 'manager',
};
export const ADMIN: DashboardUser = {
  user_id: '1',
  email: 'admin@powerme.test',
  full_name: 'PowerMe Admin',
  role: 'admin',
};

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** Stubs `fetch`. `routes` maps "METHOD /path" to a response (or a thrown network error). */
export function fakeCsms(routes: Record<string, FakeResponse | 'network'>) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      const text = await input.text();
      seen.push({
        method: input.method,
        path: url.pathname,
        authorization: input.headers.get('Authorization'),
        body: text ? JSON.parse(text) : null,
      });
      const r = routes[`${input.method} ${url.pathname}`];
      if (r === 'network') throw new TypeError('Failed to fetch');
      const {
        status = 404,
        body = { error: 'not_found', detail: 'not_found' },
        headers = {},
      } = r ?? {};
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    }),
  );
  return seen;
}

export const session = (user: DashboardUser, ms = 3_600_000): AuthState => ({
  token: `token-${user.user_id}`,
  user,
  expiresAt: Date.now() + ms,
});

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
export const currentPath = () =>
  document.querySelector('[data-testid="location"]')?.textContent ?? '';

export function renderApp(path: string, auth?: AuthState) {
  const store = createStore(auth ?? { token: null, user: null, expiresAt: null });
  const utils = render(
    <Providers store={store}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, store, user: userEvent.setup() };
}
