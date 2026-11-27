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
  AdminSummary,
  BillingExceptions,
  InvoiceRetryResult,
  RecheckResult,
  ApiErrorBody,
  ChargePointLifecycle,
  ChargePointPage,
  CreateStaffUserRequest,
  CreateRfidCardRequest,
  OperatorChargePointDetail,
  OperatorSummary,
  DashboardMe,
  FaultActionResponse,
  FaultListStatus,
  LoginRequest,
  LoginResponse,
  NetworkChargePointPage,
  NetworkQuery,
  OnboardRequest,
  OnboardResult,
  OperatorFaultList,
  PlatformOperatorPage,
  Promotion,
  PromotionCreate,
  PromotionPage,
  PromotionPatch,
  RefreshResponse,
  RegisterDeviceRequest,
  RegistryChargePoint,
  RegistryChargePointPage,
  RfidCard,
  RfidCardPage,
  RfidCardQuery,
  ResetRequest,
  ResetResponse,
  AssignSessionRequest,
  CloseSessionRequest,
  ResolveSessionRequest,
  SessionDecisionResponse,
  SessionQueue,
  SessionQueuePage,
  RevenueQuery,
  RevenueReport,
  SessionsActiveError,
  NoteRequest,
  SetRoleRequest,
  SitePage,
  UpdateUserRequest,
  UserAccount,
  UserQuery,
  TariffScheduleRequest,
  TariffScheduleView,
  TransactionPage,
  TransactionQuery,
  UpdateRfidCardRequest,
  UserAccountPage,
} from '@powerme/shared';
import { loggedOut, tokenRefreshed, type AuthState } from '../auth/authSlice';
import { env } from '../config/env';

/** Rows per page on screen 21. */
export const FAULT_PAGE_SIZE = 20;
/** Rows per page on screen 23. */
export const SESSION_PAGE_SIZE = 20;
/** Rows per page on screen 18. */
export const CHARGE_POINT_PAGE_SIZE = 20;
/** Rows per page of the transaction list on screen 35 (the API default). */
export const TRANSACTION_PAGE_SIZE = 50;
/** Rows per page on screen 30. */
export const RFID_PAGE_SIZE = 20;
/** Rows per page on screen 28. */
export const USER_PAGE_SIZE = 20;
/** Rows per page on screen 31. */
export const NETWORK_PAGE_SIZE = 20;
/** Rows per page of the device registry. */
export const REGISTRY_PAGE_SIZE = 20;
/** Matches shown by the driver picker of screen 30. */
export const DRIVER_SEARCH_SIZE = 10;

