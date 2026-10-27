/**
 * Scheduler — hẹn giờ một lần, thay được trong test.
 *
 * Vì sao tồn tại: hai nơi cần hẹn giờ trong tiến trình — ân hạn offline (ADR-0016 D-A,
 * `ocpp-gateway/offline-grace.service.ts`) và hạn chờ Reset của sự cố (STM-6 `resetting`,
 * `stations/faults/fault.service.ts`). `stations` không được import `ocpp-gateway` (gateway phụ
 * thuộc stations, ADR-0016 D-F), nên interface nằm ở đây cho cả hai dùng.
 *
 * ĐÍCH là job BullMQ trễ; repo chưa có Redis/BullMQ nên bản mặc định là `setTimeout`. Hẹn giờ nằm
 * trong RAM, mất khi CSMS chết — mỗi service tự quét DB lúc khởi động để dựng lại.
 */

/** Hẹn giờ một lần. `cancel()` huỷ nếu chưa chạy. */
export interface ScheduledTask {
  cancel(): void;
}

/** Điểm thay thế cho `setTimeout` (sau này: job BullMQ trễ). */
export interface Scheduler {
  schedule(delayMs: number, fn: () => void): ScheduledTask;
}

/** Scheduler mặc định: `setTimeout`, `unref` để hẹn giờ treo không giữ tiến trình sống. */
export class TimeoutScheduler implements Scheduler {
  schedule(delayMs: number, fn: () => void): ScheduledTask {
    const handle = setTimeout(fn, delayMs);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  }
}
