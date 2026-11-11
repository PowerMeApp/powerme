/**
 * FaultStateMachine — STM-6 FaultEvent (cảnh báo cho operator), lớp THUẦN (không DB, không Nest).
 *
 * Vì sao tồn tại: STM-6 v0.2 (24/10/2026) chốt 4 trạng thái của `fault_events.status` và 7 chuyển;
 * tên trigger lấy đúng từ bản đó. Bản vẽ lại v1.0 (`diagrams/report4/state/STM-6/STM-6.puml`,
 * 01/11/2026) giữ 4 trạng thái nhưng ghi trigger bằng lời. Đây là nơi DUY NHẤT biết
 * bảng chuyển; `FaultService` chỉ gọi `apply()` rồi ghi xuống DB — giống SessionStateMachine của
 * STM-1, để test từng chuyển mà không cần Postgres (fault-state-machine.spec.ts).
 *
 * t1 (● → raised) là tạo mới, không phải một dòng của bảng: `initial()`. `SIGNAL` tới khi đã có sự
 * cố mở trên cùng connector là no-op (bất biến "một FaultEvent mở cho mỗi connector") — tín hiệu
 * được gắn vào sự cố đang mở chứ không tạo sự cố mới. `resolved` là trạng thái cuối: tín hiệu sau
 * đó tạo một FaultEvent MỚI (FaultService), máy trạng thái từ chối mọi trigger trên `resolved`.
 *
 * t8 (FE-17, ADR-0019): BR-P42 — nhãn "reported issue" xoá khi một phiên trên súng đó hoàn tất bình
 * thường, nên sự cố `driver_report` đóng bằng `SESSION_COMPLETED` từ raised / acknowledged. FaultService
 * chỉ áp trigger này cho sự cố `driver_report`.
 *
 * Bộ 4 × 7 = 28 cặp (trạng thái, trigger): 9 hợp lệ · 3 no-op (SIGNAL khi đang mở) · 16 bị từ chối.
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
  /** Một phiên trên súng hoàn tất bình thường — chỉ cho sự cố driver_report (t8, BR-P42). */
  'SESSION_COMPLETED',
] as const;
export type FaultTrigger = (typeof FAULT_TRIGGERS)[number];

export interface FaultTransition {
  /** Số chuyển trong STM-6 (t2…t8). */
  no: string;
  from: FaultStatus;
  trigger: FaultTrigger;
  to: FaultStatus;
}

/** 9 dòng — t7 có hai trigger, t8 có hai trạng thái nguồn. */
export const FAULT_TRANSITIONS: readonly FaultTransition[] = [
  { no: 't2', from: 'raised', trigger: 'ACKNOWLEDGE', to: 'acknowledged' },
  { no: 't3', from: 'raised', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't4', from: 'acknowledged', trigger: 'RESET_SENT', to: 'resetting' },
  { no: 't5', from: 'resetting', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't6', from: 'resetting', trigger: 'RESET_FAILED', to: 'acknowledged' },
  { no: 't7', from: 'acknowledged', trigger: 'CONNECTOR_AVAILABLE', to: 'resolved' },
  { no: 't7', from: 'acknowledged', trigger: 'OPERATOR_CLOSE', to: 'resolved' },
  { no: 't8', from: 'raised', trigger: 'SESSION_COMPLETED', to: 'resolved' },
  { no: 't8', from: 'acknowledged', trigger: 'SESSION_COMPLETED', to: 'resolved' },
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
