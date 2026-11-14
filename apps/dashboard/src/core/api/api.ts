/**
 * RTK Query against the real CSMS operator API (PKG-2: core/api; D2, D17). Adds the Bearer token,
 * normalises errors to `ApiError`, and signs the user out when a protected call says the session
 * is no longer valid (401, or 403 for a locked account / Operator or a wrong role).
 */
import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
} from '@reduxjs/toolkit/query/react';
import type {
  ApiErrorBody,
  DashboardMe,
  FaultActionResponse,
  FaultListStatus,
  LoginRequest,
  LoginResponse,
  OperatorFaultList,
  ResetRequest,
  ResetResponse,
  SessionsActiveError,
} from '@powerme/shared';
import { loggedOut, type AuthState } from '../auth/authSlice';
import { env } from '../config/env';

/** Rows per page on screen 21. */
export const FAULT_PAGE_SIZE = 20;

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

const baseQuery: BaseQueryFn<string | FetchArgs, unknown, ApiError> = async (args, api, extra) => {
  const result = await raw(args, api, extra);
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
  const url = typeof args === 'string' ? args : args.url;
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
  tagTypes: ['Fault'],
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
    acknowledgeFault: b.mutation<FaultActionResponse, string>({
      query: (id) => ({ url: `operator/v1/faults/${id}/acknowledge`, method: 'POST' }),
      invalidatesTags: ['Fault'],
    }),
    resetFault: b.mutation<ResetResponse, { id: string } & ResetRequest>({
      query: ({ id, ...body }) => ({ url: `operator/v1/faults/${id}/reset`, method: 'POST', body }),
      invalidatesTags: ['Fault'],
    }),
    closeFault: b.mutation<FaultActionResponse, string>({
      query: (id) => ({ url: `operator/v1/faults/${id}/close`, method: 'POST' }),
      invalidatesTags: ['Fault'],
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
