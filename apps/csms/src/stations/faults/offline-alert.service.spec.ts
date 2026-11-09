/**
 * Unit test vòng hẹn giờ của OfflineAlertService (G10) — không cần DB: `sweep` được thay bằng spy,
 * chỉ kiểm nhịp quét, tự hẹn lại sau lỗi và dừng khi tắt ứng dụng. Hành vi trên DB nằm ở
 * test/wf04-offline.integration.test.ts.
 */
import { Logger } from '@nestjs/common';
import type { ScheduledTask, Scheduler } from '../../common/scheduler.js';
import type { CsmsConfig } from '../../config.js';
import type { Db } from '../../db/db.module.js';
import type { FaultService } from './fault.service.js';
import { OfflineAlertService } from './offline-alert.service.js';

class ManualScheduler implements Scheduler {
  readonly timers: { delayMs: number; fn: () => void; cancelled: boolean }[] = [];
  schedule(delayMs: number, fn: () => void): ScheduledTask {
    const t = { delayMs, fn, cancelled: false };
    this.timers.push(t);
    return {
      cancel: () => {
        t.cancelled = true;
      },
    };
  }
  get live() {
    return this.timers.filter((t) => !t.cancelled);
  }
}

const flush = () => new Promise((r) => setImmediate(r));

function build(config: Partial<CsmsConfig> = {}) {
  const scheduler = new ManualScheduler();
  const service = new OfflineAlertService(
    {} as Db,
    { offlineAlertS: 900, offlineAlertSweepS: 60, ...config } as CsmsConfig,
    {} as FaultService,
    scheduler,
  );
  const sweep = jest
    .spyOn(service, 'sweep')
    .mockResolvedValue({ raised: 0, attached: 0, resolved: 0 });
  return { service, scheduler, sweep };
}

describe('OfflineAlertService — vòng quét (G10)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('khởi động thì hẹn lượt quét đầu sau OFFLINE_ALERT_SWEEP_S', () => {
    const { service, scheduler } = build();
    service.onApplicationBootstrap();
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]!.delayMs).toBe(60_000);
  });

  it('mỗi lượt quét xong thì tự hẹn lượt kế tiếp', async () => {
    const { service, scheduler, sweep } = build({ offlineAlertSweepS: 5 });
    service.onApplicationBootstrap();
    scheduler.live[0]!.fn();
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(scheduler.timers).toHaveLength(2);
    expect(scheduler.timers[1]!.delayMs).toBe(5_000);
  });

  it('lượt quét lỗi không làm dừng vòng quét', async () => {
    const { service, scheduler, sweep } = build();
    sweep.mockRejectedValueOnce(new Error('db down'));
    service.onApplicationBootstrap();
    scheduler.live[0]!.fn();
    await flush();
    expect(scheduler.timers).toHaveLength(2);
  });

  it('tắt ứng dụng thì huỷ hẹn giờ và không hẹn thêm', async () => {
    const { service, scheduler } = build();
    service.onApplicationBootstrap();
    const first = scheduler.timers[0]!;
    service.onApplicationShutdown();
    expect(scheduler.live).toHaveLength(0);
    first.fn(); // lượt đã lên lịch vẫn có thể chạy nốt
    await flush();
    expect(scheduler.live).toHaveLength(0);
  });

  it('ngưỡng mặc định 900 s / 60 s khi config không khai báo', () => {
    const service = new OfflineAlertService(
      {} as Db,
      {} as CsmsConfig,
      {} as FaultService,
      new ManualScheduler(),
    );
    expect(service.offlineAlertS).toBe(900);
    expect(service.sweepS).toBe(60);
  });
});
