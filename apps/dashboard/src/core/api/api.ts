/**
 * RTK Query — một api slice cho cả Operator Dashboard và Admin Console (PKG-2: core/api).
 *
 * `mockBaseQuery` chuyển mọi request vào src/mocks/server. Khi CSMS có REST API, thay bằng
 * `fetchBaseQuery({ baseUrl, prepareHeaders })` — đường dẫn và kiểu đã khớp, UI không đổi.
 * Mỗi hành động invalidates đúng tag của danh sách nó làm thay đổi.
 */
import { BaseQueryFn, createApi } from '@reduxjs/toolkit/query/react';
import { mockRequest } from '../../mocks/server';
import type {
  ApiErrorBody,
  ClosedAccountRefund,
  DeviceRecord,
  FaultEvent,
  FreeVendTag,
  LatePayment,
  MaintenanceTicket,
  NeedsReviewInvoice,
  Page,
  Pillar,
  PillarRevenue,
  Promotion,
  RefundableTopUp,
  RemoteCommand,
  ReviewSession,
  RfidCard,
  SessionQueue,
  SessionUser,
  Site,
  StartIntent,
  TariffPeriod,
  UserAccount,
} from '../../types/domain';

export interface ApiError {
  status: number;
  data: ApiErrorBody;
}

interface Req {
  url: string;
  method?: string;
  body?: unknown;
}

export const mockBaseQuery: BaseQueryFn<Req | string, unknown, ApiError> = async (args) => {
  const req = typeof args === 'string' ? { url: args } : args;
  const res = await mockRequest(req);
  if (res.status >= 400) return { error: { status: res.status, data: res.data as ApiErrorBody } };
  return { data: res.data };
};

/** Thông điệp lỗi cho toast từ lỗi RTK Query bất kỳ. */
export function errorMessage(err: unknown): string {
  const e = err as Partial<ApiError> | undefined;
  return e?.data?.detail ?? 'Không kết nối được máy chủ';
}

export interface OperatorSummary {
  pillars: number;
  online: number;
  offline: number;
  connectors: { available: number; charging: number; faulted: number; other: number };
  openAlerts: { total: number; critical: number; major: number; minor: number };
  sessionsToReview: number;
  stuckStarts: number;
}

export interface PillarDetail {
  pillar: Pillar;
  faults: FaultEvent[];
  commands: RemoteCommand[];
  sessions: ReviewSession[];
}

