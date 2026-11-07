/**
 * Test tích hợp T61 (ADR-0016) — Postgres thật.
 *
 * Vì sao tồn tại: T61 đổi hai hành vi cốt lõi của gateway mà trace EXP-01 không chạm tới:
 *   D-C  kết nối tách khỏi lifecycle: socket mở/đóng chỉ đổi `is_online`; lifecycle chỉ chuyển
 *        awaiting_connection → in_service (STM-3 #3). Bốn tổ hợp (disabled/in_service × mở/đóng).
 *   D-A  ân hạn trước orphaned: socket đóng KHÔNG orphan ngay; nối lại trong ân hạn thì phiên
 *        giữ nguyên; hết ân hạn mới orphaned; sau đó LIVE_MESSAGE đưa về active (#18).
 *   (e)  quét phục hồi khi CSMS khởi động lại (hẹn giờ trong RAM đã mất).
 *
 * Đường (c)/(d) đi qua ĐÚNG OcppServer.attach (sự kiện `close` của socket giả) → registry →
 * OfflineGraceService, chỉ thay Scheduler bằng bản điều khiển tay để không chờ 30 s thật.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePointConnections,
  chargePoints,
  connectors,
  rfidCards,
  sessionStatusHistory,
  sessions,
} from '../src/db/schema/index.js';
import { ConnectionRegistry, OcppClientLike } from '../src/ocpp-gateway/connection-registry.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import {
  OfflineGraceService,
  ScheduledTask,
  Scheduler,
} from '../src/ocpp-gateway/offline-grace.service.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { ENERGY_MEASURAND, SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const GRACE_S = 30;
const CONFIG: CsmsConfig = {
  databaseUrl: DATABASE_URL ?? '',
  ocppPort: 0,
  heartbeatIntervalS: 60,
  sessionStartTimeoutS: 120,
  sessionHardCapH: 24,
  replaySkewThresholdS: 5,
  meterValueSampleIntervalS: 10,
  reconcileGapFactor: 3,
  reconcileEnergyToleranceWh: 1,
  consoleEnabled: false,
  consoleHost: '127.0.0.1',
  consolePort: 0,
  offlineGraceS: GRACE_S,
};

/** Scheduler điều khiển tay: ghi lại hẹn giờ, test tự quyết lúc nào "hết hạn". */
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
  /** Hẹn giờ chưa huỷ, mới nhất. */
  get live() {
    return this.timers.filter((t) => !t.cancelled);
  }
}

