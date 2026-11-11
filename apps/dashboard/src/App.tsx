/** App root: store + session expiry + router. `Providers` and `AppRoutes` are reused by tests. */
import { useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, useRoutes } from 'react-router';
import { useSessionExpiry } from './core/auth/useSessionExpiry';
import { createStore, type AppStore } from './core/store/store';
import { routes } from './routes/routes';

function SessionExpiry() {
  useSessionExpiry();
  return null;
}

export function Providers({ children, store }: { children: ReactNode; store?: AppStore }) {
  const [s] = useState(() => store ?? createStore());
  return (
    <Provider store={s}>
      <SessionExpiry />
      {children}
    </Provider>
  );
}

export function AppRoutes() {
  return useRoutes(routes);
}

export function App() {
  return (
    <Providers>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Providers>
  );
}
