/** App root: Mantine theme + store + session expiry + router. `Providers` and `AppRoutes` are reused by tests. */
import { MantineProvider } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, useRoutes } from 'react-router';
import { useSessionExpiry } from './core/auth/useSessionExpiry';
import { createStore, type AppStore } from './core/store/store';
import { routes } from './routes/routes';
import { cssVariablesResolver, theme } from './ui/theme';

function SessionExpiry() {
  useSessionExpiry();
  return null;
}

export function Providers({ children, store }: { children: ReactNode; store?: AppStore }) {
  const [s] = useState(() => store ?? createStore());
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
      forceColorScheme="dark"
      env={import.meta.env.MODE === 'test' ? 'test' : 'default'}
    >
      <Provider store={s}>
        <SessionExpiry />
        {children}
      </Provider>
    </MantineProvider>
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