/** Socket ocpp-rpc giả: đủ cho OcppServer.attach (handshake, handle, on, call, close). */
class FakeRpcClient extends EventEmitter implements OcppClientLike {
  readonly handshake = { remoteAddress: '127.0.0.1' };
  constructor(readonly identity: string) {
    super();
  }
  handle(): void {
    /* test không phát CALL qua socket */
  }
  async call(): Promise<unknown> {
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

class StubClient implements OcppClientLike {
  constructor(readonly identity: string) {}
  async call(): Promise<unknown> {
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

describeDb('T61 — kết nối tách khỏi lifecycle (ADR-0016 D-C)', () => {
  let db: Db;

  async function insertCp(
    serial: string,
    lifecycle: 'in_service' | 'disabled' | 'awaiting_connection' | 'offline',
  ) {
    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: serial, lifecycle })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    return cp.id;
  }
  async function row(id: number) {
    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, id));
    if (!cp) throw new Error('mất charge_point');
    return cp;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('(a1) trụ disabled mở socket → vẫn disabled, is_online=true', async () => {
    const id = await insertCp('T61-DIS-1', 'disabled');
    const reg = new ConnectionRegistry(db);
    const at = new Date('2026-10-26T01:00:00Z');
    await reg.open('T61-DIS-1', new StubClient('T61-DIS-1'), { openedAt: at });
    const cp = await row(id);
    expect(cp.lifecycle).toBe('disabled');
    expect(cp.isOnline).toBe(true);
    expect(cp.onlineChangedAt).toEqual(at);
    expect(cp.lastMessageAt).toEqual(at);
  });

  it('(a2) trụ disabled đóng socket → vẫn disabled, is_online=false', async () => {
    const id = await insertCp('T61-DIS-2', 'disabled');
    const reg = new ConnectionRegistry(db);
    const client = new StubClient('T61-DIS-2');
    await reg.open('T61-DIS-2', client, { openedAt: new Date('2026-10-26T01:00:00Z') });
    const closedAt = new Date('2026-10-26T01:05:00Z');
    await reg.close(client, { code: 1006, closedAt });
    const cp = await row(id);
    expect(cp.lifecycle).toBe('disabled');
    expect(cp.isOnline).toBe(false);
    expect(cp.onlineChangedAt).toEqual(closedAt);
  });

  it('(a3) trụ in_service mở socket → giữ in_service, is_online=true', async () => {
    const id = await insertCp('T61-INS-1', 'in_service');
    const reg = new ConnectionRegistry(db);
    await reg.open('T61-INS-1', new StubClient('T61-INS-1'));
    const cp = await row(id);
    expect(cp.lifecycle).toBe('in_service');
    expect(cp.isOnline).toBe(true);
  });

  it('(a4) trụ in_service đóng socket → giữ in_service (KHÔNG còn offline), is_online=false', async () => {
    const id = await insertCp('T61-INS-2', 'in_service');
    const reg = new ConnectionRegistry(db);
    const client = new StubClient('T61-INS-2');
    await reg.open('T61-INS-2', client);
    await reg.close(client, { code: 1006 });
    const cp = await row(id);
    expect(cp.lifecycle).toBe('in_service');
    expect(cp.isOnline).toBe(false);
  });

  it('(b) trụ awaiting_connection mở socket → in_service (STM-3 #3) + online', async () => {
    const id = await insertCp('T61-AWT-1', 'awaiting_connection');
    const reg = new ConnectionRegistry(db);
    await reg.open('T61-AWT-1', new StubClient('T61-AWT-1'));
    const cp = await row(id);
    expect(cp.lifecycle).toBe('in_service');
    expect(cp.isOnline).toBe(true);
    expect(cp.currentEpoch).toBe(1);
  });

  it('trụ mang lifecycle legacy offline mở socket → in_service + online (tự chữa)', async () => {
    const id = await insertCp('T61-LEG-1', 'offline');
    const reg = new ConnectionRegistry(db);
    await reg.open('T61-LEG-1', new StubClient('T61-LEG-1'));
    const cp = await row(id);
    expect(cp.lifecycle).toBe('in_service');
    expect(cp.isOnline).toBe(true);
  });

  it('disabled: mở → đóng → mở lại giữ disabled suốt, epoch tăng 1 → 2', async () => {
    const id = await insertCp('T61-DIS-3', 'disabled');
    const reg = new ConnectionRegistry(db);
    const c1 = new StubClient('T61-DIS-3');
    await reg.open('T61-DIS-3', c1);
    await reg.close(c1, { code: 1006 });
    await reg.open('T61-DIS-3', new StubClient('T61-DIS-3'));
    const cp = await row(id);
    expect(cp.lifecycle).toBe('disabled');
    expect(cp.isOnline).toBe(true);
    expect(cp.currentEpoch).toBe(2);
  });
});

describeDb('T61 — ân hạn trước orphaned (ADR-0016 D-A) qua OcppServer thật', () => {
  let db: Db;
  let svc: SessionsService;
  let registry: ConnectionRegistry;
  let serializer: InboundSerializer;
  let scheduler: ManualScheduler;
  let grace: OfflineGraceService;
  let server: OcppServer;
  let logId = 0;

  async function setupCp(serial: string) {
    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: serial, lifecycle: 'awaiting_connection' })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    await db.insert(connectors).values([
      { chargePointId: cp.id, connectorNo: 1 },
      { chargePointId: cp.id, connectorNo: 2 },
    ]);
    return cp.id;
  }

  function ctx(serial: string, chargePointId: number, epoch: number, at: Date): InboundContext {
    return {
      identity: serial,
      chargePointId,
      epoch,
      epochOpenedAt: at,
      receivedAt: at,
      cpTimestamp: at,
      messageId: `m${++logId}`,
      messageLogId: logId,
      replay: { replayed: false, reason: null, skewS: 0 },
    };
  }

  /** Mở socket giả qua OcppServer.attach và chờ registry mở xong. */
  async function connect(serial: string): Promise<FakeRpcClient> {
    const client = new FakeRpcClient(serial);
    (server as unknown as { attach(c: FakeRpcClient): void }).attach(client);
    for (let i = 0; i < 200 && registry.get(serial)?.client !== client; i++)
      await new Promise((r) => setTimeout(r, 10));
    if (registry.get(serial)?.client !== client) throw new Error('registry không mở socket');
    await new Promise((r) => setTimeout(r, 30)); // chờ TriggerMessage c0/c1/c2 xong
    return client;
  }

