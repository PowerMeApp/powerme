/**
 * Unit test BackgroundWorkRunner (T32 Phần 12, decisions D7): hẹn giờ, chạy sớm, không chạy chồng,
 * cô lập lỗi giữa các loại việc, dừng sạch. Scheduler giả gọi tay; BackgroundWork giả không đụng DB.
 */
import { Logger } from '@nestjs/common';
import type { ScheduledTask, Scheduler } from '../common/scheduler.js';
import { TimeoutScheduler } from '../common/scheduler.js';
import { BackgroundWork, BackgroundWorkRunner } from './background-work.js';
import type { BackgroundWorkConfig } from './background-work.config.js';

interface Task {
  delayMs: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

class ManualScheduler implements Scheduler {
  readonly tasks: Task[] = [];
  schedule(delayMs: number, fn: () => void): ScheduledTask {
    const t: Task = { delayMs, fn, cancelled: false, fired: false };
    this.tasks.push(t);
    return { cancel: () => (t.cancelled = true) };
  }
  pending(): Task[] {
    return this.tasks.filter((t) => !t.cancelled && !t.fired);
  }
  /** Chạy mọi task đang chờ (không chạy task mới sinh ra trong lúc chạy). */
  fireAll(): void {
    for (const t of this.pending()) {
      t.fired = true;
      t.fn();
    }
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** Việc giả: đếm số lần gọi, số lượt chạy đồng thời tối đa; hành vi mỗi lần gọi do test đặt. */
class FakeWork implements BackgroundWork {
  calls = 0;
  active = 0;
  maxActive = 0;
  signals: AbortSignal[] = [];
  constructor(
    readonly name: string,
    private readonly behave: (call: number, limit: number) => Promise<number> = async () => 0,
  ) {}
  async runDue(limit: number, signal: AbortSignal): Promise<number> {
    this.calls++;
    this.signals.push(signal);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.behave(this.calls, limit);
    } finally {
      this.active--;
    }
  }
}

const CONFIG: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30000,
  batchSize: 5,
  leaseMs: 120000,
};

const flush = () => new Promise((r) => setImmediate(r));

describe('BackgroundWorkRunner (T32 Phần 12)', () => {
  let scheduler: ManualScheduler;
  let runner: BackgroundWorkRunner;

  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  beforeEach(() => {
    scheduler = new ManualScheduler();
    runner = new BackgroundWorkRunner(CONFIG, scheduler);
  });
  afterEach(async () => {
    await runner.beforeApplicationShutdown();
  });

  it('bootstrap quét một lần rồi hẹn vòng sau theo intervalMs', async () => {
    const w = new FakeWork('a');
    runner.register(w);
    runner.onApplicationBootstrap();
    await runner.idle();
    expect(w.calls).toBe(1);
    await flush();
    expect(scheduler.pending().map((t) => t.delayMs)).toEqual([30000]);

    scheduler.fireAll();
    await runner.idle();
    expect(w.calls).toBe(2);
    await flush();
    expect(scheduler.pending().map((t) => t.delayMs)).toEqual([30000]);
  });

  it('kick chạy sớm qua scheduler (độ trễ 0)', async () => {
    const w = new FakeWork('a');
    runner.register(w);
    runner.kick('a');
    expect(w.calls).toBe(0);
    expect(scheduler.pending().map((t) => t.delayMs)).toEqual([0]);
    scheduler.fireAll();
    await runner.idle();
    expect(w.calls).toBe(1);
  });

  it('kick trùng lúc đang chạy: không chạy chồng, chạy thêm đúng một lượt', async () => {
    const g = gate();
    const w = new FakeWork('a', async (call) => {
      if (call === 1) await g.wait;
      return 0;
    });
    runner.register(w);
    runner.kick('a');
    scheduler.fireAll();
    await flush();
    expect(w.active).toBe(1);

    runner.kick('a');
    runner.kick('a');
    scheduler.fireAll();
    await flush();
    expect(w.calls).toBe(1);

    g.open();
    await runner.idle();
    expect(w.maxActive).toBe(1);
    expect(w.calls).toBe(2);
  });

  it('kickAt hẹn theo thời điểm; thời điểm đã qua → 0', () => {
    runner.register(new FakeWork('a'));
    runner.kickAt('a', new Date(Date.now() + 5000));
    runner.kickAt('a', new Date(Date.now() - 5000));
    const [later, past] = scheduler.pending().map((t) => t.delayMs);
    expect(later).toBeGreaterThan(4500);
    expect(later).toBeLessThanOrEqual(5000);
    expect(past).toBe(0);
  });

  it('kickAt xa hơn một vòng quét thì kẹp về intervalMs', () => {
    runner.register(new FakeWork('a'));
    runner.kickAt('a', new Date(Date.now() + 3_600_000));
    expect(scheduler.pending().map((t) => t.delayMs)).toEqual([CONFIG.intervalMs]);
  });

  it('một loại ném lỗi không chặn loại khác', async () => {
    const bad = new FakeWork('bad', async () => {
      throw new Error('boom');
    });
    const good = new FakeWork('good');
    runner.register(bad);
    runner.register(good);
    await runner.sweep();
    expect(bad.calls).toBe(1);
    expect(good.calls).toBe(1);
  });

  it('các loại chạy song song: A treo thì B vẫn chạy xong', async () => {
    const g = gate();
    const slow = new FakeWork('slow', async () => {
      await g.wait;
      return 0;
    });
    let goodDone = false;
    const good = new FakeWork('good', async () => {
      goodDone = true;
      return 0;
    });
    runner.register(slow);
    runner.register(good);
    const sweeping = runner.sweep();
    await flush();
    expect(goodDone).toBe(true);
    expect(slow.active).toBe(1);
    g.open();
    await sweeping;
  });

  it('lô đầy thì chạy tiếp, tối đa 10 lô mỗi lượt; lô chưa đầy thì dừng', async () => {
    const full = new FakeWork('full', async (_c, limit) => limit);
    const partial = new FakeWork('partial', async (call, limit) => (call < 3 ? limit : limit - 1));
    runner.register(full);
    runner.register(partial);
    await runner.sweep();
    expect(full.calls).toBe(10);
    expect(partial.calls).toBe(3);
  });

  it('shutdown lúc đang treo: abort signal, chờ lượt đang chạy trả về rồi mới xong', async () => {
    const g = gate();
    const w = new FakeWork('a', async () => {
      await g.wait;
      return CONFIG.batchSize;
    });
    runner.register(w);
    runner.onApplicationBootstrap();
    await flush();
    expect(w.active).toBe(1);

    let stopped = false;
    const stopping = runner.beforeApplicationShutdown().then(() => (stopped = true));
    await flush();
    expect(w.signals[0]!.aborted).toBe(true);
    expect(stopped).toBe(false);

    g.open();
    await stopping;
    // Lô đầy nhưng đã abort → không gọi lô thứ hai.
    expect(w.calls).toBe(1);
  });

  it('shutdown huỷ mọi hẹn giờ; kick sau shutdown bị bỏ qua', async () => {
    const w = new FakeWork('a');
    runner.register(w);
    runner.onApplicationBootstrap();
    await runner.idle();
    await flush();
    runner.kickAt('a', new Date(Date.now() + 60000));
    expect(scheduler.pending()).toHaveLength(2);

    await runner.beforeApplicationShutdown();
    expect(scheduler.pending()).toHaveLength(0);
    runner.kick('a');
    expect(scheduler.pending()).toHaveLength(0);
    await runner.sweep();
    expect(w.calls).toBe(1);
  });

  it('register trùng tên thì ném; kick tên chưa đăng ký thì ném', () => {
    runner.register(new FakeWork('a'));
    expect(() => runner.register(new FakeWork('a'))).toThrow('background_work_duplicate');
    expect(() => runner.kick('nope')).toThrow('background_work_unknown');
  });

  it('enabled=false: bootstrap không quét, kick không hẹn', async () => {
    const off = new BackgroundWorkRunner({ ...CONFIG, enabled: false }, scheduler);
    const w = new FakeWork('a');
    off.register(w);
    off.onApplicationBootstrap();
    off.kick('a');
    await off.idle();
    expect(w.calls).toBe(0);
    expect(scheduler.pending()).toHaveLength(0);
    await off.beforeApplicationShutdown();
  });

  it('TimeoutScheduler thật: bootstrap rồi shutdown không để timer treo', async () => {
    const real = new BackgroundWorkRunner(CONFIG, new TimeoutScheduler());
    const w = new FakeWork('a');
    real.register(w);
    real.onApplicationBootstrap();
    real.kickAt('a', new Date(Date.now() + 3_600_000));
    await real.idle();
    await real.beforeApplicationShutdown();
    expect(w.calls).toBe(1);
  });

  it('mặc định dùng TimeoutScheduler khi không inject', async () => {
    const dflt = new BackgroundWorkRunner(CONFIG);
    const w = new FakeWork('a');
    dflt.register(w);
    dflt.kick('a');
    await new Promise((r) => setTimeout(r, 10));
    await dflt.idle();
    await dflt.beforeApplicationShutdown();
    expect(w.calls).toBe(1);
  });
});
