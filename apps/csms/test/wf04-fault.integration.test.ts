/**
 * Test tích hợp WF-04 "xử lý lỗi trụ" (FE-04, STM-6) — Postgres thật.
 *
 * Vì sao tồn tại: chứng minh sự cố đi đúng vòng đời STM-6 khi frame OCPP đi qua ĐÚNG đường xử lý
 * của gateway (`OcppServer.processCall` → OcppHandlers → SessionsService + FaultService), và khi
 * operator thao tác qua HTTP thật của console (acknowledge / reset / close). Mã IT-xx khớp bảng
 * trong docs/ITERATION-1-WF04.md mục 5.
 *
 * Trụ là client giả: test quyết định trụ trả lời Reset thế nào (Accepted / Rejected / lỗi) và tự
 * gửi các frame "sau khi khởi động lại". Hẹn giờ chờ Reset dùng Scheduler điều khiển tay
 * (giống test T61) để không chờ 120 s thật.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ScheduledTask, Scheduler } from '../src/common/scheduler.js';
import type { CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePoints,
  connectors,
  connectorStatusEvents,
  faultEvents,
  ocppMessageLog,
  remoteCommands,
  sessions,
} from '../src/db/schema/index.js';
import {
  Connection,
  ConnectionRegistry,
  OcppClientLike,
} from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { ENERGY_MEASURAND, SessionsService } from '../src/sessions/sessions.service.js';
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'WF04-D1-0001';
const OFFLINE_CP = 'WF04-D1-OFF';
const RESET_TIMEOUT_S = 120;

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
  consoleEnabled: true,
  consoleHost: '127.0.0.1',
  consolePort: 0,
  faultResetTimeoutS: RESET_TIMEOUT_S,
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
  get live() {
    return this.timers.filter((t) => !t.cancelled);
  }
}

/** Trụ giả: câu trả lời cho Reset do test đặt trước. */
class ScriptedPillar implements OcppClientLike {
  readonly calls: { method: string; params: unknown }[] = [];
  resetReply: { status: string } | Error = { status: 'Accepted' };
  constructor(readonly identity: string) {}
  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method !== 'Reset') return { status: 'Accepted' };
    if (this.resetReply instanceof Error) throw this.resetReply;
    return this.resetReply;
  }
  async close(): Promise<void> {
    return undefined;
  }
}

interface FaultJson {
  id: number;
  station: string;
  connector_no: number | null;
  error_code: string | null;
  severity: string;
  status: string;
  reset_command_status: string | null;
}

