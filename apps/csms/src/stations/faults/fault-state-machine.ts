/**
 * FaultStateMachine — STM-6 FaultEvent (cảnh báo cho operator), lớp THUẦN (không DB, không Nest).
 *
 * Vì sao tồn tại: STM-6 v0.2 (`diagrams/stm/STM-6_FaultEvent.puml`, 24/10/2026) chốt 4 trạng thái
 * của `fault_events.status` và 7 chuyển; tên trigger lấy đúng từ sơ đồ. Đây là nơi DUY NHẤT biết
 * bảng chuyển; `FaultService` chỉ gọi `apply()` rồi ghi xuống DB — giống SessionStateMachine của
 * STM-1, để test từng chuyển mà không cần Postgres (fault-state-machine.spec.ts).
 *
 * t1 (● → raised) là tạo mới, không phải một dòng của bảng: `initial()`. `SIGNAL` tới khi đã có sự
 * cố mở trên cùng connector là no-op (bất biến "một FaultEvent mở cho mỗi connector") — tín hiệu
 * được gắn vào sự cố đang mở chứ không tạo sự cố mới. `resolved` là trạng thái cuối: tín hiệu sau
 * đó tạo một FaultEvent MỚI (FaultService), máy trạng thái từ chối mọi trigger trên `resolved`.
 *
 * Bộ 4 × 6 = 24 cặp (trạng thái, trigger): 7 hợp lệ · 3 no-op (SIGNAL khi đang mở) · 14 bị từ chối.
 */

export const FAULT_STATUSES = ['raised', 'acknowledged', 'resetting', 'resolved'] as const;
export type FaultStatus = (typeof FAULT_STATUSES)[number];

export const FAULT_TRIGGERS = [
  /** Tín hiệu lỗi: StatusNotification Faulted, tài xế báo lỗi, trụ offline quá hạn (t1). */
  'SIGNAL',
  /** Operator xác nhận đã thấy cảnh báo (t2, UC-OPS-03). */
  'ACKNOWLEDGE',
  /** Operator gửi Reset từ xa, bắt đầu hẹn giờ chờ (t4, UC-OPS-04). */
  'RESET_SENT',
  /** Trụ từ chối Reset, lỗi gửi lệnh, hoặc hết hạn chờ mà súng chưa về Available (t6). */
  'RESET_FAILED',
  /** Súng báo Available (t3, t5, t7). */
  'CONNECTOR_AVAILABLE',
  /** Operator đóng sự cố sau khi kiểm tra tại chỗ (t7). */
  'OPERATOR_CLOSE',
] as const;
export type FaultTrigger = (typeof FAULT_TRIGGERS)[number];

export interface FaultTransition {
  /** Số chuyển trong STM-6 (t2…t7). */
  no: string;
  from: FaultStatus;
  trigger: FaultTrigger;
  to: FaultStatus;
}

/** 7 dòng — t7 có hai trigger. */
export const FAULT_TRANSITIONS: readonly FaultTransition[] = [
  { no: 't2', from: 'raised', trigger: 'ACKNOWLEDGE', to: 'acknowledged' },
  { no: 't3', from: 'raised', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't4', from: 'acknowledged', trigger: 'RESET_SENT', to: 'resetting' },
  { no: 't5', from: 'resetting', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't6', from: 'resetting', trigger: 'RESET_FAILED', to: 'acknowledged' },
  { no: 't7', from: 'acknowledged', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't7', from: 'acknowledged', trigger: 'OPERATOR_CLOSE', to: 'resolved' },
];

export class InvalidFaultTransitionError extends Error {
  constructor(
    readonly from: FaultStatus,
    readonly trigger: FaultTrigger,
  ) {
    super(`Chuyển trạng thái sự cố không hợp lệ: ${from} --${trigger}--> ? (không có trong STM-6)`);
    this.name = 'InvalidFaultTransitionError';
  }
}

/** Kết quả `apply`: trạng thái đích, và `noop` khi SIGNAL gắn vào sự cố đang mở. */
export interface FaultStep {
  to: FaultStatus;
  noop: boolean;
  /** Số chuyển STM-6; null khi no-op. */
  no: string | null;
}

export class FaultStateMachine {
  private readonly table = new Map<string, FaultTransition>();

  constructor() {
    for (const t of FAULT_TRANSITIONS) this.table.set(FaultStateMachine.key(t.from, t.trigger), t);
  }

  private static key(from: FaultStatus, trigger: FaultTrigger): string {
    return `${from}|${trigger}`;
  }

  /** t1: tín hiệu đầu tiên khi connector chưa có sự cố mở. */
  initial(): FaultStatus {
    return 'raised';
  }

  isOpen(status: FaultStatus): boolean {
    return status !== 'resolved';
  }

  canApply(from: FaultStatus, trigger: FaultTrigger): boolean {
    if (trigger === 'SIGNAL') return this.isOpen(from);
    return this.table.has(FaultStateMachine.key(from, trigger));
  }

  /** Bước kế tiếp; ném InvalidFaultTransitionError cho mọi cặp không có trong STM-6. */
  apply(from: FaultStatus, trigger: FaultTrigger): FaultStep {
    if (trigger === 'SIGNAL' && this.isOpen(from)) return { to: from, noop: true, no: null };
    const t = this.table.get(FaultStateMachine.key(from, trigger));
    if (!t) throw new InvalidFaultTransitionError(from, trigger);
    return { to: t.to, noop: false, no: t.no };
  }
}
