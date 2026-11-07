/**
 * OfflineGraceService — thời gian ân hạn trước khi phiên bị kéo sang `orphaned` (ADR-0016 D-A,
 * STM-1 v0.5).
 *
 * Quy tắc: socket của trụ đóng KHÔNG orphan ngay. Service hẹn giờ `OFFLINE_GRACE_S`; đến hạn mà
 * trụ vẫn CHƯA có epoch mới thì mới gọi `SessionsService.onStationOffline` (#13–#15: active /
 * paused / stopping → orphaned). Trụ nối lại trong ân hạn thì không làm gì — phiên giữ nguyên
 * trạng thái. `OFFLINE_GRACE_S = 0` = hành vi cũ (orphan ngay).
 *
 * Hẹn giờ qua interface {@link Scheduler} (thay được trong test). ĐÍCH của ADR-0016 là job BullMQ
 * trễ, nhưng repo chưa có Redis/BullMQ nên Iteration này dùng `setTimeout` trong tiến trình.
 * Hệ quả: hẹn giờ nằm trong RAM, mất khi CSMS chết (đúng ca EXP-01). Vì vậy:
 *   - "đã nối lại chưa" luôn quyết bằng DB (`charge_points.current_epoch` so với epoch của socket
 *     vừa đóng), KHÔNG bằng RAM;
 *   - `onApplicationBootstrap` quét DB để dựng lại các hẹn giờ đã mất (xem {@link recoverAfterRestart}).
 *
 * Giới hạn đã biết: nếu trụ nối lại đúng lúc hẹn giờ chạy (epoch mới chưa commit) thì phiên bị
 * orphan rồi quay lại `active` ngay khi có bản tin live (#18) — kết quả cuối vẫn đúng.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { and, eq, exists, inArray, isNull, or } from 'drizzle-orm';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../common/scheduler.js';
import { CONFIG, CsmsConfig, DEFAULT_OFFLINE_GRACE_S } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import { chargePointConnections, chargePoints, sessions } from '../db/schema/index.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ConnectionRegistry } from './connection-registry.js';

// Interface hẹn giờ chuyển sang common/ (FE-04 dùng chung); export lại để code/test T61 không đổi.
export type { ScheduledTask, Scheduler } from '../common/scheduler.js';
export { TimeoutScheduler } from '../common/scheduler.js';

export const OFFLINE_GRACE_SCHEDULER = Symbol('OFFLINE_GRACE_SCHEDULER');

/** Kết quả một lần kiểm tra khi hết ân hạn. */
export type GraceOutcome = 'orphaned' | 'reconnected';

export interface RecoverySummary {
  /** Trụ is_online=true trong DB nhưng không có socket → đã đánh dấu offline. */
  markedOffline: number;
  /** Trụ đã quá ân hạn → orphan ngay lúc khởi động. */
  orphanedNow: number;
  /** Trụ còn trong ân hạn → đã hẹn giờ cho phần còn lại. */
  scheduled: number;
}