export interface AdminSummary {
  users: number;
  drivers: number;
  pillars: number;
  pillarsAwaitingOnboarding: number;
  rfidCards: number;
  billingExceptions: {
    topUps: number;
    latePayments: number;
    invoices: number;
    closedAccounts: number;
  };
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: mockBaseQuery,
  tagTypes: [
    'Summary',
    'Pillar',
    'Fault',
    'Command',
    'Session',
    'Intent',
    'Tariff',
    'AdminSummary',
    'User',
    'Device',
    'TopUp',
    'LatePayment',
    'EInvoice',
    'ClosedAccount',
  ],
  endpoints: (b) => ({
    login: b.mutation<{ token: string; user: SessionUser }, { email: string; password: string }>({
      query: (body) => ({ url: '/api/v1/auth/login', method: 'POST', body }),
    }),

    // ---- Operator ----
    operatorSummary: b.query<OperatorSummary, void>({
      query: () => '/api/v1/operator/summary',
      providesTags: ['Summary'],
    }),
    sites: b.query<Site[], void>({ query: () => '/api/v1/operator/sites' }),
    pillars: b.query<Pillar[], void>({
      query: () => '/api/v1/operator/pillars',
      providesTags: ['Pillar'],
    }),
    pillar: b.query<PillarDetail, number>({
      query: (id) => `/api/v1/operator/pillars/${id}`,
      providesTags: ['Pillar', 'Fault', 'Command'],
    }),
    onboardPillar: b.mutation<
      { pillar: Pillar; credential: { username: string; password: string } },
      { serial: string; model: string; siteId: number; connectorCount: number }
    >({
      query: (body) => ({ url: '/api/v1/operator/pillars', method: 'POST', body }),
      invalidatesTags: ['Pillar', 'Summary', 'Device', 'AdminSummary'],
    }),
    sendCommand: b.mutation<
      RemoteCommand,
      { pillarId: number; action: string; connectorNo?: number; type?: 'Soft' | 'Hard' }
    >({
      query: ({ pillarId, ...body }) => ({
        url: `/api/v1/operator/pillars/${pillarId}/commands`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Command', 'Pillar'],
    }),
    faults: b.query<FaultEvent[], 'open' | 'all'>({
      query: (status) => `/api/v1/operator/faults?status=${status}`,
      providesTags: ['Fault'],
    }),
    acknowledgeFault: b.mutation<FaultEvent, number>({
      query: (id) => ({ url: `/api/v1/operator/faults/${id}/acknowledge`, method: 'POST' }),
      invalidatesTags: ['Fault', 'Summary', 'Pillar'],
    }),
    resetFault: b.mutation<
      { fault: FaultEvent; resetStatus: 'Accepted' | 'Rejected' },
      { id: number; type: 'Soft' | 'Hard' }
    >({
      query: ({ id, type }) => ({
        url: `/api/v1/operator/faults/${id}/reset?type=${type}`,
        method: 'POST',
      }),
      invalidatesTags: ['Fault', 'Summary', 'Pillar', 'Command'],
    }),
    closeFault: b.mutation<FaultEvent, number>({
      query: (id) => ({ url: `/api/v1/operator/faults/${id}/close`, method: 'POST' }),
      invalidatesTags: ['Fault', 'Summary', 'Pillar'],
    }),
    sessions: b.query<ReviewSession[], SessionQueue>({
      query: (queue) => `/api/v1/operator/sessions?queue=${queue}`,
      providesTags: ['Session'],
    }),
    resolveSession: b.mutation<ReviewSession, { id: number; note: string }>({
      query: ({ id, note }) => ({
        url: `/api/v1/operator/sessions/${id}/resolve`,
        method: 'POST',
        body: { note },
      }),
      invalidatesTags: ['Session', 'Summary'],
    }),
    startIntents: b.query<StartIntent[], void>({
      query: () => '/api/v1/operator/charge-intents',
      providesTags: ['Intent'],
    }),
    intentAction: b.mutation<
      StartIntent,
      {
        id: number;
        action: 'begin-recovery' | 'approve-late-start' | 'restore-connector';
        note?: string;
      }
    >({
      query: ({ id, action, note }) => ({
        url: `/api/v1/operator/charge-intents/${id}/${action}`,
        method: 'POST',
        body: { note },
      }),
      invalidatesTags: ['Intent', 'Summary'],
    }),
    tariff: b.query<TariffPeriod[], void>({
      query: () => '/api/v1/operator/tariffs',
      providesTags: ['Tariff'],
    }),
    saveTariff: b.mutation<TariffPeriod[], TariffPeriod[]>({
      query: (periods) => ({ url: '/api/v1/operator/tariffs', method: 'PUT', body: { periods } }),
      invalidatesTags: ['Tariff'],
    }),
    promotions: b.query<Promotion[], void>({ query: () => '/api/v1/operator/promotions' }),
    tickets: b.query<MaintenanceTicket[], void>({ query: () => '/api/v1/operator/tickets' }),
    revenue: b.query<PillarRevenue[], void>({ query: () => '/api/v1/operator/analytics/revenue' }),

    // ---- Admin ----
    adminSummary: b.query<AdminSummary, void>({
      query: () => '/api/admin/summary',
      providesTags: ['AdminSummary'],
    }),
    users: b.query<UserAccount[], void>({
      query: () => '/api/admin/users',
      providesTags: ['User'],
    }),
    setUserRole: b.mutation<UserAccount, { id: number; role: UserAccount['role'] }>({
      query: ({ id, role }) => ({ url: `/api/admin/users/${id}`, method: 'PATCH', body: { role } }),
      invalidatesTags: ['User', 'AdminSummary'],
    }),
    devices: b.query<DeviceRecord[], void>({
      query: () => '/api/admin/devices',
      providesTags: ['Device'],
    }),
    registerDevice: b.mutation<DeviceRecord, { serial: string; model: string; firmware: string }>({
      query: (body) => ({ url: '/api/admin/devices', method: 'POST', body }),
      invalidatesTags: ['Device', 'AdminSummary'],
    }),
    cards: b.query<RfidCard[], void>({ query: () => '/api/admin/cards' }),
    freeVendTags: b.query<FreeVendTag[], void>({ query: () => '/api/admin/free-vend-tags' }),
    policyTemplates: b.query<{ id: number; name: string; kind: string; updatedAt: string }[], void>(
      {
        query: () => '/api/admin/policy-templates',
      },
    ),
    systemHealth: b.query<
      {
        csms: string;
        database: string;
        ocppConnections: number;
        messagesLastHour: number;
        reconciliationConflicts: number;
      },
      void
    >({ query: () => '/api/admin/system-health' }),

    // UC-ADM-08
    refundableTopUps: b.query<Page<RefundableTopUp>, void>({
      query: () => '/api/admin/billing/top-ups?status=credited',
      providesTags: ['TopUp'],
    }),
    refundTopUp: b.mutation<
      { status: 'refunded'; refundedVnd: number; pointsRestored: number },
      number
    >({
      query: (id) => ({ url: `/api/admin/billing/top-ups/${id}/refund`, method: 'POST' }),
      invalidatesTags: ['TopUp', 'AdminSummary'],
    }),
    latePayments: b.query<Page<LatePayment>, void>({
      query: () => '/api/admin/billing/top-ups/late-payments',
      providesTags: ['LatePayment'],
    }),
    refundLatePayment: b.mutation<{ lateRefundedAt: string }, number>({
      query: (id) => ({ url: `/api/admin/billing/top-ups/${id}/late-refund`, method: 'POST' }),
      invalidatesTags: ['LatePayment', 'AdminSummary'],
    }),
    needsReviewInvoices: b.query<Page<NeedsReviewInvoice>, void>({
      query: () => '/api/admin/billing/e-invoices?status=needs_review',
      providesTags: ['EInvoice'],
    }),
    retryInvoice: b.mutation<
      | { status: 'issued'; invoiceNo: string }
      | {
          status: 'needs_review';
          attemptCount: number;
          lastErrorKind: string;
          lastErrorMessage: string;
        },
      number
    >({
      query: (id) => ({ url: `/api/admin/billing/e-invoices/${id}/retry`, method: 'POST' }),
      invalidatesTags: ['EInvoice', 'AdminSummary'],
    }),
    closedAccounts: b.query<Page<ClosedAccountRefund>, void>({
      query: () => '/api/admin/billing/credit-accounts?status=closed_unrefunded',
      providesTags: ['ClosedAccount'],
    }),
    closureRefund: b.mutation<
      {
        status: 'refunded';
        allocations: { topUpId: number; amountVnd: number }[];
        uncoveredVnd: number;
      },
      number
    >({
      query: (id) => ({
        url: `/api/admin/billing/credit-accounts/${id}/closure-refund`,
        method: 'POST',
      }),
      invalidatesTags: ['ClosedAccount', 'AdminSummary'],
    }),
  }),
});

export const {
  useLoginMutation,
  useOperatorSummaryQuery,
  useSitesQuery,
  usePillarsQuery,
  usePillarQuery,
  useOnboardPillarMutation,
  useSendCommandMutation,
  useFaultsQuery,
  useAcknowledgeFaultMutation,
  useResetFaultMutation,
  useCloseFaultMutation,
  useSessionsQuery,
  useResolveSessionMutation,
  useStartIntentsQuery,
  useIntentActionMutation,
  useTariffQuery,
  useSaveTariffMutation,
  usePromotionsQuery,
  useTicketsQuery,
  useRevenueQuery,
  useAdminSummaryQuery,
  useUsersQuery,
  useSetUserRoleMutation,
  useDevicesQuery,
  useRegisterDeviceMutation,
  useCardsQuery,
  useFreeVendTagsQuery,
  usePolicyTemplatesQuery,
  useSystemHealthQuery,
  useRefundableTopUpsQuery,
  useRefundTopUpMutation,
  useLatePaymentsQuery,
  useRefundLatePaymentMutation,
  useNeedsReviewInvoicesQuery,
  useRetryInvoiceMutation,
  useClosedAccountsQuery,
  useClosureRefundMutation,
} = api;
