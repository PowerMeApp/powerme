/**
 * OfflineAlertService — cảnh báo trụ im lặng quá ngưỡng (G10, NFR-OCPP-07, Commitment NFR-06).
 *
 * Vì sao tồn tại: SRS §3.1.4 dòng 13 yêu cầu báo operator khi trụ "im lặng quá nhịp Heartbeat
 * (≤ 900 s)". #61 (FE-04) chỉ xử lý StatusNotification `Faulted`; trụ mất điện / mất SIM thì không
 * còn frame nào để báo lỗi, nên phải có bên CSMS tự phát hiện. Service này quét DB theo nhịp
 * `OFFLINE_ALERT_SWEEP_S` và gọi FaultService:
 *
 *   1. Trụ đã nói lại (`is_online` và `last_message_at > raised_at`) → resolveOffline (t3/t5/t7).
 *   2. Trụ `in_service` có `COALESCE(last_message_at, online_changed_at)` cũ hơn
 *      `now − OFFLINE_ALERT_S` → raiseOffline (t1, sự cố cả trụ, error_code `Offline`).
 *
 * Không giữ trạng thái trong RAM: mọi quyết định tính lại từ cột mà ocpp-gateway đã ghi
 * (`charge_points.last_message_at`, `is_online`), nên CSMS khởi động lại không mất cảnh báo. Không
 * import ocpp-gateway (ADR-0016 D-F: gateway phụ thuộc stations, không ngược lại).
 *
 * Khác OfflineGraceService (ADR-0016 D-A, 120 s): đó quyết định PHIÊN có bị orphan không; đây là
 * CẢNH BÁO cho operator (900 s). Hai ngưỡng độc lập.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../../common/scheduler.js';
import {
  CONFIG,
  CsmsConfig,
  DEFAULT_OFFLINE_ALERT_S,
  DEFAULT_OFFLINE_ALERT_SWEEP_S,
} from '../../config.js';
import { DB, Db } from '../../db/db.module.js';
import { chargePoints, faultEvents } from '../../db/schema/index.js';
import { OFFLINE_ERROR_CODE } from './error-code-guide.js';
import { FaultService } from './fault.service.js';

export const OFFLINE_ALERT_SCHEDULER = Symbol('OFFLINE_ALERT_SCHEDULER');

/** Kết quả một lượt quét (để test / log). */
export interface OfflineSweepResult {
  /** Sự cố Offline mới mở. */
  raised: number;
  /** Trụ im lặng nhưng đã có sự cố connector 0 đang mở (không tạo trùng). */
  attached: number;
  /** Sự cố Offline đã đóng vì trụ nói lại. */
  resolved: number;
}

@Injectable()
export class OfflineAlertService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OfflineAlertService.name);
  private readonly scheduler: Scheduler;
  private task?: ScheduledTask;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly faults: FaultService,
    @Optional() @Inject(OFFLINE_ALERT_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  /** Ngưỡng im lặng hiệu lực (giây). */
  get offlineAlertS(): number {
    return this.config.offlineAlertS ?? DEFAULT_OFFLINE_ALERT_S;
  }

  /** Nhịp quét hiệu lực (giây). */
  get sweepS(): number {
    return this.config.offlineAlertSweepS ?? DEFAULT_OFFLINE_ALERT_SWEEP_S;
  }

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.arm();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.task?.cancel();
    this.task = undefined;
  }

  /**
   * Một lượt quét. Public để test gọi thẳng với `now` giả. Lượt đang chạy thì lượt chồng lên bị bỏ
   * qua (trả toàn 0) thay vì chạy song song.
   */
  async sweep(now: Date = new Date()): Promise<OfflineSweepResult> {
    const result: OfflineSweepResult = { raised: 0, attached: 0, resolved: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      // 1) Đóng sự cố Offline của trụ đã nói lại.
      const recovered = await this.db
        .select({ faultId: faultEvents.id })
        .from(faultEvents)
        .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
        .where(
          and(
            eq(faultEvents.errorCode, OFFLINE_ERROR_CODE),
            ne(faultEvents.status, 'resolved'),
            eq(chargePoints.isOnline, true),
            gt(chargePoints.lastMessageAt, faultEvents.raisedAt),
          ),
        );
      for (const r of recovered) {
        if ((await this.faults.resolveOffline(r.faultId, now)) === 'resolved') result.resolved += 1;
      }

      // 2) Mở sự cố cho trụ in_service im lặng quá ngưỡng.
      const cutoff = new Date(now.getTime() - this.offlineAlertS * 1000);
      const silent = await this.db
        .select({ id: chargePoints.id })
        .from(chargePoints)
        .where(
          and(
            eq(chargePoints.lifecycle, 'in_service'),
            lt(
              sql`COALESCE(${chargePoints.lastMessageAt}, ${chargePoints.onlineChangedAt})`,
              cutoff,
            ),
          ),
        );
      for (const cp of silent) {
        const outcome = await this.faults.raiseOffline(cp.id, now);
        if (outcome.kind === 'raised') result.raised += 1;
        else if (outcome.kind === 'attached') result.attached += 1;
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  /** Hẹn lượt quét kế tiếp; tự hẹn lại sau mỗi lượt (lỗi chỉ ghi log, không dừng vòng quét). */
  private arm(): void {
    if (this.stopped) return;
    this.task = this.scheduler.schedule(this.sweepS * 1000, () => {
      this.sweep()
        .catch((err: unknown) => this.logger.error(`quét trụ im lặng lỗi: ${String(err)}`))
        .finally(() => this.arm());
    });
  }
}
