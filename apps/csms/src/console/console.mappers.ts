/**
 * Các hàm THUẦN biến dòng DB (đã đọc bằng Drizzle) thành JSON phản hồi của bảng điều khiển.
 *
 * Vì sao tồn tại: tách phần "định dạng" khỏi phần "truy vấn" (console.queries.ts) để test được
 * mà không cần DB. Mọi tên trường JSON là snake_case; thời điểm là chuỗi ISO-8601 UTC.
 *
 * Quy tắc trung thực: chỉ số không tính được từ dữ liệu có sẵn thì trả `null` (trang hiển thị
 * "—"), không bịa. Hai chỗ như vậy:
 *   - `replayed` của một dòng log/mẫu đo: null khi không có cp_timestamp hoặc không tìm được
 *     epoch tương ứng (ReplayDetector cần cả hai; Heartbeat/StatusNotification của SAP không
 *     mang timestamp — giới hạn đã biết, xem replay-detector.ts).
 *   - `energy_wh` của phiên chưa đóng: null (cột dẫn xuất chỉ có khi đóng phiên);
 *     `latest_meter_wh` cho biết số đọc đồng hồ mới nhất nếu có mẫu.
 *
 * Bảng `session_status_history` đã có từ migration 0001 nhưng console chưa đọc nó, nên chi tiết
 * phiên vẫn không có danh sách chuyển trạng thái (việc của lần sau, không làm lẫn vào BE-11).
 *
 * Từ migration 0001, `conflict` và `late_sample` là giá trị enum reconciliation_record_type.
 * Bản ghi TRƯỚC 0001 lưu conflict như record_type = meter_gap + resolution bắt đầu bằng "conflict"
 * (mẫu muộn: meter_gap + "(late_sample)"); `reconciliationKind()` vẫn đọc được cả hai dạng.
 */
import type { ReplayDetector } from '../reconciliation/replay-detector.js';

export const SESSION_STATUSES = [
  'pending',
  'active',
  'paused',
  'stopping',
  'closed',
  'review',
  'reconciled',
  'orphaned',
  'failed',
] as const;

export const RECONCILIATION_TYPES = [
  'replay',
  'duplicate',
  'meter_gap',
  'orphan_stop',
  'unknown_id_tag',
  'conflict',
  'late_sample',
] as const;

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Trụ & súng
// ---------------------------------------------------------------------------

export interface StationInput {
  serialNumber: string;
  lifecycle: string;
  currentEpoch: number;
  lastMessageAt: Date | null;
  /** Cột `is_online` trong DB (ADR-0016 D-C). Khác `connected` (socket trong RAM) sau khi CSMS chết. */
  isOnline?: boolean;
  onlineChangedAt?: Date | null;
  connectors: { connectorNo: number; status: string; statusChangedAt: Date | null }[];
}

/**
 * `lifecycle` (hành chính) và kết nối là HAI trường độc lập (ADR-0016 D-C): `connected` = socket
 * đang mở theo registry (RAM); `is_online` = giá trị đã ghi trong DB (lệch tạm thời sau khi CSMS chết).
 */
export function mapStation(row: StationInput, connected: boolean) {
  return {
    serial: row.serialNumber,
    lifecycle: row.lifecycle,
    current_epoch: row.currentEpoch,
    last_message_at: iso(row.lastMessageAt),
    connected,
    is_online: row.isOnline ?? connected,
    online_changed_at: iso(row.onlineChangedAt),
    connectors: [...row.connectors]
      .sort((a, b) => a.connectorNo - b.connectorNo)
      .map((c) => ({
        connector_no: c.connectorNo,
        status: c.status,
        status_changed_at: iso(c.statusChangedAt),
      })),
  };
}

// ---------------------------------------------------------------------------
// Đối soát
// ---------------------------------------------------------------------------

export type ReconciliationKind =
  | 'conflict'
  | 'gap_detected'
  | 'replay'
  | 'duplicate'
  | 'orphan_stop'
  | 'unknown_id_tag'
  | 'meter_gap'
  | 'late_sample';

/**
 * "Loại hiển thị" của bản ghi đối soát.
 *  - `conflict` → conflict.
 *  - `late_sample` → kết luận nằm ở tiền tố resolution ("conflict (late_sample): …" → conflict,
 *    "gap_detected (late_sample): …" → gap_detected); không đọc được thì giữ nguyên late_sample.
 *  - `meter_gap` → gap_detected, hoặc (DỮ LIỆU CŨ trước 0001) conflict nếu resolution mở đầu
 *    bằng "conflict".
 */
