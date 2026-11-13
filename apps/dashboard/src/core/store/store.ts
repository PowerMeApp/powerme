/** Redux store (PKG-2: core/store): auth session + RTK Query cache. */
import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../api/api';
import { authReducer, loadSession, saveSession, type AuthState } from '../auth/authSlice';

export function createStore(auth: AuthState = loadSession()) {
  const store = configureStore({
    reducer: { auth: authReducer, [api.reducerPath]: api.reducer },
    preloadedState: { auth },
    middleware: (getDefault) => getDefault().concat(api.middleware),
  });
  let last = store.getState().auth;
  store.subscribe(() => {
    const current = store.getState().auth;
    if (current === last) return;
    last = current;
    saveSession(current);
    // Signed out: drop cached data of the previous user.
    if (!current.token) store.dispatch(api.util.resetApiState());
  });
  return store;
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<AppStore['getState']>;
export const useAppDispatch = useDispatch.withTypes<AppStore['dispatch']>();
export const useAppSelector = useSelector.withTypes<RootState>();
