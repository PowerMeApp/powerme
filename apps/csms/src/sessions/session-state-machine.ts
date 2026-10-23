/**
 * SessionStateMachine — STM-1 ChargingSession, lớp THUẦN (không DB, không Nest runtime).
 *
 * Vì sao tồn tại: T13 (docs/XAC-NHAN-STATE-MACHINE-T13.md mục 1.2) chốt 9 trạng thái và 22
 * chuyển cho `sessions.status`. Đây là nơi DUY NHẤT biết bảng chuyển; `SessionsService` chỉ
 * gọi `apply()` rồi ghi kết quả xuống DB. Tách thuần để test từng chuyển mà không cần Postgres
 * (22 test hợp lệ + các test chuyển bị từ chối, xem session-state-machine.spec.ts).
 *
 * Số thứ tự `no` trong TRANSITIONS là số dòng của bảng T13 mục 1.2 — giữ nguyên để hội đồng dò
 * được từng dòng. 16a có hai trigger (conflict hoặc hard cap) nên là hai dòng cùng số.
 *
 * Guard của #19 (chưa có CreditTransaction trừ tiền) do SessionsService kiểm trước khi gọi —
 * máy trạng thái không đọc DB.
 */

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
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Trạng thái khởi đầu ● (chưa có dòng trong `sessions`). */
export const INITIAL = null;

export type SessionEvent =
  /** RemoteStartTransaction được trụ Accepted (#1) */
  | 'REMOTE_START_ACCEPTED'
  /** StartTransaction tới (#2 không có pending khớp, #3 có pending khớp) */
  | 'START_TRANSACTION'
  /** Hết SESSION_START_TIMEOUT_S mà chưa có StartTransaction (#4) */
  | 'START_TIMEOUT'
  /** StatusNotification SuspendedEV / SuspendedEVSE (#5) */
  | 'STATUS_SUSPENDED'
  /** StatusNotification Charging sau khi tạm dừng (#6) */
  | 'STATUS_CHARGING'
  /** Điều kiện dừng: hạn mức, credit, driver bấm Stop → gửi RemoteStop (#7, #8) */
  | 'STOP_REQUESTED'
  /** RemoteStopTransaction.conf trả Rejected (#9a) */
  | 'REMOTE_STOP_REJECTED'
  /** StopTransaction tới (#9, #10, #11) */
  | 'STOP_TRANSACTION'
  /** Đối soát nhất quán (#12, #16) */
  | 'RECONCILE_OK'
  /** Đối soát phát hiện conflict (#12a, #16a) */
  | 'RECONCILE_CONFLICT'
  /** Trụ chuyển offline — socket đóng hoặc 900 s im lặng (#13, #14, #15) */
  | 'STATION_OFFLINE'
  /** orphaned quá SESSION_HARD_CAP_H mà không có StopTransaction (#16a) */
  | 'HARD_CAP_EXCEEDED'
  /** Operator giải quyết review (#17) */
  | 'OPERATOR_RESOLVED'
  /** Bản tin live (không phải phát lại) của chính phiên tới sau khi nối lại (#18) */
  | 'LIVE_MESSAGE'
  /** Mẫu phát lại đến muộn làm đổi kết luận đối soát, chưa trừ tiền (#19) */
  | 'LATE_SAMPLE_CONFLICT';

export interface Transition {
  /** Số dòng trong bảng T13 mục 1.2. */
  no: string;
  from: SessionStatus | typeof INITIAL;
  event: SessionEvent;
  to: SessionStatus;
}

/** Bảng chuyển — đúng 22 chuyển của T13 mục 1.2 (16a liệt kê hai trigger). */
export const TRANSITIONS: readonly Transition[] = [
  { no: '1', from: INITIAL, event: 'REMOTE_START_ACCEPTED', to: 'pending' },
  { no: '2', from: INITIAL, event: 'START_TRANSACTION', to: 'active' },
  { no: '3', from: 'pending', event: 'START_TRANSACTION', to: 'active' },
  { no: '4', from: 'pending', event: 'START_TIMEOUT', to: 'failed' },
  { no: '5', from: 'active', event: 'STATUS_SUSPENDED', to: 'paused' },
  { no: '6', from: 'paused', event: 'STATUS_CHARGING', to: 'active' },
  { no: '7', from: 'active', event: 'STOP_REQUESTED', to: 'stopping' },
  { no: '8', from: 'paused', event: 'STOP_REQUESTED', to: 'stopping' },
  { no: '9a', from: 'stopping', event: 'REMOTE_STOP_REJECTED', to: 'active' },
  { no: '9', from: 'stopping', event: 'STOP_TRANSACTION', to: 'closed' },
  { no: '10', from: 'active', event: 'STOP_TRANSACTION', to: 'closed' },
  { no: '11', from: 'paused', event: 'STOP_TRANSACTION', to: 'closed' },
  { no: '12', from: 'closed', event: 'RECONCILE_OK', to: 'reconciled' },
  { no: '12a', from: 'closed', event: 'RECONCILE_CONFLICT', to: 'review' },
  { no: '13', from: 'active', event: 'STATION_OFFLINE', to: 'orphaned' },
  { no: '14', from: 'paused', event: 'STATION_OFFLINE', to: 'orphaned' },
  { no: '15', from: 'stopping', event: 'STATION_OFFLINE', to: 'orphaned' },
  { no: '16', from: 'orphaned', event: 'RECONCILE_OK', to: 'reconciled' },
  { no: '16a', from: 'orphaned', event: 'RECONCILE_CONFLICT', to: 'review' },
  { no: '16a', from: 'orphaned', event: 'HARD_CAP_EXCEEDED', to: 'review' },
  { no: '17', from: 'review', event: 'OPERATOR_RESOLVED', to: 'reconciled' },
  { no: '18', from: 'orphaned', event: 'LIVE_MESSAGE', to: 'active' },
  { no: '19', from: 'reconciled', event: 'LATE_SAMPLE_CONFLICT', to: 'review' },
];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionStatus | typeof INITIAL,
    readonly event: SessionEvent,
  ) {
    super(
      `Chuyển trạng thái phiên không hợp lệ: ${from ?? '●'} --${event}--> ? (không có trong T13 mục 1.2)`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export class SessionStateMachine {
  private readonly table = new Map<string, Transition>();

  constructor() {
    for (const t of TRANSITIONS) this.table.set(SessionStateMachine.key(t.from, t.event), t);
  }

  private static key(from: SessionStatus | typeof INITIAL, event: SessionEvent): string {
    return `${from ?? '●'}|${event}`;
  }

  /** Chuyển khớp (from, event), hoặc undefined nếu không có trong bảng. */
  find(from: SessionStatus | typeof INITIAL, event: SessionEvent): Transition | undefined {
    return this.table.get(SessionStateMachine.key(from, event));
  }

  canApply(from: SessionStatus | typeof INITIAL, event: SessionEvent): boolean {
    return this.find(from, event) !== undefined;
  }

  /** Trạng thái đích; ném InvalidTransitionError cho mọi cặp không có trong bảng. */
  apply(from: SessionStatus | typeof INITIAL, event: SessionEvent): SessionStatus {
    const t = this.find(from, event);
    if (!t) throw new InvalidTransitionError(from, event);
    return t.to;
  }

  /** `failed` là trạng thái cuối tuyệt đối; `reconciled` còn quay lại `review` qua #19. */
  isTerminal(status: SessionStatus): boolean {
    return status === 'failed';
  }
}
