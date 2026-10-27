/**
 * Kiểu dữ liệu miền mà dashboard nhận từ API (hiện là mock, src/mocks).
 *
 * Tên trạng thái giữ đúng enum của CSMS (apps/csms/src/db/schema/enums.ts) để khi nối API thật
 * không phải đổi UI. Khi `@powerme/shared` có kiểu chung (PKG-2: api, types → @powerme/shared),
 * file này chuyển sang đó.
 */

export type Role = 'operator' | 'admin';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** Operator chỉ thấy trụ của operator mình (BR-P11/P16); admin = null. */
  operatorId: number | null;
  operatorName: string | null;
}

// ---- trụ & súng (STM-2, STM-3) -------------------------------------------------------------

export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

export type PillarLifecycle =
  'registered' | 'awaiting_connection' | 'in_service' | 'disabled' | 'decommissioned';

export type PillarModel = 'D1-120' | 'YJ-EU-60';

export interface Connector {
  connectorNo: 1 | 2;
  status: ConnectorStatus;
  errorCode: string | null;
  statusChangedAt: string;
  /** Phiên đang chạy trên súng (nếu có). */
  activeSession: { transactionNo: number; energyWh: number; startedAt: string } | null;
}

export interface Pillar {
  id: number;
  serial: string;
  displayCode: string;
  model: PillarModel;
  firmware: string;
  siteId: number;
  siteName: string;
  lifecycle: PillarLifecycle;
  isOnline: boolean;
  lastSeenAt: string | null;
  connectors: Connector[];
}

export interface Site {
  id: number;
  code: string;
  name: string;
  address: string;
}

// ---- lệnh từ xa (remote_commands) ------------------------------------------------------------

export type CommandAction = 'Reset' | 'UnlockConnector' | 'RemoteStopTransaction';
export type CommandStatus = 'pending' | 'sent' | 'accepted' | 'rejected' | 'timeout' | 'failed';

export interface RemoteCommand {
  id: number;
  pillarId: number;
  action: CommandAction;
  connectorNo: number | null;
  payload: Record<string, unknown>;
  status: CommandStatus;
  requestedAt: string;
  respondedAt: string | null;
}

// ---- sự cố (STM-6, WF-04) ----------------------------------------------------------------------

export type FaultStatus = 'raised' | 'acknowledged' | 'resetting' | 'resolved';
export type FaultSource = 'ocpp' | 'driver_report' | 'operator';
export type FaultSeverity = 'critical' | 'major' | 'minor' | 'none';

export interface FaultEvent {
  id: number;
  eventNo: number;
  pillarId: number;
  serial: string;
  siteName: string;
  /** 0 = cả trụ (connector_id null trong DB). */
  connectorNo: number;
  source: FaultSource;
  errorCode: string | null;
  severity: FaultSeverity;
  hint: string;
  status: FaultStatus;
  raisedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resetCommandId: number | null;
  resetCommandStatus: CommandStatus | null;
  /** Hạn chờ Reset (khi resetting). */
  resetDeadline: string | null;
  pillarOnline: boolean;
  /** Báo lỗi của tài xế gắn vào sự cố (UC-CHG-05). */
  driverReports: number;
}

// ---- phiên cần xử lý (WF-03, UC-OPS-05, WP3 T72) ------------------------------------------------

export type SessionQueue = 'review' | 'unattributed';

export interface ReviewSession {
  id: number;
  transactionNo: number;
  serial: string;
  connectorNo: number;
  idTag: string;
  origin: 'rfid' | 'app_qr' | 'free_vend' | 'hmi_password';
  paymentMode: 'csms_billed' | 'station_wallet' | 'unattributed';
  status: 'review' | 'reconciled' | 'closed';
  queue: SessionQueue;
  reason: string;
  meterStopWh: number | null;
  seriesLastWh: number | null;
  startedAt: string;
  endedAt: string | null;
  deliveredOffline: boolean;
  resolvedNote: string | null;
}

export type StartIntentState =
  'stuck' | 'recovering' | 'late_start_approved' | 'connector_restored';

export interface StartIntent {
  id: number;
  driverEmail: string;
  serial: string;
  connectorNo: number;
  requestedAt: string;
  state: StartIntentState;
  /** Trụ có gửi StartTransaction muộn không (WP3 T72: approveLateStart chỉ khi có). */
  lateStartSeen: boolean;
  note: string | null;
}

// ---- biểu giá (M4, UC-OPS-06/07) -----------------------------------------------------------------

export type TariffBandName = 'Sharp' | 'Peak' | 'Shoulder' | 'Off-peak';

export interface TariffPeriod {
  band: TariffBandName;
  /** "HH:MM" — bắt đầu (bao gồm) và kết thúc (không bao gồm); "24:00" = hết ngày. */
  start: string;
  end: string;
  pricePerKwhVnd: number;
}

export interface Promotion {
  id: number;
  name: string;
  discountPercent: number;
  validFrom: string;
  validTo: string;
  active: boolean;
}

export interface MaintenanceTicket {
  id: number;
  ticketNo: number;
  faultEventNo: number;
  serial: string;
  status: 'open' | 'in_progress' | 'closed';
  assignedTo: string | null;
  openedAt: string;
}

export interface PillarRevenue {
  serial: string;
  siteName: string;
  sessions: number;
  energyKwh: number;
  revenueVnd: number;
  unattributedSessions: number;
  utilisationPercent: number;
}

// ---- admin ------------------------------------------------------------------------------------------

export interface UserAccount {
  id: number;
  email: string;
  name: string;
  role: 'driver' | 'operator' | 'admin';
  operatorName: string | null;
  status: 'active' | 'closed';
  createdAt: string;
}

export interface DeviceRecord {
  id: number;
  serial: string;
  model: PillarModel;
  firmware: string;
  lifecycle: PillarLifecycle;
  operatorName: string | null;
  registeredAt: string;
  warrantyUntil: string;
}

export interface RfidCard {
  id: number;
  uid: string;
  type: 'online' | 'wallet';
  holder: string | null;
  status: 'active' | 'blocked';
}

export interface FreeVendTag {
  serial: string;
  tag: string;
}

// ---- UC-ADM-08 Billing Exceptions -----------------------------------------------------------------

export interface RefundableTopUp {
  id: number;
  driverName: string;
  gatewayRef: string;
  amountVnd: number;
  amountPaidVnd: number;
  pointsRedeemed: number;
  completedAt: string;
  balanceVnd: number;
  refundable: boolean;
}

export interface LatePayment {
  id: number;
  driverName: string;
  lateGatewayRef: string;
  lateAmountVnd: number;
  latePaidAt: string;
  expiresAt: string;
}

export interface NeedsReviewInvoice {
  id: number;
  topUpId: number;
  driverName: string;
  amountVnd: number;
  attemptCount: number;
  lastErrorKind: 'temporary' | 'rejected';
  lastErrorMessage: string;
  updatedAt: string;
}

export interface ClosedAccountRefund {
  id: number;
  driverName: string;
  closedAt: string;
  unusedBalanceVnd: number;
  /** Nguồn hoàn: các top-up credited mới nhất trước (BR-P21). */
  sources: { topUpId: number; gatewayRef: string; amountVnd: number }[];
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ApiErrorBody {
  error: string;
  detail: string;
}
