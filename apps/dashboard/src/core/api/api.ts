/**
 * RTK Query against the real CSMS operator API (PKG-2: core/api; D2, D17). Adds the Bearer token,
 * normalises errors to `ApiError`, and signs the user out when a protected call says the session
 * is no longer valid (401, or 403 for a locked account / Operator or a wrong role). A 401 with a
 * refresh token first trades it for a new 900 s access token (one call shared by every request
 * that failed meanwhile) and retries once (T125, contract §2.2b).
 */
import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
} from '@reduxjs/toolkit/query/react';
import type {
  ApiErrorBody,
  ChargePointLifecycle,
  ChargePointPage,
  OperatorSummary,
  DashboardMe,
  FaultActionResponse,
  FaultListStatus,
  LoginRequest,
  LoginResponse,
  OperatorFaultList,
  RefreshResponse,
  ResetRequest,
  ResetResponse,
  SessionsActiveError,
} from '@powerme/shared';
import { loggedOut, tokenRefreshed, type AuthState } from '../auth/authSlice';
import { env } from '../config/env';

/** Rows per page on screen 21. */
export const FAULT_PAGE_SIZE = 20;
/** Rows per page on screen 18. */
export const CHARGE_POINT_PAGE_SIZE = 20;

/** Screen 18 filters; omitted = all (decommissioned hidden by the server, D24). */
export interface ChargePointFilter {
  lifecycle?: ChargePointLifecycle;
  online?: boolean;
  page: number;
}

export interface ApiError {
  /** HTTP status, or 'network' when the CSMS could not be reached. */
  status: number | 'network';
  code?: string;
  retryAfterS?: number;
  /** Sessions a Reset would cut (409 `sessions_active`, D40). */
  sessions?: SessionsActiveError['sessions'];
}

const SESSION_ENDED = new Set(['account_locked', 'operator_inactive', 'forbidden']);

const raw = fetchBaseQuery({
  baseUrl: `${window.location.origin}${env.apiBase}`,
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as { auth: AuthState }).auth.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  },
});

type Raw = typeof raw;
const authOf = (api: Parameters<Raw>[1]) => (api.getState() as { auth: AuthState }).auth;

/** One refresh at a time: every request that hit 401 meanwhile waits on the same call. */
let refreshing: Promise<'ok' | 'failed' | 'network'> | null = null;

