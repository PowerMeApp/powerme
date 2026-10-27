/** Gốc ứng dụng: store + phiên đăng nhập + toast + router. `Providers` dùng lại trong test. */
import { ReactNode, useState } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, useRoutes } from 'react-router';
import { AuthProvider } from './core/context/AuthContext';
import { createStore } from './core/store/store';
import { ToastProvider } from './hooks/toast';
import { routes } from './routes/routes';
import type { SessionUser } from './types/domain';

export function Providers({
  children,
  initialUser,
}: {
  children: ReactNode;
  initialUser?: SessionUser | null;
}) {
  const [store] = useState(createStore);
  return (
    <Provider store={store}>
      <AuthProvider initialUser={initialUser}>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </Provider>
  );
}

/** Router khai báo (không dùng data router: chưa cần loader/action, và tránh Request/AbortSignal). */
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