@Injectable()
export class OfflineGraceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OfflineGraceService.name);
  private readonly pending = new Map<number, ScheduledTask>();
  private readonly scheduler: Scheduler;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly sessions: SessionsService,
    private readonly registry: ConnectionRegistry,
    @Optional() @Inject(OFFLINE_GRACE_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  /** Ân hạn hiệu lực (giây). Không khai báo trong config = mặc định. */
  get graceS(): number {
    return this.config.offlineGraceS ?? DEFAULT_OFFLINE_GRACE_S;
  }

  /** Số hẹn giờ đang chờ (để test / quan sát). */
  get pendingCount(): number {
    return this.pending.size;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const s = await this.recoverAfterRestart();
      if (s.markedOffline + s.orphanedNow + s.scheduled > 0)
        this.logger.warn(
          `khởi động: ${s.markedOffline} trụ còn is_online → offline, ${s.orphanedNow} orphan ngay, ${s.scheduled} hẹn giờ ân hạn`,
        );
    } catch (err) {
      // Không chặn CSMS khởi động vì quét lỗi; trụ nối lại sẽ tự sửa is_online.
      this.logger.error(`quét phục hồi sau khởi động lỗi: ${String(err)}`);
    }
  }

  onApplicationShutdown(): void {
    this.cancelAll();
  }

  /** Huỷ mọi hẹn giờ (Jest không treo "open handles"). */
  cancelAll(): void {
    for (const task of this.pending.values()) task.cancel();
    this.pending.clear();
  }

  /**
   * Socket của trụ vừa đóng (epoch E). Ân hạn > 0 → hẹn giờ kiểm tra; ân hạn 0 → orphan ngay.
   * Trả về sau khi hẹn giờ (không chờ hết ân hạn).
   */
  async onSocketClosed(chargePointId: number, epoch: number, closedAt: Date): Promise<void> {
    const graceMs = this.graceS * 1000;
    if (graceMs <= 0) {
      await this.sessions.onStationOffline(chargePointId, closedAt);
      return;
    }
    this.scheduleCheck(chargePointId, epoch, graceMs);
  }

  /**
   * Hết ân hạn: trụ chưa có epoch mới (so với DB) → orphan; đã nối lại → không làm gì.
   * Public để test gọi thẳng, và để sweep khởi động dùng cho trụ đã quá hạn.
   */
  async check(chargePointId: number, epoch: number, at: Date = new Date()): Promise<GraceOutcome> {
    const current = await this.currentEpoch(chargePointId);
    if (current > epoch) {
      this.logger.log(
        `trụ ${chargePointId} đã nối lại (epoch ${current} > ${epoch}) trong ân hạn — giữ nguyên phiên`,
      );
      return 'reconnected';
    }
    await this.sessions.onStationOffline(chargePointId, at);
    return 'orphaned';
  }

  /**
   * Phục hồi sau khi tiến trình khởi động lại. Hẹn giờ trong RAM đã mất, nên quét DB:
   * trụ không có socket nào trong registry mà (a) `is_online = true` HOẶC (b) còn phiên
   * active/paused/stopping (CSMS chết giữa ân hạn: is_online đã false nhưng hẹn giờ mất).
   *   1. (a) → đánh dấu offline (is_online=false, đóng dòng connection còn mở: `csms_restart`).
   *   2. Mốc ân hạn = last_message_at (đang online) hoặc online_changed_at (đã offline), thiếu thì now.
   *   3. Đã quá ân hạn (hoặc ân hạn 0) → orphan ngay; chưa quá → hẹn giờ cho phần còn lại.
   * Update có điều kiện `current_epoch = E` để không đè trụ vừa nối lại trong lúc quét.
   */
  async recoverAfterRestart(now: Date = new Date()): Promise<RecoverySummary> {
    const summary: RecoverySummary = { markedOffline: 0, orphanedNow: 0, scheduled: 0 };
    const rows = await this.db
      .select({
        id: chargePoints.id,
        serial: chargePoints.serialNumber,
        epoch: chargePoints.currentEpoch,
        isOnline: chargePoints.isOnline,
        lastMessageAt: chargePoints.lastMessageAt,
        onlineChangedAt: chargePoints.onlineChangedAt,
      })
      .from(chargePoints)
      .where(
        or(
          eq(chargePoints.isOnline, true),
          exists(
            this.db
              .select({ one: sessions.id })
              .from(sessions)
              .where(
                and(
                  eq(sessions.chargePointId, chargePoints.id),
                  inArray(sessions.status, ['active', 'paused', 'stopping']),
                ),
              ),
          ),
        ),
      );

    const graceMs = this.graceS * 1000;
    for (const cp of rows) {
      if (this.registry.get(cp.serial)) continue; // đã có socket thật (nối lại sớm hơn quét)

      if (cp.isOnline) {
        const marked = await this.db
          .update(chargePoints)
          .set({ isOnline: false, onlineChangedAt: now, updatedAt: now })
          .where(
            and(
              eq(chargePoints.id, cp.id),
              eq(chargePoints.currentEpoch, cp.epoch),
              eq(chargePoints.isOnline, true),
            ),
          )
          .returning({ id: chargePoints.id });
        if (marked.length === 0) continue; // vừa nối lại
        summary.markedOffline += 1;
        await this.db
          .update(chargePointConnections)
          .set({ closedAt: cp.lastMessageAt ?? now, closeReason: 'csms_restart' })
          .where(
            and(
              eq(chargePointConnections.chargePointId, cp.id),
              eq(chargePointConnections.epoch, cp.epoch),
              isNull(chargePointConnections.closedAt),
            ),
          );
      }

      const since =
        (cp.isOnline ? cp.lastMessageAt : cp.onlineChangedAt) ?? cp.lastMessageAt ?? now;
      const remainingMs = graceMs - (now.getTime() - since.getTime());
      if (remainingMs <= 0) {
        if ((await this.check(cp.id, cp.epoch, now)) === 'orphaned') summary.orphanedNow += 1;
      } else {
        this.scheduleCheck(cp.id, cp.epoch, remainingMs);
        summary.scheduled += 1;
      }
    }
    return summary;
  }

  /** Epoch hiện hành của trụ theo DB. Tách ra để test unit thay được. */
  protected async currentEpoch(chargePointId: number): Promise<number> {
    const [row] = await this.db
      .select({ epoch: chargePoints.currentEpoch })
      .from(chargePoints)
      .where(eq(chargePoints.id, chargePointId))
      .limit(1);
    return row?.epoch ?? 0;
  }

  private scheduleCheck(chargePointId: number, epoch: number, delayMs: number): void {
    this.pending.get(chargePointId)?.cancel();
    let task: ScheduledTask | undefined;
    task = this.scheduler.schedule(delayMs, () => {
      // Chỉ xoá nếu vẫn là hẹn giờ của chính nó (một lần đóng mới có thể đã thay).
      if (task && this.pending.get(chargePointId) === task) this.pending.delete(chargePointId);
      this.check(chargePointId, epoch).catch((err: unknown) =>
        this.logger.error(`kiểm tra ân hạn trụ ${chargePointId} lỗi: ${String(err)}`),
      );
    });
    this.pending.set(chargePointId, task);
  }
}