function refreshAccess(api: Parameters<Raw>[1], extra: Parameters<Raw>[2]) {
  const refreshToken = authOf(api).refreshToken;
  if (!refreshToken) return Promise.resolve('failed' as const);
  refreshing ??= (async () => {
    const r = await raw(
      { url: 'auth/v1/refresh', method: 'POST', body: { refresh_token: refreshToken } },
      api,
      extra,
    );
    if (r.data) {
      api.dispatch(tokenRefreshed(r.data as RefreshResponse));
      return 'ok' as const;
    }
    return r.error?.status === 'FETCH_ERROR' ? ('network' as const) : ('failed' as const);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const baseQuery: BaseQueryFn<string | FetchArgs, unknown, ApiError> = async (args, api, extra) => {
  const url = typeof args === 'string' ? args : args.url;
  const sent = authOf(api).token;
  let result = await raw(args, api, extra);
  if (result.error?.status === 401 && !url.startsWith('auth/')) {
    // Another request may already have renewed the token while this one was in flight.
    const current = authOf(api).token;
    const renewed = current && current !== sent ? 'ok' : await refreshAccess(api, extra);
    if (renewed === 'ok') result = await raw(args, api, extra);
    else if (renewed === 'network')
      return { error: { status: 'network' }, meta: result.meta } as { error: ApiError };
  }
  if (!result.error) return { data: result.data, meta: result.meta };
  const e = result.error;
  const status =
    typeof e.status === 'number' ? e.status : 'originalStatus' in e ? e.originalStatus : 'network';
  const body = ('data' in e ? e.data : undefined) as
    (Partial<ApiErrorBody> & Partial<SessionsActiveError>) | undefined;
  const retry = Number(result.meta?.response?.headers.get('Retry-After'));
  const error: ApiError = {
    status,
    ...(typeof body?.error === 'string' ? { code: body.error } : {}),
    ...(retry > 0 ? { retryAfterS: retry } : {}),
    ...(Array.isArray(body?.sessions) ? { sessions: body.sessions } : {}),
  };
  if (
    !url.startsWith('auth/') &&
    (status === 401 || (status === 403 && SESSION_ENDED.has(error.code ?? '')))
  )
    api.dispatch(loggedOut());
  return { error, meta: result.meta };
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: ['Fault', 'Summary', 'ChargePoint'],
  endpoints: (b) => ({
    login: b.mutation<LoginResponse, LoginRequest>({
      query: (body) => ({ url: 'auth/v1/login', method: 'POST', body }),
    }),
    operatorMe: b.query<DashboardMe, void>({ query: () => 'operator/v1/me' }),
    adminMe: b.query<DashboardMe, void>({ query: () => 'admin/v1/me' }),
    // Screen 21 (FE-04b, UC-OPS-03): FaultEvents of the signed-in staff's Operator.
    // One page of the server's order (D39); `page` is 1-based.
    operatorFaults: b.query<OperatorFaultList, { status: FaultListStatus; page: number }>({
      query: ({ status, page }) =>
        `operator/v1/faults?status=${status}&page=${page}&page_size=${FAULT_PAGE_SIZE}`,
      providesTags: ['Fault'],
    }),
    // Fault actions also change the open-fault tiles of screen 17.
    acknowledgeFault: b.mutation<FaultActionResponse, string>({
      query: (id) => ({ url: `operator/v1/faults/${id}/acknowledge`, method: 'POST' }),
      invalidatesTags: ['Fault', 'Summary'],
    }),
    resetFault: b.mutation<ResetResponse, { id: string } & ResetRequest>({
      query: ({ id, ...body }) => ({ url: `operator/v1/faults/${id}/reset`, method: 'POST', body }),
      invalidatesTags: ['Fault', 'Summary'],
    }),
    closeFault: b.mutation<FaultActionResponse, string>({
      query: (id) => ({ url: `operator/v1/faults/${id}/close`, method: 'POST' }),
      invalidatesTags: ['Fault', 'Summary'],
    }),
    // Screens 17 / 18 (FE-03, UC-OPS-02): the Operator's charge points and their live status.
    operatorSummary: b.query<OperatorSummary, void>({
      query: () => 'operator/v1/summary',
      providesTags: ['Summary'],
    }),
    operatorChargePoints: b.query<ChargePointPage, ChargePointFilter>({
      query: ({ lifecycle, online, page }) => {
        const q = new URLSearchParams();
        if (lifecycle) q.set('lifecycle', lifecycle);
        if (online !== undefined) q.set('online', String(online));
        q.set('page', String(page));
        q.set('page_size', String(CHARGE_POINT_PAGE_SIZE));
        return `operator/v1/charge-points?${q}`;
      },
      providesTags: ['ChargePoint'],
    }),
  }),
});

export const {
  useLoginMutation,
  useOperatorMeQuery,
  useAdminMeQuery,
  useOperatorFaultsQuery,
  useAcknowledgeFaultMutation,
  useResetFaultMutation,
  useCloseFaultMutation,
  useOperatorSummaryQuery,
  useOperatorChargePointsQuery,
} = api;

/** Vietnamese text for any error of this API. */
export function errorMessage(err: unknown): string {
  const e = err as Partial<ApiError> | undefined;
  if (!e || e.status === 'network' || e.status === undefined) return 'Không kết nối được máy chủ';
  switch (e.code) {
    case 'invalid_credentials':
      return 'Email hoặc mật khẩu không đúng';
    case 'account_locked':
      return 'Tài khoản đã bị khoá';
    case 'operator_inactive':
      return 'Operator đã ngừng hoạt động';
    case 'invalid_refresh_token':
      return 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại';
    case 'auth_unavailable':
      return 'Máy chủ chưa bật đăng nhập';
    // FE-04b fault actions (operator-api/operator-faults.ts).
    case 'invalid_transition':
      return 'Sự cố đã đổi trạng thái, danh sách đã được làm mới';
    case 'fault_not_acknowledged':
      return 'Phải xác nhận sự cố trước khi Reset';
    case 'station_offline':
      return 'Charge Point đang offline, không gửi được lệnh Reset';
    case 'reset_in_progress':
      return 'Charge Point đang chờ kết quả một lệnh Reset khác, thử lại sau';
    case 'station_error':
      return 'Charge Point không trả lời lệnh Reset hợp lệ, sự cố quay về "Đã xác nhận"';
    case 'not_found':
      return 'Không tìm thấy sự cố này';
  }
  if (e.status === 429) {
    const minutes = Math.max(1, Math.ceil((e.retryAfterS ?? 60) / 60));
    return `Thử sai quá nhiều lần, thử lại sau ${minutes} phút`;
  }
  if (e.status === 401) return 'Phiên đăng nhập đã hết hạn';
  if (e.status === 403) return 'Không có quyền truy cập';
  if (e.status === 409) return 'Thao tác không còn hợp lệ, danh sách đã được làm mới';
  return 'Máy chủ gặp lỗi, thử lại sau';
}