  /** Socket đóng (sự kiện `close` của ocpp-rpc) rồi chờ hàng đợi identity xả hết. */
  async function drop(client: FakeRpcClient): Promise<void> {
    client.emit('close', { code: 1006, reason: 'rot mang' });
    await serializer.run(client.identity, async () => undefined);
  }

  async function sessionOf(tx: number) {
    const [s] = await db.select().from(sessions).where(eq(sessions.transactionNo, tx));
    if (!s) throw new Error(`không có tx ${tx}`);
    return s;
  }
  async function chain(tx: number): Promise<string[]> {
    const s = await sessionOf(tx);
    const rows = await db
      .select()
      .from(sessionStatusHistory)
      .where(eq(sessionStatusHistory.sessionId, s.id))
      .orderBy(asc(sessionStatusHistory.occurredAt), asc(sessionStatusHistory.id));
    return rows.map((r) => `${r.fromStatus ?? '●'} -${r.event}-> ${r.toStatus}`);
  }
  async function startSession(serial: string, cpId: number, at: Date): Promise<number> {
    const r = await svc.onStartTransaction(
      { connectorId: 1, idTag: 'T61-CARD', meterStart: 0, timestamp: at.toISOString() },
      ctx(serial, cpId, 1, at),
    );
    return r.transactionId;
  }
  async function liveMeter(serial: string, cpId: number, epoch: number, tx: number, at: Date) {
    await svc.onMeterValues(
      {
        connectorId: 1,
        transactionId: tx,
        meterValue: [
          {
            timestamp: at.toISOString(),
            sampledValue: [{ value: '50', measurand: ENERGY_MEASURAND, unit: 'Wh' }],
          },
        ],
      },
      ctx(serial, cpId, epoch, at),
    );
  }
  /** Chạy hẹn giờ ân hạn còn sống và chờ check() xong (hàng đợi microtask + DB). */
  async function expire(): Promise<void> {
    const timers = scheduler.live;
    for (const t of timers) {
      t.cancelled = true;
      t.fn();
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    await db
      .insert(rfidCards)
      .values({ cardIdentifier: 'T61-CARD', cardKind: 'online', status: 'active' });
    svc = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    registry = new ConnectionRegistry(db);
    serializer = new InboundSerializer();
    scheduler = new ManualScheduler();
    grace = new OfflineGraceService(db, CONFIG, svc, registry, scheduler);
    server = new OcppServer(
      CONFIG,
      registry,
      new OcppMessageLogger(db),
      serializer,
      new ReplayDetector(CONFIG.replaySkewThresholdS),
      new OcppHandlers(svc, CONFIG),
      svc,
      undefined,
      grace,
    );
  });
  afterAll(async () => {
    grace?.cancelAll();
    await db?.$client.end();
  });

