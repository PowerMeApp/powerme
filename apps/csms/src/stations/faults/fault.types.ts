/**
 * Kiểu, hằng và lỗi của WF-04 (STM-6): dùng chung bởi FaultService, fault-store, fault-queries,
 * driver-report và các route (console, operator API, Driver API). `fault.service.ts` re-export
 * toàn bộ file này, nên người gọi cũ vẫn import từ `fault.service.js`.
 */
import type { FaultSeverity } from './error-code-guide.js';
import type { FaultStatus } from './fault-state-machine.js';

export const FAULT_RESET_SCHEDULER = Symbol('FAULT_RESET_SCHEDULER');

export type ResetType = 'Soft' | 'Hard';

/** Không có sự cố với id này. */
export class FaultNotFoundError extends Error {
  constructor(readonly faultId: number) {
    super(`Không có sự cố id=${faultId}`);
    this.name = 'FaultNotFoundError';
  }
}

/** Việc FaultService đã làm với một StatusNotification. */
export type StatusOutcome =
  | { kind: 'raised'; faultId: number }
  /** `errorCode`: mã Faulted vừa ghi vào sự cố tài xế báo chưa có mã (T131). */
  | { kind: 'attached'; faultId: number; errorCode?: string }
  | {
      kind: 'resolved';
      faultId: number;
      from: FaultStatus;
      /** T141: driver reports moved to an open fault of their connector (label kept). */
      handedOver?: { toFaultId: number; reports: number; created: boolean }[];
    }
  /** Bản phát lại cũ hơn trạng thái hiện tại của sự cố: không đổi gì (xem {@link eventTime}). */
  | { kind: 'stale'; faultId: number | null }
  | { kind: 'none' };

/** FE-17 (UC-CHG-05): lỗi nghiệp vụ của báo lỗi từ tài xế; route HTTP đổi sang mã lỗi. */
export class DriverReportError extends Error {
  constructor(readonly code: 'invalid_description' | 'not_found' | 'duplicate_report') {
    super(code);
    this.name = 'DriverReportError';
  }
}

export interface DriverReportResult {
  reportId: number;
  reportNo: number;
  connectorId: number;
  reportedAt: Date;
  /** Sự cố mà báo cáo được gắn vào (mới tạo hoặc đang mở); null = chờ gộp sau (AD-7). */
  faultEventId: number | null;
  /** Súng đang mang nhãn "reported issue" (BR-P42) sau báo cáo này. */
  reportedIssue: boolean;
}

/** BR-P42: cửa sổ 2 giờ — đếm tài xế khác nhau, và gộp báo cáo chờ khi một sự cố mở (Q79). */
export const REPORT_WINDOW_MS = 2 * 3600 * 1000;
/** Q80: cùng tài xế, cùng súng trong 60 s → trùng (bấm hai lần). */
export const DUPLICATE_REPORT_MS = 60 * 1000;
/** Q77: phiên dừng vì các lý do này không phải "hoàn tất bình thường" (BR-P42). */
export const FAULT_STOP_REASONS: ReadonlySet<string> = new Set([
  'EmergencyStop',
  'PowerLoss',
  'Other',
]);

export interface ConnectorStatusInput {
  chargePointId: number;
  /** connectorId của OCPP: 0 = cả trụ. */
  connectorNo: number;
  status: string;
  errorCode: string | null;
  receivedAt: Date;
  /**
   * Lúc sự việc xảy ra: đồng hồ trụ (`timestamp` trong payload) nếu frame là bản phát lại, ngược
   * lại `receivedAt` (ADR-0009: received_at là đồng hồ tin cậy cho frame live). Ghi raised_at /
   * resolved_at. Bỏ trống = `receivedAt`.
   */
  occurredAt?: Date;
}

/**
 * Trạng thái súng coi là ĐÃ HỒI PHỤC (trigger CONNECTOR_AVAILABLE của STM-6). OCPP 1.6 cho súng
 * thoát Faulted sang bất kỳ trạng thái nào (bảng I1…I8, `valid-transitions.ts`): lỗi tự hết rồi tài
 * xế cắm sạc luôn thì súng đi Faulted → Preparing → Charging, không qua Available. `Unavailable`
 * KHÔNG nằm đây: đó là bước giữa lúc trụ khởi động lại (T13 2.3 #14), lỗi có thể vẫn còn.
 */
export const RECOVERED_STATUSES: ReadonlySet<string> = new Set([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
]);

export interface BeginResetResult {
  faultId: number;
  commandId: number;
  serial: string;
}

/** Kết quả CALL Reset do người gọi báo lại. */
export type ResetOutcome =
  { status: 'Accepted' | 'Rejected'; response?: unknown } | { error: string };

/** List filter: `open` = not resolved, `all`, or exactly one STM-6 status (screen 21). */
export type FaultListFilter = 'open' | 'all' | FaultStatus;

/** Một dòng của danh sách cảnh báo (console, sau này dashboard FE-04). */
export interface FaultListItem {
  id: number;
  eventNo: number;
  chargePointId: number;
  serial: string;
  connectorNo: number | null;
  source: string;
  errorCode: string | null;
  severity: FaultSeverity;
  hint: string;
  status: FaultStatus;
  raisedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resetCommandId: number | null;
  resetCommandStatus: string | null;
  /** When the pending Reset was requested; its wait ends `resetTimeoutS` later. */
  resetRequestedAt: Date | null;
  isOnline: boolean;
  /** Số báo cáo của tài xế gắn vào sự cố (F-05: Operator thấy báo cáo). */
  reportCount: number;
  /** Charging Station name (`sites.site_name`); null for a charge point not yet on a site. */
  siteName: string | null;
}

/**
 * Bản phát lại cũ hơn mức này coi là đồng hồ trụ sai (pin RTC hết → 1970…), không phải hàng đợi
 * offline thật. Hàng đợi của trụ không giữ lâu hơn vài ngày; 30 ngày để dư.
 */
export const MAX_REPLAY_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * Thời điểm ghi cho sự cố: `occurredAt` (giờ trụ của bản phát lại) nhưng KHÔNG muộn hơn lúc CSMS
 * nhận (đồng hồ trụ chạy nhanh) và không cũ hơn {@link MAX_REPLAY_AGE_MS} (đồng hồ trụ hỏng) —
 * hai trường hợp đó dùng `receivedAt` (ADR-0009: received_at là đồng hồ tin cậy).
 */
export function eventTime(input: Pick<ConnectorStatusInput, 'occurredAt' | 'receivedAt'>): Date {
  const occurred = input.occurredAt;
  if (!occurred || Number.isNaN(occurred.getTime())) return input.receivedAt;
  const rx = input.receivedAt.getTime();
  if (occurred.getTime() > rx || rx - occurred.getTime() > MAX_REPLAY_AGE_MS) {
    return input.receivedAt;
  }
  return occurred;
}
