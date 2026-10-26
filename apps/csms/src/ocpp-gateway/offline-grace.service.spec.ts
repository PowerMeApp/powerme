/**
 * Unit test OfflineGraceService với scheduler giả — không DB, không timer thật.
 * Phần phụ thuộc DB (epoch, quét khởi động) nằm trong test/offline-grace.integration.test.ts.
 */
import { Logger } from '@nestjs/common';
import type { CsmsConfig } from '../config.js';
import type { Db } from '../db/db.module.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { OfflineGraceService, ScheduledTask, Scheduler } from './offline-grace.service.js';

interface Timer {
  delayMs: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

class FakeScheduler implements Scheduler {
  readonly timers: Timer[] = [];
  schedule(delayMs: number, fn: () => void): ScheduledTask {
    const t: Timer = { delayMs, fn, cancelled: false, fired: false };
    this.timers.push(t);
    return {
      cancel: () => {
        t.cancelled = true;
      },
    };
  }
  /** Chạy hẹn giờ như khi hết hạn (bỏ qua cái đã huỷ). */
  fire(t: Timer | undefined): void {
    if (!t || t.cancelled) return;
    t.fired = true;
    t.fn();
  }
}

/** Epoch DB giả lập: test đổi `epochs` để mô phỏng trụ nối lại. */
class TestService extends OfflineGraceService {
  readonly epochs = new Map<number, number>();
  protected override async currentEpoch(chargePointId: number): Promise<number> {
    return this.epochs.get(chargePointId) ?? 0;
  }
}

const AT = new Date('2026-10-26T10:00:00Z');
const flush = () => new Promise<void>((r) => setImmediate(r));

function build(offlineGraceS?: number) {
  const scheduler = new FakeScheduler();
  const onStationOffline = jest.fn(async (_cp: number, _at: Date) => 1);
  const sessions = { onStationOffline } as unknown as SessionsService;
  const config = { ...(offlineGraceS === undefined ? {} : { offlineGraceS }) } as CsmsConfig;
  const service = new TestService(
    {} as Db,
    config,
    sessions,
    { get: () => undefined } as unknown as ConnectionRegistry,
    scheduler,
  );
  return { service, scheduler, onStationOffline };
}

describe('OfflineGraceService', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('ân hạn 30 s: hẹn giờ đúng 30000 ms và CHƯA orphan khi socket vừa đóng', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    service.epochs.set(7, 1);
    await service.onSocketClosed(7, 1, AT);
    expect(scheduler.timers.map((t) => t.delayMs)).toEqual([30_000]);
    expect(onStationOffline).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(1);
  });

  it('không khai báo offlineGraceS: dùng mặc định 30 s', async () => {
    const { service, scheduler } = build(undefined);
    expect(service.graceS).toBe(30);
    await service.onSocketClosed(7, 1, AT);
    expect(scheduler.timers[0]?.delayMs).toBe(30_000);
  });

  it('nối lại trong ân hạn (epoch DB 2 > 1): hết hạn KHÔNG orphan', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    service.epochs.set(7, 1);
    await service.onSocketClosed(7, 1, AT);
    service.epochs.set(7, 2); // trụ nối lại
    scheduler.fire(scheduler.timers[0]);
    await flush();
    expect(onStationOffline).not.toHaveBeenCalled();
    expect(service.pendingCount).toBe(0);
  });

  it('hết ân hạn mà không nối lại: orphan đúng một lần, với đúng chargePointId', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    service.epochs.set(7, 1);
    await service.onSocketClosed(7, 1, AT);
    const timer = scheduler.timers[0];
    scheduler.fire(timer);
    await flush();
    expect(onStationOffline).toHaveBeenCalledTimes(1);
    expect(onStationOffline.mock.calls[0]?.[0]).toBe(7);
    // Hẹn giờ đã chạy thì gỡ khỏi pending và không tự hẹn lại.
    expect(service.pendingCount).toBe(0);
    expect(scheduler.timers).toHaveLength(1);
  });

  it('ân hạn 0: orphan ngay với mốc closedAt, không hẹn giờ', async () => {
    const { service, scheduler, onStationOffline } = build(0);
    await service.onSocketClosed(7, 1, AT);
    expect(onStationOffline).toHaveBeenCalledTimes(1);
    expect(onStationOffline).toHaveBeenCalledWith(7, AT);
    expect(scheduler.timers).toHaveLength(0);
  });

  it('đóng hai lần: hẹn giờ cũ bị huỷ, chỉ còn một hẹn giờ chờ cho trụ đó', async () => {
    const { service, scheduler } = build(30);
    await service.onSocketClosed(7, 1, AT);
    await service.onSocketClosed(7, 2, AT);
    expect(scheduler.timers.map((t) => t.cancelled)).toEqual([true, false]);
    expect(service.pendingCount).toBe(1);
  });

  it('hai trụ khác nhau có hẹn giờ độc lập', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    service.epochs.set(7, 1);
    service.epochs.set(8, 1);
    await service.onSocketClosed(7, 1, AT);
    await service.onSocketClosed(8, 1, AT);
    service.epochs.set(8, 2); // chỉ trụ 8 nối lại
    scheduler.timers.forEach((t) => scheduler.fire(t));
    await flush();
    expect(onStationOffline).toHaveBeenCalledTimes(1);
    expect(onStationOffline.mock.calls[0]?.[0]).toBe(7);
  });

  it('shutdown huỷ mọi hẹn giờ đang chờ (Jest không treo open handles)', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    await service.onSocketClosed(7, 1, AT);
    await service.onSocketClosed(8, 1, AT);
    service.onApplicationShutdown();
    expect(scheduler.timers.every((t) => t.cancelled)).toBe(true);
    expect(service.pendingCount).toBe(0);
    scheduler.timers.forEach((t) => scheduler.fire(t)); // đã huỷ → không chạy
    await flush();
    expect(onStationOffline).not.toHaveBeenCalled();
  });

  it('lỗi trong lúc orphan không thành unhandled rejection (chỉ log)', async () => {
    const { service, scheduler, onStationOffline } = build(30);
    onStationOffline.mockRejectedValueOnce(new Error('db chết'));
    await service.onSocketClosed(7, 1, AT);
    scheduler.fire(scheduler.timers[0]);
    await flush();
    expect(onStationOffline).toHaveBeenCalledTimes(1);
  });
});
