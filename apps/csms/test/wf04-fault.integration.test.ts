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
import { and, asc, eq } from 'drizzle-orm';
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
    ).rejects.toThrow(); // fault_events_one_open_per_connector_key (migration 0007)
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