export function reconciliationKind(
  recordType: string,
  resolution: string | null,
): ReconciliationKind {
  if (recordType === 'conflict') return 'conflict';
  if (recordType === 'late_sample') {
    if (resolution?.startsWith('conflict')) return 'conflict';
    if (resolution?.startsWith('gap_detected')) return 'gap_detected';
    return 'late_sample';
  }
  if (recordType === 'meter_gap') {
    if (resolution?.startsWith('conflict')) return 'conflict';
    if (resolution?.startsWith('gap_detected')) return 'gap_detected';
    return 'meter_gap';
  }
  if (
    recordType === 'replay' ||
    recordType === 'duplicate' ||
    recordType === 'orphan_stop' ||
    recordType === 'unknown_id_tag'
  ) {
    return recordType;
  }
  return 'meter_gap';
}

/** Rút một số từ chuỗi `key=value` trong resolution; "null"/thiếu → null. */
export function resolutionNumber(resolution: string | null, key: string): number | null {
  if (!resolution) return null;
  const m = new RegExp(`(?:^|\\s)${key}=(-?\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(resolution);
  if (!m || m[1] === undefined) return null;
  return Number(m[1]);
}

export interface ReconciliationInput {
  id: number;
  sessionId: number;
  transactionNo: number | null;
  recordNo: number;
  recordType: string;
  gapStart: Date | null;
  gapEnd: Date | null;
  energyDifferenceWh: number | null;
  reviewedAt: Date | null;
  resolution: string | null;
  createdAt: Date;
}

export function mapReconciliation(row: ReconciliationInput) {
  const kind = reconciliationKind(row.recordType, row.resolution);
  return {
    id: row.id,
    session_id: row.sessionId,
    transaction_no: row.transactionNo,
    record_no: row.recordNo,
    record_type: row.recordType,
    kind,
    // Dạng mới: record_type = late_sample · dạng cũ (trước 0001): meter_gap + "(late_sample)".
    late_sample:
      row.recordType === 'late_sample' || (row.resolution?.includes('(late_sample)') ?? false),
    gap_start: iso(row.gapStart),
    gap_end: iso(row.gapEnd),
    energy_difference_wh: row.energyDifferenceWh,
    // Số rút từ chuỗi resolution để trang diễn giải một câu; null khi resolution không có.
    meter_stop_minus_start_wh: resolutionNumber(row.resolution, 'meter_stop_minus_start'),
    series_last_wh: resolutionNumber(row.resolution, 'series_last'),
    reviewed: row.reviewedAt !== null,
    resolution: row.resolution,
    created_at: iso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Phiên sạc
// ---------------------------------------------------------------------------

export interface SessionInput {
  id: number;
  transactionNo: number;
  serialNumber: string;
  connectorNo: number;
  idTag: string;
  origin: string;
  paymentMode: string;
  status: string;
  receivedStartedAt: Date;
  receivedStoppedAt: Date | null;
  cpStartedAt: Date;
  cpStoppedAt: Date | null;
  meterStartWh: number;
  meterStopWh: number | null;
  stopReason: string | null;
  deliveredOffline: boolean;
  energyWh: number | null;
}

export interface SessionExtras {
  meterValueCount: number;
  hasConflict: boolean;
  /** Số đọc Energy.Active.Import.Register mới nhất (Wh), null nếu phiên chưa có mẫu. */
  latestMeterWh: number | null;
}

/**
 * started_at/ended_at lấy theo đồng hồ CSMS (received_*, tin cậy — ADR-0009); đồng hồ trụ
 * được trả riêng ở cp_started_at/cp_stopped_at.
 */
export function mapSession(row: SessionInput, extra: SessionExtras) {
  return {
    id: row.id,
    transaction_no: row.transactionNo,
    station: row.serialNumber,
    connector_no: row.connectorNo,
    id_tag: row.idTag,
    origin: row.origin,
    payment_mode: row.paymentMode,
    status: row.status,
    started_at: iso(row.receivedStartedAt),
    ended_at: iso(row.receivedStoppedAt),
    cp_started_at: iso(row.cpStartedAt),
    cp_stopped_at: iso(row.cpStoppedAt),
    meter_start_wh: row.meterStartWh,
    meter_stop_wh: row.meterStopWh,
    energy_wh: row.energyWh,
    latest_meter_wh: extra.latestMeterWh,
    stop_reason: row.stopReason,
    delivered_offline: row.deliveredOffline,
    meter_value_count: extra.meterValueCount,
    has_conflict: extra.hasConflict,
  };
}

// ---------------------------------------------------------------------------
// Phát lại (cùng logic ReplayDetector)
// ---------------------------------------------------------------------------

/**
 * `replayed` theo ReplayDetector; null khi không đủ dữ kiện (không có cp_timestamp hoặc không
 * biết epoch_opened_at). Không bao giờ đoán.
 */
export function replayedFlag(
  detector: ReplayDetector,
  cpTimestamp: Date | null,
  receivedAt: Date,
  epochOpenedAt: Date | null,
): boolean | null {
  if (cpTimestamp === null || epochOpenedAt === null) return null;
  return detector.classify({ cpTimestamp, receivedAt, epochOpenedAt }).replayed;
}

/**
 * Mốc mở epoch có hiệu lực tại `at`: kết nối mở gần nhất với opened_at ≤ at. Dùng cho mẫu
 * meter_values (bảng này không lưu epoch). `connections` không cần sắp xếp.
 */
export function epochOpenedAtFor(connections: { openedAt: Date }[], at: Date): Date | null {
  let best: Date | null = null;
  for (const c of connections) {
    if (c.openedAt.getTime() <= at.getTime() && (best === null || c.openedAt > best)) {
      best = c.openedAt;
    }
  }
  return best;
}

export interface MeterValueInput {
  id: number;
  cpTimestamp: Date;
  receivedAt: Date;
  measurand: string;
  value: string | number;
  unit: string | null;
  context: string | null;
  phase: string | null;
}

export function mapMeterValue(
  row: MeterValueInput,
  detector: ReplayDetector,
  connections: { openedAt: Date }[],
) {
  return {
    id: row.id,
    cp_timestamp: iso(row.cpTimestamp),
    received_at: iso(row.receivedAt),
    measurand: row.measurand,
    value: Number(row.value),
    unit: row.unit,
    context: row.context,
    phase: row.phase,
    replayed: replayedFlag(
      detector,
      row.cpTimestamp,
      row.receivedAt,
      epochOpenedAtFor(connections, row.receivedAt),
    ),
  };
}

// ---------------------------------------------------------------------------
// Nhật ký OCPP
// ---------------------------------------------------------------------------

export interface MessageInput {
  id: number;
  serialNumber: string;
  receivedAt: Date;
  cpTimestamp: Date | null;
  epoch: number;
  direction: string;
  messageType: number;
  action: string | null;
  uniqueId: string;
  /** opened_at của (trụ, epoch) trong charge_point_connections; null nếu không có dòng. */
  epochOpenedAt: Date | null;
}

export function mapMessage(row: MessageInput, detector: ReplayDetector) {
  return {
    id: row.id,
    station: row.serialNumber,
    received_at: iso(row.receivedAt),
    cp_timestamp: iso(row.cpTimestamp),
    epoch: row.epoch,
    direction: row.direction,
    message_type: row.messageType,
    action: row.action,
    unique_id: row.uniqueId,
    replayed: replayedFlag(detector, row.cpTimestamp, row.receivedAt, row.epochOpenedAt),
  };
}

// ---------------------------------------------------------------------------
// Tóm tắt
// ---------------------------------------------------------------------------

export interface SummaryInput {
  stationSerials: string[];
  connectedSerials: Set<string>;
  sessionCounts: Map<string, number>;
  recordCounts: Map<string, number>;
  conflictCount: number;
  frameCount: number;
}

export function buildSummary(input: SummaryInput) {
  const online = input.stationSerials.filter((s) => input.connectedSerials.has(s)).length;
  const sessionsByStatus: Record<string, number> = {};
  for (const s of SESSION_STATUSES) sessionsByStatus[s] = input.sessionCounts.get(s) ?? 0;
  const recordsByType: Record<string, number> = {};
  for (const t of RECONCILIATION_TYPES) recordsByType[t] = input.recordCounts.get(t) ?? 0;
  return {
    stations: {
      total: input.stationSerials.length,
      online,
      offline: input.stationSerials.length - online,
    },
    sessions_by_status: sessionsByStatus,
    sessions_total: SESSION_STATUSES.reduce((n, s) => n + (sessionsByStatus[s] ?? 0), 0),
    reconciliation_by_type: recordsByType,
    reconciliation_conflicts: input.conflictCount,
    message_frames: input.frameCount,
  };
}