/** Screen 18 filters; omitted = all (decommissioned hidden by the server, D24). */
export interface ChargePointFilter {
  lifecycle?: ChargePointLifecycle;
  online?: boolean;
  page: number;
  /** Station page (FE-07): only this Charging Station's charge points. */
  siteId?: string;
  /** Default CHARGE_POINT_PAGE_SIZE; the station page asks for up to 100. */
  pageSize?: number;
  /** FE-07 searches: charge point code / serial / id, and station code / name / id, separately. */
  chargePointQ?: string;
  siteQ?: string;
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
  tagTypes: [
    'Fault',
    'Summary',
    'ChargePoint',
    'Session',
    'Revenue',
    'AdminSummary',
    'RfidCard',
    'Registry',
    'Network',
    'Tariff',
    'Promotion',
    'User',
    'Billing',
  ],
  endpoints: (b) => ({
    login: b.mutation<LoginResponse, LoginRequest>({
      query: (body) => ({ url: 'auth/v1/login', method: 'POST', body }),
    }),
    operatorMe: b.query<DashboardMe, void>({ query: () => 'operator/v1/me' }),
    adminMe: b.query<DashboardMe, void>({ query: () => 'admin/v1/me' }),
    // Screen 27 (FE-14, UC-ADM-07): platform counts.
    adminSummary: b.query<AdminSummary, void>({
      query: () => 'admin/v1/summary',
      providesTags: ['AdminSummary'],
    }),
    // Screen 21 (FE-04b, UC-OPS-03): FaultEvents of the signed-in staff's Operator.
    // One page of the server's order (D39); `page` is 1-based.
    operatorFaults: b.query<
      OperatorFaultList,
      { status: FaultListStatus; page: number; chargePointId?: string }
    >({
      query: ({ status, page, chargePointId }) =>
        `operator/v1/faults?status=${status}&page=${page}&page_size=${FAULT_PAGE_SIZE}` +
        (chargePointId ? `&charge_point_id=${chargePointId}` : ''),
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
      query: ({
        lifecycle,
        online,
        page,
        siteId,
        chargePointQ,
        siteQ,
        pageSize = CHARGE_POINT_PAGE_SIZE,
      }) => {
        const q = new URLSearchParams();
        if (siteId) q.set('site_id', siteId);
        if (chargePointQ?.trim()) q.set('charge_point_q', chargePointQ.trim());
        if (siteQ?.trim()) q.set('site_q', siteQ.trim());
        if (lifecycle) q.set('lifecycle', lifecycle);
        if (online !== undefined) q.set('online', String(online));
        q.set('page', String(page));
        q.set('page_size', String(pageSize));
        return `operator/v1/charge-points?${q}`;
      },
      providesTags: ['ChargePoint'],
    }),
    // Screen 20 (FE-05): one charge point, its open faults and latest commands.
    operatorChargePoint: b.query<OperatorChargePointDetail, string>({
      query: (id) => `operator/v1/charge-points/${id}`,
      providesTags: ['ChargePoint', 'Fault'],
    }),
    // Screen 19 (FE-02, UC-OPS-01): the Operator's Charging Stations for the station picker, and
    // the onboarding itself. A new charge point shows on screens 17 / 18 as awaiting connection.
    operatorSites: b.query<SitePage, void>({ query: () => 'operator/v1/sites?page_size=100' }),
    onboardChargePoint: b.mutation<OnboardResult, OnboardRequest>({
      query: (body) => ({ url: 'operator/v1/charge-points/onboard', method: 'POST', body }),
      invalidatesTags: ['ChargePoint', 'Summary'],
    }),
    // Screen 24 (FE-06, UC-OPS-06/07): the Operator's tariff schedule and promotions.
    operatorTariffs: b.query<TariffScheduleView, void>({
      query: () => 'operator/v1/tariffs',
      providesTags: ['Tariff'],
    }),
    putTariffs: b.mutation<TariffScheduleView, TariffScheduleRequest>({
      query: (body) => ({ url: 'operator/v1/tariffs', method: 'PUT', body }),
      invalidatesTags: ['Tariff'],
    }),
    operatorPromotions: b.query<PromotionPage, void>({
      query: () => 'operator/v1/promotions?page_size=100',
      providesTags: ['Promotion'],
    }),
    createPromotion: b.mutation<Promotion, PromotionCreate>({
      query: (body) => ({ url: 'operator/v1/promotions', method: 'POST', body }),
      invalidatesTags: ['Promotion'],
    }),
    updatePromotion: b.mutation<Promotion, { id: string } & PromotionPatch>({
      query: ({ id, ...body }) => ({ url: `operator/v1/promotions/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Promotion'],
    }),
    deactivatePromotion: b.mutation<Promotion, string>({
      query: (id) => ({ url: `operator/v1/promotions/${id}/deactivate`, method: 'POST', body: {} }),
      invalidatesTags: ['Promotion'],
    }),
    // Screen 23 (FE-12, UC-OPS-05): unattributed / review queues and the Operator's decisions.
    // A decision also changes the queue counts on screen 17.
    operatorSessions: b.query<SessionQueuePage, { queue: SessionQueue; page: number }>({
      query: ({ queue, page }) =>
        `operator/v1/sessions?queue=${queue}&page=${page}&page_size=${SESSION_PAGE_SIZE}`,
      providesTags: ['Session'],
    }),
    assignSession: b.mutation<SessionDecisionResponse, { id: string } & AssignSessionRequest>({
      query: ({ id, ...body }) => ({
        url: `operator/v1/sessions/${id}/assign`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Session', 'Summary'],
    }),
    closeSession: b.mutation<SessionDecisionResponse, { id: string } & CloseSessionRequest>({
      query: ({ id, ...body }) => ({
        url: `operator/v1/sessions/${id}/close`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Session', 'Summary'],
    }),
    resolveSession: b.mutation<SessionDecisionResponse, { id: string } & ResolveSessionRequest>({
      query: ({ id, ...body }) => ({
        url: `operator/v1/sessions/${id}/resolve`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Session', 'Summary'],
    }),
    // Screens 25 / 35 (FE-07, UC-OPS-09 / UC-ADM-10): revenue report of T108 (BR-P46).
    revenue: b.query<RevenueReport, { scope: RevenueScope } & RevenueQuery>({
      query: ({ scope, ...q }) => `${scope}/v1/revenue?${revenueSearch(q)}`,
      providesTags: ['Revenue'],
    }),
    // Same parameters and query as the JSON (contract: "CSV khớp màn hình"). A mutation so it goes
    // through baseQuery (Bearer + refresh on 401) and is never cached; the body is the CSV text.
    revenueCsv: b.mutation<string, { scope: RevenueScope } & RevenueQuery>({
      query: ({ scope, ...q }) => ({
        url: `${scope}/v1/revenue.csv?${revenueSearch(q)}`,
        responseHandler: (r) => (r.ok ? r.text() : r.json()),
      }),
    }),
    // Screen 35 (UC-ADM-10): transaction list of T108b, one stopped session per row (contract §4.1).
    adminTransactions: b.query<TransactionPage, TransactionQuery & { page: number }>({
      query: ({ page, ...q }) =>
        `admin/v1/transactions?${transactionSearch(q)}&page=${page}&page_size=${TRANSACTION_PAGE_SIZE}`,
      providesTags: ['Revenue'],
    }),
    // Same filters, no paging (page / page_size → 400); whole filtered set plus a TOTAL line.
    adminTransactionsCsv: b.mutation<string, TransactionQuery>({
      query: (q) => ({
        url: `admin/v1/transactions.csv?${transactionSearch(q)}`,
        responseHandler: (r) => (r.ok ? r.text() : r.json()),
      }),
    }),
    // Screen 30 (T161, UC-ADM-04): RFID card registry of T146 (contract §3.8a). A change also
    // changes the card counts of screen 27 (T161 point 5).
    adminRfidCards: b.query<RfidCardPage, RfidCardQuery & { page: number }>({
      query: ({ page, ...f }) => {
        const p = new URLSearchParams();
        if (f.status) p.set('status', f.status);
        if (f.card_kind) p.set('card_kind', f.card_kind);
        if (f.q?.trim()) p.set('q', f.q.trim());
        p.set('page', String(page));
        p.set('page_size', String(RFID_PAGE_SIZE));
        return `admin/v1/rfid-cards?${p}`;
      },
      providesTags: ['RfidCard'],
    }),
    createRfidCard: b.mutation<RfidCard, CreateRfidCardRequest>({
      query: (body) => ({ url: 'admin/v1/rfid-cards', method: 'POST', body }),
      invalidatesTags: ['RfidCard', 'AdminSummary'],
    }),
    updateRfidCard: b.mutation<RfidCard, { id: string } & UpdateRfidCardRequest>({
      query: ({ id, ...body }) => ({ url: `admin/v1/rfid-cards/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['RfidCard', 'AdminSummary'],
    }),
    // Device registry: registered charge points of the whole platform, newest first. Registering
    // one also changes the charge point counts of the admin home page.
    adminRegistry: b.query<
      RegistryChargePointPage,
      { page: number; lifecycle?: ChargePointLifecycle }
    >({
      query: ({ page, lifecycle }) => {
        const p = new URLSearchParams();
        if (lifecycle) p.set('lifecycle', lifecycle);
        p.set('page', String(page));
        p.set('page_size', String(REGISTRY_PAGE_SIZE));
        return `admin/v1/charge-points?${p}`;
      },
      providesTags: ['Registry'],
    }),
    registerDevice: b.mutation<RegistryChargePoint, RegisterDeviceRequest>({
      query: (body) => ({ url: 'admin/v1/charge-points', method: 'POST', body }),
      invalidatesTags: ['Registry', 'AdminSummary'],
    }),
    // Screen 31 (FE-18, UC-ADM-07): every Operator's charge points, live; and the Operators.
    adminNetwork: b.query<NetworkChargePointPage, NetworkQuery & { page: number }>({
      query: ({ page, ...f }) => {
        const p = new URLSearchParams();
        if (f.operator_id) p.set('operator_id', f.operator_id);
        if (f.charge_point_q?.trim()) p.set('charge_point_q', f.charge_point_q.trim());
        if (f.site_q?.trim()) p.set('site_q', f.site_q.trim());
        if (f.lifecycle) p.set('lifecycle', f.lifecycle);
        if (f.online !== undefined) p.set('online', String(f.online));
        p.set('page', String(page));
        p.set('page_size', String(NETWORK_PAGE_SIZE));
        return `admin/v1/network/charge-points?${p}`;
      },
      providesTags: ['Network'],
    }),
    adminOperators: b.query<PlatformOperatorPage, void>({
      query: () => 'admin/v1/operators?page_size=100',
    }),
    // Screen 28 (FE-19, UC-ADM-01/02): accounts and roles. Changes also move the screen-27 counts.
    adminUsers: b.query<UserAccountPage, UserQuery & { page: number }>({
      query: ({ page, ...f }) => {
        const p = new URLSearchParams();
        if (f.role) p.set('role', f.role);
        if (f.account_status) p.set('account_status', f.account_status);
        if (f.operator_id) p.set('operator_id', f.operator_id);
        if (f.q?.trim()) p.set('q', f.q.trim());
        p.set('page', String(page));
        p.set('page_size', String(USER_PAGE_SIZE));
        return `admin/v1/users?${p}`;
      },
      providesTags: ['User'],
    }),
    createUser: b.mutation<UserAccount, CreateStaffUserRequest>({
      query: (body) => ({ url: 'admin/v1/users', method: 'POST', body }),
      invalidatesTags: ['User', 'AdminSummary'],
    }),
    updateUser: b.mutation<UserAccount, { id: string } & UpdateUserRequest>({
      query: ({ id, ...body }) => ({ url: `admin/v1/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['User'],
    }),
    setUserRole: b.mutation<UserAccount, { id: string; body: SetRoleRequest }>({
      query: ({ id, body }) => ({ url: `admin/v1/users/${id}/role`, method: 'PUT', body }),
      invalidatesTags: ['User', 'AdminSummary'],
    }),
    setUserLock: b.mutation<UserAccount, { id: string; lock: boolean } & NoteRequest>({
      query: ({ id, lock, note }) => ({
        url: `admin/v1/users/${id}/${lock ? 'lock' : 'unlock'}`,
        method: 'POST',
        body: { note },
      }),
      invalidatesTags: ['User', 'AdminSummary'],
    }),
    // Screens 32 / 33 (FE-09, UC-ADM-08) on Khang's #212 routes. Each action also moves the
    // billing counts of screen 27.
    billingExceptions: b.query<BillingExceptions, void>({
      query: () => 'admin/v1/billing/exceptions',
      providesTags: ['Billing'],
    }),
    retryInvoice: b.mutation<InvoiceRetryResult, string>({
      query: (id) => ({ url: `admin/v1/billing/e-invoices/${id}/retry`, method: 'POST' }),
      invalidatesTags: ['Billing', 'AdminSummary'],
    }),
    recheckTopUp: b.mutation<RecheckResult, string>({
      query: (id) => ({ url: `admin/v1/billing/top-ups/${id}/recheck`, method: 'POST' }),
      invalidatesTags: ['Billing', 'AdminSummary'],
    }),
    markExceptionReviewed: b.mutation<unknown, string>({
      query: (id) => ({ url: `admin/v1/billing/top-ups/${id}/exception-reviewed`, method: 'POST' }),
      invalidatesTags: ['Billing', 'AdminSummary'],
    }),
    reviewConflict: b.mutation<unknown, { id: string; note: string }>({
      query: ({ id, note }) => ({
        url: `admin/v1/billing/payment-conflicts/${id}/review`,
        method: 'POST',
        body: { note },
      }),
      invalidatesTags: ['Billing', 'AdminSummary'],
    }),
    // Driver picker of screen 30: active drivers by name, email or phone (T161, admin-users.ts).
    driverSearch: b.query<UserAccountPage, string>({
      query: (q) => {
        const p = new URLSearchParams({ role: 'driver', account_status: 'active', q: q.trim() });
        p.set('page_size', String(DRIVER_SEARCH_SIZE));
        return `admin/v1/users?${p}`;
      },
    }),
  }),
});

export const {
  useLoginMutation,
  useOperatorMeQuery,
  useAdminMeQuery,
  useAdminSummaryQuery,
  useOperatorFaultsQuery,
  useAcknowledgeFaultMutation,
  useResetFaultMutation,
  useCloseFaultMutation,
  useOperatorSummaryQuery,
  useOperatorChargePointsQuery,
  useOperatorChargePointQuery,
  useOperatorSitesQuery,
  useOnboardChargePointMutation,
  useOperatorTariffsQuery,
  usePutTariffsMutation,
  useOperatorPromotionsQuery,
  useCreatePromotionMutation,
  useUpdatePromotionMutation,
  useDeactivatePromotionMutation,
  useOperatorSessionsQuery,
  useAssignSessionMutation,
  useCloseSessionMutation,
  useResolveSessionMutation,
  useRevenueQuery,
  useRevenueCsvMutation,
  useAdminTransactionsQuery,
  useAdminTransactionsCsvMutation,
  useAdminRfidCardsQuery,
  useCreateRfidCardMutation,
  useUpdateRfidCardMutation,
  useDriverSearchQuery,
  useBillingExceptionsQuery,
  useRetryInvoiceMutation,
  useRecheckTopUpMutation,
  useMarkExceptionReviewedMutation,
  useReviewConflictMutation,
  useAdminUsersQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useSetUserRoleMutation,
  useSetUserLockMutation,
  useAdminRegistryQuery,
  useAdminNetworkQuery,
  useAdminOperatorsQuery,
  useRegisterDeviceMutation,
} = api;

export type RevenueScope = 'operator' | 'admin';

/** Query string of the revenue routes, in a fixed order (JSON and CSV ask the same thing). */
export function revenueSearch(q: RevenueQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to, group_by: q.group_by });
  if (q.site_id) p.set('site_id', q.site_id);
  if (q.operator_id) p.set('operator_id', q.operator_id);
  return p.toString();
}

/** Query string of the transaction routes, in a fixed order (JSON and CSV ask the same thing). */
export function transactionSearch(q: TransactionQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  for (const k of ['operator_id', 'site_id', 'charge_point_id', 'kind', 'origin'] as const) {
    const v = q[k];
    if (v) p.set(k, v);
  }
  return p.toString();
}

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
      return 'Trụ sạc đang offline, không gửi được lệnh Reset';
    case 'reset_in_progress':
      return 'Trụ sạc đang chờ kết quả một lệnh Reset khác, thử lại sau';
    case 'station_error':
      return 'Trụ sạc không trả lời lệnh Reset hợp lệ, sự cố quay về "Đã xác nhận"';
    case 'not_found':
      return 'Không tìm thấy sự cố này';
    // FE-07 revenue (T108).
    case 'invalid_period':
      return 'Kỳ báo cáo không hợp lệ: ngày đầu phải trước ngày cuối và dài tối đa 366 ngày';
    case 'export_too_large':
      return 'Quá 100 000 dòng, hãy chọn kỳ ngắn hơn hoặc lọc thêm';
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