describeDb('WF-04 — sự cố trụ, cảnh báo và Reset từ xa (STM-6, FE-04)', () => {
  let db: Db;
  let server: OcppServer;
  let serializer: InboundSerializer;
  let faults: FaultService;
  let scheduler: ManualScheduler;
  let consoleServer: ConsoleServer;
  let pillar: ScriptedPillar;
  let conn: Connection;
  let cpId: number;
  let base: string;
  let clock = Date.parse('2026-10-27T08:00:00Z');
  let msg = 0;

  /** Đồng hồ giả tăng dần: mỗi frame cách nhau 1 s, test có thể nhảy xa hơn. */
  function tick(seconds = 1): Date {
    clock += seconds * 1000;
    return new Date(clock);
  }

  async function send(action: string, params: Record<string, unknown>, at = tick()) {
    msg += 1;
    return serializer.run(CP, () =>
      server.processCall(conn, { messageId: `wf04-${msg}`, action, params }, at),
    );
  }

  async function status(connectorId: number, st: string, errorCode = 'NoError') {
    const at = tick();
    await send(
      'StatusNotification',
      {
        connectorId,
        errorCode,
        status: st,
        timestamp: at.toISOString(),
      },
      at,
    );
  }

  async function post<T>(p: string): Promise<{ status: number; body: T }> {
    const res = await fetch(base + p, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as T };
  }
  async function getFaults(filter: 'open' | 'all' = 'all'): Promise<FaultJson[]> {
    const res = await fetch(`${base}/api/admin/faults?status=${filter}`);
    return (await res.json()) as FaultJson[];
  }

  async function faultRows() {
    return db.select().from(faultEvents).orderBy(asc(faultEvents.id));
  }
  async function onlyFault() {
    const rows = await faultRows();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function connectorStatus(no: number) {
    const [row] = await db
      .select({ status: connectors.status })
      .from(connectors)
      .where(and(eq(connectors.chargePointId, cpId), eq(connectors.connectorNo, no)));
    return row?.status;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);

    const inserted = await db
      .insert(chargePoints)
      .values([
        { serialNumber: CP, model: 'D1-120', lifecycle: 'awaiting_connection' },
        { serialNumber: OFFLINE_CP, model: 'D1-120', lifecycle: 'in_service' },
      ])
      .returning({ id: chargePoints.id });
    cpId = inserted[0]!.id;
    const offId = inserted[1]!.id;
    await db.insert(connectors).values([
      { chargePointId: cpId, connectorNo: 1 },
      { chargePointId: cpId, connectorNo: 2 },
      { chargePointId: offId, connectorNo: 1 },
    ]);

    const sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    scheduler = new ManualScheduler();
    faults = new FaultService(db, CONFIG, scheduler);
    serializer = new InboundSerializer();
    const registry = new ConnectionRegistry(db);
    server = new OcppServer(
      CONFIG,
      registry,
      new OcppMessageLogger(db),
      serializer,
      new ReplayDetector(CONFIG.replaySkewThresholdS),
      new OcppHandlers(sessionsService, CONFIG, faults),
      sessionsService,
    );
    pillar = new ScriptedPillar(CP);
    conn = await registry.open(CP, pillar, { openedAt: new Date(clock) });

    consoleServer = new ConsoleServer(
      CONFIG,
      new ConsoleQueries(db, CONFIG, registry),
      new ConsoleCommands(db, registry, faults),
    );
    await consoleServer.start();
    base = `http://127.0.0.1:${String(consoleServer.port)}`;

    await send('BootNotification', { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' });
    await status(1, 'Available');
    await status(2, 'Available');
  });

  afterAll(async () => {
    faults?.cancelAll();
    await consoleServer?.stop();
    await db?.$client.end();
  });

  beforeEach(async () => {
    // Mỗi test bắt đầu khi không còn sự cố nào và hai súng Available (qua đường thật của trụ).
    faults.cancelAll();
    scheduler.timers.length = 0;
    pillar.resetReply = { status: 'Accepted' };
    pillar.calls.length = 0;
    await db.delete(faultEvents);
    await db.delete(remoteCommands);
    for (const c of [1, 2])
      if ((await connectorStatus(c)) !== 'Available') await status(c, 'Available');
  });

  it('IT-1a: lỗi giữa phiên — Faulted rồi StopTransaction(Other): sự cố raised, phiên đóng và đối soát', async () => {
    const start = tick();
    const { transactionId } = (await send(
      'StartTransaction',
      { connectorId: 1, idTag: 'WF04TAG', meterStart: 0, timestamp: start.toISOString() },
      start,
    )) as { transactionId: number };
    await status(1, 'Charging');
    for (const wh of [2500, 5000]) {
      const at = tick(9);
      await send(
        'MeterValues',
        {
          connectorId: 1,
          transactionId,
          meterValue: [
            {
              timestamp: at.toISOString(),
              sampledValue: [{ value: String(wh), measurand: ENERGY_MEASURAND, unit: 'Wh' }],
            },
          ],
        },
        at,
      );
    }
    await status(1, 'Faulted', 'GroundFailure');
    const stopAt = tick();
    await send(
      'StopTransaction',
      { transactionId, meterStop: 5000, timestamp: stopAt.toISOString(), reason: 'Other' },
      stopAt,
    );

    const fault = await onlyFault();
    expect(fault).toMatchObject({
      source: 'ocpp',
      errorCode: 'GroundFailure',
      status: 'raised',
      connectorId: expect.any(Number),
    });
    const [s] = await db.select().from(sessions).where(eq(sessions.transactionNo, transactionId));
    expect(s).toMatchObject({ status: 'reconciled', stopReason: 'Other', meterStopWh: 5000 });
    expect(await connectorStatus(1)).toBe('Faulted');
    const [flag] = await db
      .select({ unexpected: connectorStatusEvents.unexpectedTransition })
      .from(connectorStatusEvents)
      .where(
        and(
          eq(connectorStatusEvents.chargePointId, cpId),
          eq(connectorStatusEvents.status, 'Faulted'),
        ),
      );
    expect(flag?.unexpected).toBe(false); // STM-2 t14 Charging → Faulted là chuyển hợp lệ
  });

  it('IT-1b: thứ tự của simulator — StopTransaction(Other) TRƯỚC Faulted: cùng kết quả', async () => {
    const start = tick();
    const { transactionId } = (await send(
      'StartTransaction',
      { connectorId: 2, idTag: 'WF04TAG', meterStart: 100, timestamp: start.toISOString() },
      start,
    )) as { transactionId: number };
    await status(2, 'Charging');
    const stopAt = tick(5);
    await send(
      'StopTransaction',
      { transactionId, meterStop: 100, timestamp: stopAt.toISOString(), reason: 'Other' },
      stopAt,
    );
    await status(2, 'Faulted', 'HighTemperature');

    const fault = await onlyFault();
    expect(fault).toMatchObject({ errorCode: 'HighTemperature', status: 'raised' });
    const [s] = await db.select().from(sessions).where(eq(sessions.transactionNo, transactionId));
    expect(s?.stopReason).toBe('Other');
    expect(s?.status).not.toBe('active');
  });

  it('IT-2: Faulted lặp lại (kể cả mã khác) → vẫn một sự cố, giữ mã đầu tiên; DB chặn sự cố mở thứ hai', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    await status(1, 'Faulted', 'GroundFailure');
    await status(1, 'Faulted', 'OverCurrentFailure');
    const fault = await onlyFault();
    expect(fault.errorCode).toBe('GroundFailure');

    await expect(
      db.insert(faultEvents).values({
        chargePointId: cpId,
        connectorId: fault.connectorId,
        source: 'operator',
        status: 'raised',
      }),
    ).rejects.toThrow(); // fault_events_one_open_per_connector_key (migration 0008)
  });

  it('IT-2b: Faulted trên hai súng → hai sự cố độc lập', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    await status(2, 'Faulted', 'ReaderFailure');
    expect((await faultRows()).map((f) => f.errorCode)).toEqual(['GroundFailure', 'ReaderFailure']);
  });

  it('IT-3: lỗi tự hết — Faulted → Available, không ai xử lý: resolved qua t3', async () => {
    await status(1, 'Faulted', 'EVCommunicationError');
    await status(1, 'Available');
    const fault = await onlyFault();
    expect(fault.status).toBe('resolved');
    expect(fault.acknowledgedAt).toBeNull();
    expect(fault.resolvedAt).not.toBeNull();
  });

  it('IT-4: Faulted → Unavailable → Available: chưa resolved ở Unavailable, resolved ở Available', async () => {
    await status(1, 'Faulted', 'InternalError');
    await status(1, 'Unavailable');
    expect((await onlyFault()).status).toBe('raised');
    await status(1, 'Available');
    expect((await onlyFault()).status).toBe('resolved');
    const flagged = await db
      .select()
      .from(connectorStatusEvents)
      .where(eq(connectorStatusEvents.unexpectedTransition, true));
    expect(flagged).toHaveLength(0);
  });

  it('IT-5: acknowledge qua console rồi Available → resolved qua t7', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    const r = await post<{ status: string }>(`/api/admin/faults/${id}/acknowledge`);
    expect(r).toEqual({ status: 200, body: { id, status: 'acknowledged' } });
    expect((await onlyFault()).acknowledgedAt).not.toBeNull();
    await status(1, 'Available');
    expect((await onlyFault()).status).toBe('resolved');
  });

  it('IT-6: Reset Accepted → resetting; trụ khởi động lại → Unavailable → Available: resolved qua t5', async () => {
    await status(1, 'Faulted', 'InternalError');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);
    const r = await post<{ reset_status: string; fault_status: string; command_id: number }>(
      `/api/admin/faults/${id}/reset?type=Hard`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reset_status: 'Accepted', fault_status: 'resetting' });
    expect(pillar.calls).toEqual([{ method: 'Reset', params: { type: 'Hard' } }]);
    const [cmd] = await db
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, r.body.command_id));
    expect(cmd).toMatchObject({ action: 'Reset', status: 'accepted', payload: { type: 'Hard' } });
    expect(cmd?.sentAt).not.toBeNull();
    expect(cmd?.respondedAt).not.toBeNull();
    expect((await onlyFault()).resetCommandId).toBe(r.body.command_id);
    expect(scheduler.live).toHaveLength(1);
    expect(scheduler.live[0]?.delayMs).toBe(RESET_TIMEOUT_S * 1000);

    await send('BootNotification', { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' });
    await status(1, 'Unavailable');
    expect((await onlyFault()).status).toBe('resetting');
    await status(1, 'Available');
    expect((await onlyFault()).status).toBe('resolved');
    expect(scheduler.live).toHaveLength(0); // hẹn giờ đã huỷ
    expect((await getFaults('all'))[0]).toMatchObject({
      status: 'resolved',
      reset_command_status: 'accepted',
    });
  });

  it('IT-7: Reset bị trụ từ chối → acknowledged (t6), lệnh rejected; Reset lại được', async () => {
    await status(1, 'Faulted', 'ConnectorLockFailure');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);
    pillar.resetReply = { status: 'Rejected' };
    const r = await post<{ reset_status: string; fault_status: string; command_id: number }>(
      `/api/admin/faults/${id}/reset`,
    );
    expect(r.body).toMatchObject({ reset_status: 'Rejected', fault_status: 'acknowledged' });
    const [cmd] = await db
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, r.body.command_id));
    expect(cmd?.status).toBe('rejected');
    expect(scheduler.live).toHaveLength(0);

    pillar.resetReply = { status: 'Accepted' };
    const again = await post<{ fault_status: string }>(`/api/admin/faults/${id}/reset`);
    expect(again.body.fault_status).toBe('resetting');
  });

  it('IT-7b: trụ không trả lời Reset hợp lệ → 502, lệnh failed, sự cố về acknowledged', async () => {
    await status(1, 'Faulted', 'InternalError');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);
    pillar.resetReply = new Error('timeout');
    const r = await post<{ error: string }>(`/api/admin/faults/${id}/reset`);
    expect(r).toMatchObject({ status: 502, body: { error: 'station_error' } });
    const [cmd] = await db.select().from(remoteCommands);
    expect(cmd).toMatchObject({ status: 'failed' });
    expect((await onlyFault()).status).toBe('acknowledged');
  });

  it('IT-8: Reset Accepted nhưng súng vẫn Faulted tới hết hạn chờ → acknowledged (t6); kết quả tới muộn không đổi gì', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);
    const r = await post<{ command_id: number }>(`/api/admin/faults/${id}/reset`);
    // Trụ khởi động lại nhưng lỗi chưa hết (giống simulator D1: c.fault sống qua reboot).
    await send('BootNotification', { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' });
    await status(1, 'Faulted', 'GroundFailure');
    expect((await onlyFault()).status).toBe('resetting');

    // Hết hạn chờ: gọi đúng callback mà FaultService đã hẹn.
    scheduler.live[0]?.fn();
    await new Promise((r2) => setTimeout(r2, 200));
    expect((await onlyFault()).status).toBe('acknowledged');
    const [cmd] = await db
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, r.body.command_id));
    expect(cmd?.status).toBe('accepted'); // trụ đã nhận lệnh — chỉ sự cố quay về

    // Gọi lại hết hạn cho lệnh cũ → không làm gì.
    expect(await faults.onResetTimeout(id, r.body.command_id)).toBe('noop');
  });

  it('IT-8b: hết hạn khi lệnh còn chưa có kết quả → lệnh timeout', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    await faults.acknowledge(id, null);
    const begun = await faults.beginReset(id, { type: 'Soft', requestedBy: null });
    await faults.markSent(begun.commandId);
    expect(await faults.onResetTimeout(id, begun.commandId)).toBe('timed_out');
    const [cmd] = await db.select().from(remoteCommands);
    expect(cmd?.status).toBe('timeout');
    expect((await onlyFault()).status).toBe('acknowledged');
  });

  it('IT-9: đóng sau khi kiểm tra tại chỗ → resolved (t7); đóng lần hai → 409; súng vẫn Faulted', async () => {
    await status(2, 'Faulted', 'PowerSwitchFailure');
    const id = (await onlyFault()).id;
    expect((await post(`/api/admin/faults/${id}/close`)).status).toBe(409); // chưa acknowledged
    await post(`/api/admin/faults/${id}/acknowledge`);
    const r = await post<{ status: string }>(`/api/admin/faults/${id}/close`);
    expect(r).toEqual({ status: 200, body: { id, status: 'resolved' } });
    expect((await post<{ error: string }>(`/api/admin/faults/${id}/close`)).body.error).toBe(
      'invalid_transition',
    );
    expect(await connectorStatus(2)).toBe('Faulted');
  });

  it('IT-10: Faulted trên connector 0 = cả trụ: connector_id null; Available của c1 không đóng, của c0 thì đóng', async () => {
    await status(0, 'Faulted', 'UnderVoltage');
    const fault = await onlyFault();
    expect(fault.connectorId).toBeNull();
    expect((await getFaults('open'))[0]).toMatchObject({ connector_no: 0, severity: 'major' });
    await status(1, 'Available');
    expect((await onlyFault()).status).toBe('raised');
    await status(0, 'Available');
    expect((await onlyFault()).status).toBe('resolved');
  });

  it('IT-11: lỗi lại sau khi resolved → sự cố MỚI với event_no kế tiếp', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    await status(1, 'Available');
    await status(1, 'Faulted', 'GroundFailure');
    const rows = await faultRows();
    expect(rows.map((f) => f.status)).toEqual(['resolved', 'raised']);
    expect(rows[1]!.eventNo).toBeGreaterThan(rows[0]!.eventNo);
  });

  it('console: Reset khi chưa acknowledged → 409, khi trụ offline → 409, không có sự cố → 404; không ghi lệnh nào', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    expect((await post<{ error: string }>(`/api/admin/faults/${id}/reset`)).body.error).toBe(
      'fault_not_acknowledged',
    );
    expect((await post(`/api/admin/faults/999999/acknowledge`)).status).toBe(404);

    const [off] = await db
      .select({ id: chargePoints.id })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, OFFLINE_CP));
    const [offConn] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.chargePointId, off!.id));
    const [offFault] = await db
      .insert(faultEvents)
      .values({
        chargePointId: off!.id,
        connectorId: offConn!.id,
        source: 'ocpp',
        status: 'acknowledged',
      })
      .returning({ id: faultEvents.id });
    const r = await post<{ error: string }>(`/api/admin/faults/${offFault!.id}/reset`);
    expect(r).toMatchObject({ status: 409, body: { error: 'station_offline' } });
    expect(await db.select().from(remoteCommands)).toHaveLength(0);
    expect(pillar.calls).toHaveLength(0);
  });

  it('console: danh sách mặc định chỉ sự cố mở, nặng trước; ?status=all có cả resolved', async () => {
    await status(1, 'Faulted', 'ReaderFailure');
    await status(2, 'Faulted', 'GroundFailure');
    await status(1, 'Available');
    const open = await getFaults('open');
    expect(open.map((f) => [f.station, f.error_code, f.severity])).toEqual([
      [CP, 'GroundFailure', 'critical'],
    ]);
    const all = await getFaults('all');
    expect(all.map((f) => f.status)).toEqual(['raised', 'resolved']);
  });

  it('IT-12: lỗi tự hết rồi tài xế cắm sạc luôn — Faulted → Preparing → Charging cũng đóng sự cố (t3, t7); Unavailable thì chưa', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    await status(1, 'Preparing');
    expect((await onlyFault()).status).toBe('resolved'); // t3, không qua Available
    await status(1, 'Charging');
    expect(await faultRows()).toHaveLength(1); // Charging sau đó không tạo/đụng sự cố nào

    await db.delete(faultEvents);
    await status(2, 'Faulted', 'GroundFailure');
    await post(`/api/admin/faults/${(await onlyFault()).id}/acknowledge`);
    await status(2, 'Unavailable');
    expect((await onlyFault()).status).toBe('acknowledged');
    await status(2, 'Charging');
    expect((await onlyFault()).status).toBe('resolved'); // t7
    await status(1, 'Available');
    await status(2, 'Available');
  });

  it('IT-13: Reset khi súng khác đang sạc → 409 sessions_active, không ghi lệnh; force=true thì gửi và ghi payload.force; phiên trên chính súng lỗi không chặn', async () => {
    async function startOn(connectorId: number): Promise<number> {
      const at = tick();
      const r = (await send(
        'StartTransaction',
        { connectorId, idTag: 'WF04TAG', meterStart: 0, timestamp: at.toISOString() },
        at,
      )) as { transactionId: number };
      await status(connectorId, 'Charging');
      return r.transactionId;
    }
    async function stop(transactionId: number) {
      const at = tick();
      await send(
        'StopTransaction',
        { transactionId, meterStop: 0, timestamp: at.toISOString(), reason: 'Local' },
        at,
      );
    }

    const tx2 = await startOn(2);
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);

    const refused = await post<{ error: string; detail: string }>(`/api/admin/faults/${id}/reset`);
    expect(refused).toMatchObject({ status: 409, body: { error: 'sessions_active' } });
    expect(refused.body.detail).toContain('súng 2');
    expect(await db.select().from(remoteCommands)).toHaveLength(0);
    expect(pillar.calls).toHaveLength(0);
    expect((await onlyFault()).status).toBe('acknowledged');

    const forced = await post<{ forced: boolean; fault_status: string; command_id: number }>(
      `/api/admin/faults/${id}/reset?force=true`,
    );
    expect(forced.body).toMatchObject({ forced: true, fault_status: 'resetting' });
    const [cmd] = await db
      .select({ payload: remoteCommands.payload })
      .from(remoteCommands)
      .where(eq(remoteCommands.id, forced.body.command_id));
    expect(cmd!.payload).toEqual({ type: 'Soft', force: true });
    await stop(tx2);

    // Phiên trên chính súng lỗi (AD-7: Faulted tới trước StopTransaction) không chặn Reset.
    faults.cancelAll();
    await db.delete(faultEvents);
    await db.delete(remoteCommands);
    await status(1, 'Available');
    const tx1 = await startOn(1);
    await status(1, 'Faulted', 'GroundFailure');
    const own = (await onlyFault()).id;
    await post(`/api/admin/faults/${own}/acknowledge`);
    const ok = await post<{ forced: boolean; fault_status: string }>(
      `/api/admin/faults/${own}/reset`,
    );
    expect(ok).toMatchObject({ status: 200, body: { forced: false, fault_status: 'resetting' } });
    await stop(tx1);
  });

  it('IT-14: bản phát lại giữ giờ trụ — Faulted 10:05 và Available 10:07 tới lúc 10:35 → raised_at 10:05, resolved_at 10:07; frame live vẫn dùng received_at', async () => {
    const receivedAt = tick(1800);
    const faultedAt = new Date(receivedAt.getTime() - 30 * 60_000);
    const availableAt = new Date(faultedAt.getTime() + 2 * 60_000);
    const frames = [
      ['Faulted', 'GroundFailure', faultedAt, receivedAt],
      ['Available', 'NoError', availableAt, tick()],
    ] as const;
    for (const [st, code, cp, rx] of frames) {
      await send(
        'StatusNotification',
        { connectorId: 1, errorCode: code, status: st, timestamp: cp.toISOString() },
        rx,
      );
    }
    const replayed = await onlyFault();
    expect(replayed.raisedAt.toISOString()).toBe(faultedAt.toISOString());
    expect(replayed.resolvedAt!.toISOString()).toBe(availableAt.toISOString());

    await db.delete(faultEvents);
    const liveAt = tick();
    await send(
      'StatusNotification',
      {
        connectorId: 1,
        errorCode: 'GroundFailure',
        status: 'Faulted',
        timestamp: liveAt.toISOString(),
      },
      liveAt,
    );
    expect((await onlyFault()).raisedAt.toISOString()).toBe(liveAt.toISOString());
    await status(1, 'Available');
  });

  it('IT-15: danh sách sắp theo mức nặng TRƯỚC khi cắt limit — 25 lỗi nhẹ mới hơn không đẩy lỗi nghiêm trọng cũ ra khỏi ?limit=20', async () => {
    // 13 trụ × 2 súng = 26 súng, mỗi súng một sự cố mở (bất biến một sự cố mở mỗi súng).
    const pillars = await db
      .insert(chargePoints)
      .values(
        Array.from({ length: 13 }, (_, i) => ({
          serialNumber: `RH24D1-WF04-L${String(i).padStart(2, '0')}`,
          model: 'D1-120',
          lifecycle: 'in_service' as const,
        })),
      )
      .returning({ id: chargePoints.id });
    const conns = await db
      .insert(connectors)
      .values(
        pillars.flatMap((p) => [1, 2].map((connectorNo) => ({ chargePointId: p.id, connectorNo }))),
      )
      .returning({ id: connectors.id, chargePointId: connectors.chargePointId });
    const t0 = Date.parse('2026-10-27T06:00:00Z');
    await db.insert(faultEvents).values(
      conns.map((c, i) => ({
        chargePointId: c.chargePointId,
        connectorId: c.id,
        source: 'ocpp' as const,
        errorCode: i === 0 ? 'GroundFailure' : 'WeakSignal',
        status: 'raised' as const,
        raisedAt: new Date(t0 + i * 60_000), // GroundFailure là cũ nhất
      })),
    );
    const res = await fetch(`${base}/api/admin/faults?limit=20`);
    const list = (await res.json()) as FaultJson[];
    expect(list).toHaveLength(20);
    expect(list[0]).toMatchObject({ error_code: 'GroundFailure', severity: 'critical' });
    expect(list.slice(1).every((f) => f.severity === 'minor')).toBe(true);

    await db.delete(faultEvents);
    const ids = pillars.map((p) => p.id);
    await db.delete(connectors).where(inArray(connectors.chargePointId, ids));
    await db.delete(chargePoints).where(inArray(chargePoints.id, ids));
  });

  it('IT-16: bản phát lại cũ không đóng sự cố live và không mở lại sự cố đã đóng', async () => {
    // Faulted live mở sự cố; sau đó Charging phát lại từ TRƯỚC lúc lỗi (hàng đợi offline) tới.
    await status(1, 'Faulted', 'GroundFailure');
    const fault = await onlyFault();
    const old = new Date(fault.raisedAt.getTime() - 10 * 60_000);
    const rx = tick();
    await send(
      'StatusNotification',
      { connectorId: 1, errorCode: 'NoError', status: 'Charging', timestamp: old.toISOString() },
      rx,
    );
    expect((await onlyFault()).status).toBe('raised');

    // Súng hồi phục thật (live) → resolved; rồi Faulted phát lại từ trước lúc đóng → không mở lại.
    await status(1, 'Available');
    const closed = await onlyFault();
    expect(closed.status).toBe('resolved');
    const before = new Date(closed.resolvedAt!.getTime() - 60_000);
    await send(
      'StatusNotification',
      {
        connectorId: 1,
        errorCode: 'GroundFailure',
        status: 'Faulted',
        timestamp: before.toISOString(),
      },
      tick(),
    );
    expect(await faultRows()).toHaveLength(1);
    await status(1, 'Available');
  });

  it('IT-17: đồng hồ trụ sai — giờ trụ ở tương lai hoặc quá 30 ngày trước → ghi theo received_at', async () => {
    const rx1 = tick();
    await faults.onConnectorStatus({
      chargePointId: cpId,
      connectorNo: 1,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      receivedAt: rx1,
      occurredAt: new Date('1970-01-01T00:00:00Z'),
    });
    expect((await onlyFault()).raisedAt.toISOString()).toBe(rx1.toISOString());
    const rx2 = tick();
    await faults.onConnectorStatus({
      chargePointId: cpId,
      connectorNo: 1,
      status: 'Available',
      errorCode: 'NoError',
      receivedAt: rx2,
      occurredAt: new Date(rx2.getTime() + 3 * 3600_000),
    });
    expect((await onlyFault()).resolvedAt!.toISOString()).toBe(rx2.toISOString());
  });

  it('IT-18: Reset khi súng khác có phiên orphaned / pending → 409; khi sự cố khác của trụ đang resetting → 409 reset_in_progress', async () => {
    const at = tick();
    const { transactionId } = (await send(
      'StartTransaction',
      { connectorId: 2, idTag: 'WF04TAG', meterStart: 0, timestamp: at.toISOString() },
      at,
    )) as { transactionId: number };
    await status(1, 'Faulted', 'GroundFailure');
    const id = (await onlyFault()).id;
    await post(`/api/admin/faults/${id}/acknowledge`);
    for (const st of ['orphaned', 'pending'] as const) {
      await db
        .update(sessions)
        .set({ status: st })
        .where(eq(sessions.transactionNo, transactionId));
      const r = await post<{ error: string }>(`/api/admin/faults/${id}/reset`);
      expect(r).toMatchObject({ status: 409, body: { error: 'sessions_active' } });
    }
    await db
      .update(sessions)
      .set({ status: 'active' })
      .where(eq(sessions.transactionNo, transactionId));
    const stopAt = tick();
    await send(
      'StopTransaction',
      { transactionId, meterStop: 0, timestamp: stopAt.toISOString(), reason: 'Local' },
      stopAt,
    );
    expect(await db.select().from(remoteCommands)).toHaveLength(0);

    await status(2, 'Faulted', 'GroundFailure');
    const second = (await faultRows()).find((f) => f.id !== id)!.id;
    await post(`/api/admin/faults/${second}/acknowledge`);
    expect((await post(`/api/admin/faults/${id}/reset`)).status).toBe(200); // c1 → resetting
    const r = await post<{ error: string }>(`/api/admin/faults/${second}/reset`);
    expect(r).toMatchObject({ status: 409, body: { error: 'reset_in_progress' } });
    expect(pillar.calls.filter((c) => c.method === 'Reset')).toHaveLength(1);
  });

  it('khởi động lại CSMS: sự cố resetting quá hạn → acknowledged; còn trong hạn → hẹn giờ phần còn lại', async () => {
    await status(1, 'Faulted', 'GroundFailure');
    await status(2, 'Faulted', 'GroundFailure');
    const [f1, f2] = await faultRows();
    const t0 = new Date(clock);
    for (const f of [f1!, f2!]) await faults.acknowledge(f.id, null, t0);
    await faults.beginReset(f1!.id, {
      type: 'Soft',
      requestedBy: null,
      at: new Date(clock - 200_000),
    });
    await faults.beginReset(f2!.id, {
      type: 'Soft',
      requestedBy: null,
      at: new Date(clock - 30_000),
    });

    // "CSMS mới": FaultService khác, hẹn giờ trong RAM của bản cũ coi như mất.
    const sched2 = new ManualScheduler();
    const fresh = new FaultService(db, CONFIG, sched2);
    const summary = await fresh.recoverAfterRestart(new Date(clock));
    expect(summary).toEqual({ timedOut: 1, scheduled: 1 });
    expect(sched2.live.map((t) => t.delayMs)).toEqual([(RESET_TIMEOUT_S - 30) * 1000]);
    const rows = await faultRows();
    expect(rows.map((f) => f.status)).toEqual(['acknowledged', 'resetting']);
    fresh.cancelAll();
  });

  it('mọi frame của test nằm trong ocpp_message_log, kể cả CALL chiều vào của StatusNotification', async () => {
    const logged = await db
      .select({ action: ocppMessageLog.action })
      .from(ocppMessageLog)
      .where(eq(ocppMessageLog.chargePointId, cpId));
    expect(logged.filter((l) => l.action === 'StatusNotification').length).toBeGreaterThan(20);
  });
});