  it('(c) socket đóng, nối lại TRONG ân hạn → phiên vẫn active, không có lịch sử orphaned', async () => {
    const serial = 'T61-GRACE-C';
    const cpId = await setupCp(serial);
    const c1 = await connect(serial);
    const tx = await startSession(serial, cpId, new Date());
    expect(await chain(tx)).toEqual(['● -START_TRANSACTION-> active']);

    await drop(c1);
    // Ngay sau khi đóng: trụ offline nhưng phiên CHƯA bị orphan; có đúng một hẹn giờ 30 000 ms.
    expect((await sessionOf(tx)).status).toBe('active');
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.delayMs).toBe(GRACE_S * 1000);
    const [offline] = await db.select().from(chargePoints).where(eq(chargePoints.id, cpId));
    expect(offline?.isOnline).toBe(false);
    expect(offline?.lifecycle).toBe('in_service');

    await connect(serial); // nối lại trong ân hạn → epoch 2
    await expire(); // hẹn giờ của epoch 1 đến hạn: thấy epoch 2 trong DB → không làm gì

    const s = await sessionOf(tx);
    expect(s.status).toBe('active');
    expect(s.orphanedAt).toBeNull();
    expect(await chain(tx)).toEqual(['● -START_TRANSACTION-> active']);
    const orphanRows = (
      await db.select().from(sessionStatusHistory).where(eq(sessionStatusHistory.sessionId, s.id))
    ).filter((r) => r.toStatus === 'orphaned');
    expect(orphanRows).toHaveLength(0);
  });

  it('(d) hết ân hạn không nối lại → orphaned (+orphaned_at, lịch sử); nối lại + LIVE_MESSAGE → active', async () => {
    const serial = 'T61-GRACE-D';
    const cpId = await setupCp(serial);
    const c1 = await connect(serial);
    const tx = await startSession(serial, cpId, new Date());

    await drop(c1);
    expect((await sessionOf(tx)).status).toBe('active');
    const before = Date.now();
    await expire(); // hết ân hạn, epoch vẫn 1
    const orphaned = await sessionOf(tx);
    expect(orphaned.status).toBe('orphaned');
    expect(orphaned.orphanedAt).not.toBeNull();
    expect(orphaned.orphanedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await chain(tx)).toEqual([
      '● -START_TRANSACTION-> active',
      'active -STATION_OFFLINE-> orphaned',
    ]);

    await connect(serial); // epoch 2: phiên vẫn orphaned cho tới khi có bản tin live
    expect((await sessionOf(tx)).status).toBe('orphaned');
    await liveMeter(serial, cpId, 2, tx, new Date());
    expect((await sessionOf(tx)).status).toBe('active');
    expect(await chain(tx)).toEqual([
      '● -START_TRANSACTION-> active',
      'active -STATION_OFFLINE-> orphaned',
      'orphaned -LIVE_MESSAGE-> active',
    ]);
  });

  it('đóng lần hai sau khi đã nối lại: hẹn giờ cũ của epoch 1 không orphan nhầm, hẹn giờ epoch 2 orphan', async () => {
    const serial = 'T61-GRACE-C2';
    const cpId = await setupCp(serial);
    const c1 = await connect(serial);
    const tx = await startSession(serial, cpId, new Date());
    await drop(c1); // hẹn giờ A (epoch 1)
    const c2 = await connect(serial); // epoch 2
    await drop(c2); // hẹn giờ B (epoch 2) — thay A
    expect(scheduler.live).toHaveLength(1);
    await expire();
    expect((await sessionOf(tx)).status).toBe('orphaned');
  });
});

