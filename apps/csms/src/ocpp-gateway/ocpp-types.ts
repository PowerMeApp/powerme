/**
 * Kiểu dữ liệu tối thiểu của các bản tin OCPP 1.6J mà Iteration 1 xử lý, và vài hàm tiện ích
 * về frame OCPP-J.
 *
 * Vì sao tồn tại: ocpp-rpc (ADR-0004, strictMode) đã validate payload theo schema OCA trước khi
 * gọi handler, nên ở đây chỉ cần khai báo kiểu để TypeScript strict đọc được các trường — KHÔNG
 * chép schema OCA (giấy phép CC BY-ND 4.0, ADR-0004). Chỉ liệt kê trường CSMS dùng.
 *
 * `cpTimestampOf` port từ `lab/trace.mjs`: lấy đồng hồ trụ trong payload (ADR-0009 — cột
 * cp_timestamp bên cạnh received_at).
 */
import type { ConnectorStatus } from '../sessions/connectors/valid-transitions.js';

/** MessageTypeId của OCPP-J: 2 = CALL · 3 = CALLRESULT · 4 = CALLERROR. */
export const MESSAGE_TYPE = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 } as const;
export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export const HANDLED_ACTIONS = [
  'BootNotification',
  'Heartbeat',
  'StatusNotification',
  'Authorize',
  'StartTransaction',
  'MeterValues',
  'StopTransaction',
  'DataTransfer',
] as const;
export type HandledAction = (typeof HANDLED_ACTIONS)[number];

export interface SampledValue {
  value: string;
  context?: string;
  format?: string;
  measurand?: string;
  phase?: string;
  location?: string;
  unit?: string;
}

export interface MeterValue {
  timestamp: string;
  sampledValue: SampledValue[];
}

export interface BootNotificationRequest {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  firmwareVersion?: string;
}

export interface StatusNotificationRequest {
  connectorId: number;
  errorCode: string;
  status: ConnectorStatus;
  info?: string;
  timestamp?: string;
  vendorId?: string;
  vendorErrorCode?: string;
}

export interface AuthorizeRequest {
  idTag: string;
}

export interface StartTransactionRequest {
  connectorId: number;
  idTag: string;
  meterStart: number;
  reservationId?: number;
  timestamp: string;
}

export interface MeterValuesRequest {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValue[];
}

export interface StopTransactionRequest {
  idTag?: string;
  meterStop: number;
  timestamp: string;
  transactionId: number;
  reason?: string;
  transactionData?: MeterValue[];
}

export interface DataTransferRequest {
  vendorId: string;
  messageId?: string;
  data?: string;
}

/** Một CALL chiều vào đã được ocpp-rpc tách thành ba phần. */
export interface InboundCall {
  messageId: string;
  action: string;
  params: unknown;
}

/** Đồng hồ trụ trong payload: `timestamp` ở gốc, hoặc `meterValue[0].timestamp` với MeterValues. */
export function cpTimestampOf(action: string, params: unknown): Date | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  let raw: unknown = p['timestamp'];
  if (raw === undefined && action === 'MeterValues' && Array.isArray(p['meterValue'])) {
    const first: unknown = p['meterValue'][0];
    if (typeof first === 'object' && first !== null) {
      raw = (first as Record<string, unknown>)['timestamp'];
    }
  }
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse một frame OCPP-J thô; trả null nếu không phải mảng [type, id, ...]. */
export function parseFrame(
  message: string,
): { messageType: MessageType; uniqueId: string; action: string | null; raw: unknown } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [t, id, third] = raw as unknown[];
  if ((t !== 2 && t !== 3 && t !== 4) || typeof id !== 'string') return null;
  return {
    messageType: t,
    uniqueId: id,
    action: t === 2 && typeof third === 'string' ? third : null,
    raw,
  };
}
