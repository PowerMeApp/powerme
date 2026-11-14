/**
 * Việc nền của billing chạy bằng quét DB (decisions D7, T32 Phần 12).
 *
 * Vì sao tồn tại: refund (Phần 9), e-invoice / điều chỉnh (Phần 7) và timeout top-up (Phần 8) cùng cần
 * một chỗ quét lúc khởi động, quét định kỳ, chạy sớm sau commit và dừng sạch. DB là nguồn sự thật
 * (`status` + `next_attempt_at`, cả `top_ups` từ 0021); hẹn giờ trong RAM chỉ để đánh thức,
 * mất khi sập cũng được vì vòng quét bắt lại.
 *
 * Hợp đồng:
 * - Mỗi loại việc cài `BackgroundWork.runDue(limit, signal)`: tự lấy việc đến hạn, tự quản transaction,
 *   **không giữ transaction qua lời gọi bên ngoài**. Bảng có `next_attempt_at` dùng `due-rows.ts`
 *   (giữ chỗ có hạn); `top_ups` cũng vậy (`top-up-timeout`, T32 Phần 8).
 * - Service đăng ký bằng `register(this)` trong `onModuleInit`; sau commit gọi `kick(name)`, hoặc
 *   `kickAt(name, at)` để chạy đúng một thời điểm (vd. `expires_at + 2 phút`, D4). Điều kiện đến hạn dùng
 *   `now()` của DB, nên đánh thức sớm cũng không sai.
 * - Không chạy chồng trong một tiến trình: mỗi loại có cờ đang chạy riêng; kick tới lúc đang chạy thì
 *   chạy thêm một lượt ngay sau đó. Giữa các tiến trình thì `FOR UPDATE SKIP LOCKED` + lease lo.
 * - Các loại chạy song song: một loại chậm hay lỗi không làm trễ loại khác.
 *
 * Sau này đổi sang BullMQ: thay runner này; các `BackgroundWork` và service giữ nguyên.
 */
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../common/scheduler.js';
import { BACKGROUND_WORK_CONFIG, BackgroundWorkConfig } from './background-work.config.js';

export interface BackgroundWork {
  /** Tên duy nhất, dùng cho `kick` và log (vd. `refund-send`, `e-invoice-issue`, `top-up-timeout`). */
  readonly name: string;
  /**
   * Xử lý tối đa `limit` việc đến hạn; trả số việc đã xử lý (kể cả việc lỗi). Trả `limit` nghĩa là có
   * thể còn việc, runner gọi tiếp. `signal.aborted` (đang shutdown) → làm xong việc đang làm rồi trả về.
   */
  runDue(limit: number, signal: AbortSignal): Promise<number>;
}

export const BILLING_WORK_SCHEDULER = Symbol('BILLING_WORK_SCHEDULER');

/** Số lô tối đa một loại chạy trong một lượt, để vòng quét không bị một loại giữ mãi. */
const MAX_BATCHES_PER_RUN = 10;

interface Entry {
  work: BackgroundWork;
  running: Promise<void> | null;
  again: boolean;
}

@Injectable()
export class BackgroundWorkRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundWorkRunner.name);
  private readonly scheduler: Scheduler;
  private readonly entries = new Map<string, Entry>();
  private readonly tasks = new Set<ScheduledTask>();
  private readonly abort = new AbortController();
  private sweeping: Promise<void> | null = null;

  constructor(
    @Inject(BACKGROUND_WORK_CONFIG) private readonly config: BackgroundWorkConfig,
    @Optional() @Inject(BILLING_WORK_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  register(work: BackgroundWork): void {
    if (this.entries.has(work.name)) throw new Error(`background_work_duplicate: ${work.name}`);
    this.entries.set(work.name, { work, running: null, again: false });
  }

  /** Chạy sớm một loại việc (gọi sau commit). Không chờ. */
  kick(name: string): void {
    this.kickAfter(name, 0);
  }

  /**
   * Đánh thức một loại việc vào thời điểm `at` (đồng hồ JS; đến hạn hay chưa do DB quyết). Độ trễ kẹp vào
   * [0, intervalMs]: xa hơn một vòng quét thì vòng quét bắt được, không cần giữ timer dài.
   */
  kickAt(name: string, at: Date): void {
    const delay = Math.min(Math.max(0, at.getTime() - Date.now()), this.config.intervalMs);
    this.kickAfter(name, delay);
  }

  /** Một vòng quét: mọi loại chạy song song, lỗi của loại này không chặn loại kia. */
  async sweep(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((name) => this.run(name)));
  }

  /** Chờ vòng quét và mọi lượt đang chạy (dùng trong test). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [this.sweeping, ...[...this.entries.values()].map((e) => e.running)].filter(
        (p): p is Promise<void> => p !== null,
      );
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled || this.stopped) return;
    // Không chờ: một lô refund có thể mất vài phút, không được chặn ứng dụng khởi động.
    this.sweepThenReschedule();
  }

  /**
   * Chạy trước `DbModule.onApplicationShutdown` (đóng pool): huỷ hẹn giờ, báo dừng, chờ các lượt đang
   * chạy trả về. Mỗi loại chỉ làm xong việc đang làm, không làm hết lô.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    for (const t of this.tasks) t.cancel();
    this.tasks.clear();
    await this.idle();
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private sweepThenReschedule(): void {
    const p = this.sweep().finally(() => {
      if (this.sweeping === p) this.sweeping = null;
      if (!this.stopped) this.later(this.config.intervalMs, () => this.sweepThenReschedule());
    });
    this.sweeping = p;
  }

  private kickAfter(name: string, delayMs: number): void {
    if (!this.entries.has(name)) throw new Error(`background_work_unknown: ${name}`);
    if (!this.config.enabled || this.stopped) return;
    this.later(delayMs, () => void this.run(name));
  }

  private later(delayMs: number, fn: () => void): void {
    const task: ScheduledTask = this.scheduler.schedule(delayMs, () => {
      this.tasks.delete(task);
      fn();
    });
    this.tasks.add(task);
  }

  private run(name: string): Promise<void> {
    const entry = this.entries.get(name)!;
    if (this.stopped) return Promise.resolve();
    if (entry.running) {
      entry.again = true;
      return entry.running;
    }
    const p = (async () => {
      try {
        do {
          entry.again = false;
          await this.drain(entry.work);
        } while (entry.again && !this.stopped);
      } finally {
        entry.running = null;
      }
    })();
    entry.running = p;
    return p;
  }

  private async drain(work: BackgroundWork): Promise<void> {
    const limit = this.config.batchSize;
    for (let i = 0; i < MAX_BATCHES_PER_RUN && !this.stopped; i++) {
      let handled: number;
      try {
        handled = await work.runDue(limit, this.abort.signal);
      } catch (err) {
        this.logger.error(
          `D7 background work "${work.name}" failed; due rows stay in DB and will be retried: ${String(err)}`,
        );
        return;
      }
      if (handled < limit) return;
    }
  }
}