describeDb('T61 — quét phục hồi khi CSMS khởi động lại (hẹn giờ RAM đã mất)', () => {
  let db: Db;
  let svc: SessionsService;
  let registry: ConnectionRegistry;
  let scheduler: ManualScheduler;
  let grace: OfflineGraceService;
  let logId = 0;
  const NOW = new Date('2026-10-26T12:00:00Z');
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

  async function seedCp(
    serial: string,
    opts: {
      isOnline: boolean;
      lastMessageAt: Date | null;
      onlineChangedAt?: Date;
      withSession: boolean;
    },
  ) {
    const [cp] = await db
      .insert(chargePoints)
      .values({
        serialNumber: serial,
        lifecycle: 'in_service',
        isOnline: opts.isOnline,
        lastMessageAt: opts.lastMessageAt,
        onlineChangedAt: opts.onlineChangedAt ?? null,
        currentEpoch: 1,
      })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    await db.insert(connectors).values({ chargePointId: cp.id, connectorNo: 1 });
    await db.insert(chargePointConnections).values({
      chargePointId: cp.id,
      epoch: 1,
      openedAt: ago(500),
      ...(opts.isOnline ? {} : { closedAt: ago(10), closeReason: '1006' }),
    });
    let tx: number | null = null;
    if (opts.withSession) {
      const r = await svc.onStartTransaction(
        { connectorId: 1, idTag: 'T61-CARD', meterStart: 0, timestamp: ago(400).toISOString() },
        {
          identity: serial,
          chargePointId: cp.id,
          epoch: 1,
          epochOpenedAt: ago(500),
          receivedAt: ago(400),
          cpTimestamp: ago(400),
          messageId: `m${++logId}`,
          messageLogId: logId,
          replay: { replayed: false, reason: null, skewS: 0 },
        },
      );
      tx = r.transactionId;
    }
    return { id: cp.id, tx };
  }
  async function status(tx: number | null) {
    if (tx === null) throw new Error('không có phiên');
    const [s] = await db.select().from(sessions).where(eq(sessions.transactionNo, tx));
    return s?.status;
  }
  async function cpRow(id: number) {
    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, id));
    if (!cp) throw new Error('mất charge_point');
    return cp;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    await db
      .insert(rfidCards)
      .values({ cardIdentifier: 'T61-CARD', cardKind: 'online', status: 'active' });
    svc = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    registry = new ConnectionRegistry(db);
    scheduler = new ManualScheduler();
    grace = new OfflineGraceService(db, CONFIG, svc, registry, scheduler);
  });
  afterAll(async () => {
    grace?.cancelAll();
    await db?.$client.end();
  });

  it('(e) quét: online đã quá ân hạn → offline + orphan ngay; còn trong ân hạn → hẹn giờ phần còn lại; đã offline giữa ân hạn → hẹn giờ; có socket / không phiên → bỏ qua', async () => {
    // A: is_online=true, im lặng 100 s (> 30 s) → offline + orphan ngay
    const a = await seedCp('SWEEP-A', {
      isOnline: true,
      lastMessageAt: ago(100),
      withSession: true,
    });
    // B: is_online=true, im lặng 5 s → còn 25 s ân hạn
    const b = await seedCp('SWEEP-B', { isOnline: true, lastMessageAt: ago(5), withSession: true });
    // C: CSMS chết giữa ân hạn: is_online=false từ 10 s trước, hẹn giờ mất → còn 20 s
    const c = await seedCp('SWEEP-C', {
      isOnline: false,
      lastMessageAt: ago(12),
      onlineChangedAt: ago(10),
      withSession: true,
    });
    // D: is_online=true nhưng registry ĐÃ có socket (nối lại sớm hơn quét) → không đụng
    const d = await seedCp('SWEEP-D', {
      isOnline: true,
      lastMessageAt: ago(100),
      withSession: true,
    });
    await registry.open('SWEEP-D', new StubClient('SWEEP-D'));
    // E: offline, không phiên nào → không có gì để orphan, không hẹn giờ
    const e = await seedCp('SWEEP-E', {
      isOnline: false,
      lastMessageAt: ago(100),
      onlineChangedAt: ago(100),
      withSession: false,
    });

    const summary = await grace.recoverAfterRestart(NOW);
    expect(summary).toEqual({ markedOffline: 2, orphanedNow: 1, scheduled: 2 });

    // A
    expect(await status(a.tx)).toBe('orphaned');
    const aRow = await cpRow(a.id);
    expect(aRow.isOnline).toBe(false);
    expect(aRow.onlineChangedAt).toEqual(NOW);
    expect(aRow.lifecycle).toBe('in_service');
    const [aConn] = await db
      .select()
      .from(chargePointConnections)
      .where(eq(chargePointConnections.chargePointId, a.id));
    expect(aConn?.closeReason).toBe('csms_restart');
    expect(aConn?.closedAt).toEqual(ago(100));

    // B, C: chưa orphan, đúng ms còn lại
    expect(await status(b.tx)).toBe('active');
    expect((await cpRow(b.id)).isOnline).toBe(false);
    expect(await status(c.tx)).toBe('active');
    expect(scheduler.live.map((t) => t.delayMs).sort((x, y) => x - y)).toEqual([20_000, 25_000]);

    // D, E nguyên vẹn
    expect(await status(d.tx)).toBe('active');
    expect((await cpRow(d.id)).isOnline).toBe(true);
    expect((await cpRow(e.id)).isOnline).toBe(false);

    // Hết hạn: B và C (không nối lại) → orphaned
    const timers = scheduler.live;
    for (const t of timers) t.fn();
    // Handler hết hạn chạy bất đồng bộ; chờ cố định 150 ms không đủ khi máy bận (đỏ 1/3 lần chạy
    // cả 32 suite, 28/10) → chờ tới khi cả hai phiên orphaned, tối đa 5 s.
    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      ((await status(b.tx)) !== 'orphaned' || (await status(c.tx)) !== 'orphaned')
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await status(b.tx)).toBe('orphaned');
    expect(await status(c.tx)).toBe('orphaned');
    expect(await status(d.tx)).toBe('active');
  });

  it('quét với ân hạn 0 orphan ngay mọi trụ không socket có phiên mở', async () => {
    const z = await seedCp('SWEEP-Z', { isOnline: true, lastMessageAt: ago(1), withSession: true });
    const zero = new OfflineGraceService(
      db,
      { ...CONFIG, offlineGraceS: 0 },
      svc,
      registry,
      new ManualScheduler(),
    );
    const summary = await zero.recoverAfterRestart(NOW);
    expect(summary.orphanedNow).toBe(1);
    expect(await status(z.tx)).toBe('orphaned');
  });

  it('onApplicationBootstrap chạy quét và không ném lỗi dù DB trống trụ nào cần xử lý', async () => {
    await expect(grace.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
