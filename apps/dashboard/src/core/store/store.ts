/** Redux store (PKG-2: core/store → Redux Toolkit). Hiện chỉ có cache RTK Query. */
import { configureStore } from '@reduxjs/toolkit';
import { api } from '../api/api';

export function createStore() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (gdm) => gdm().concat(api.middleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
