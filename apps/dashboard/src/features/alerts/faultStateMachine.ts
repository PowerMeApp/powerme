/**
 * STM-6 FaultEvent ở phía dashboard — CÙNG bảng chuyển với
 * apps/csms/src/stations/faults/fault-state-machine.ts (FE-04), để UI chỉ bật nút hành động hợp lệ
 * và mock server áp đúng luật. Khi có `@powerme/shared`, hai bản gộp làm một.
 */
import type { FaultStatus } from '../../types/domain';

export type FaultTrigger =
  | 'SIGNAL'
  | 'ACKNOWLEDGE'
  | 'RESET_SENT'
  | 'RESET_FAILED'
  | 'CONNECTOR_AVAILABLE'
  | 'OPERATOR_CLOSE';

export const FAULT_STATUSES: readonly FaultStatus[] = [
  'raised',
  'acknowledged',
  'resetting',
  'resolved',
];
export const FAULT_TRIGGERS: readonly FaultTrigger[] = [
  'SIGNAL',
  'ACKNOWLEDGE',
  'RESET_SENT',
  'RESET_FAILED',
  'CONNECTOR_AVAILABLE',
  'OPERATOR_CLOSE',
];

/** t2…t7 của STM-6 v0.2 (t7 có hai trigger). */
export const FAULT_TRANSITIONS: readonly {
  no: string;
  from: FaultStatus;
  trigger: FaultTrigger;
  to: FaultStatus;
}[] = [
  { no: 't2', from: 'raised', trigger: 'ACKNOWLEDGE', to: 'acknowledged' },
  { no: 't3', from: 'raised', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't4', from: 'acknowledged', trigger: 'RESET_SENT', to: 'resetting' },
  { no: 't5', from: 'resetting', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't6', from: 'resetting', trigger: 'RESET_FAILED', to: 'acknowledged' },
  { no: 't7', from: 'acknowledged', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't7', from: 'acknowledged', trigger: 'OPERATOR_CLOSE', to: 'resolved' },
];

export function isOpenFault(status: FaultStatus): boolean {
  return status !== 'resolved';
}

/** Trạng thái đích; `null` khi không có trong STM-6. SIGNAL trên sự cố mở = giữ nguyên (no-op). */
export function nextFaultStatus(from: FaultStatus, trigger: FaultTrigger): FaultStatus | null {
  if (trigger === 'SIGNAL') return isOpenFault(from) ? from : null;
  return FAULT_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger)?.to ?? null;
}

export function canApplyFault(from: FaultStatus, trigger: FaultTrigger): boolean {
  return nextFaultStatus(from, trigger) !== null;
}

export const FAULT_STATUS_LABEL: Record<FaultStatus, string> = {
  raised: 'Mới',
  acknowledged: 'Đã xác nhận',
  resetting: 'Đang reset',
  resolved: 'Đã xử lý',
};
