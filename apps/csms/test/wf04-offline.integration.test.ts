/**
 * Test tích hợp G10 — trụ im lặng quá OFFLINE_ALERT_S thì có sự cố `Offline` (NFR-OCPP-07,
 * Commitment NFR-06, WF-04) — Postgres thật.
 *
 * Vì sao tồn tại: chứng minh OfflineAlertService + FaultService ghi đúng `fault_events` theo STM-6
 * (t1 raised, SIGNAL no-op, CONNECTOR_AVAILABLE → resolved) và đúng ngưỡng thời gian, chạy trên
 * đồng hồ giả để không chờ 900 s thật. "Trụ nói lại" được mô phỏng bằng đúng các cột mà
 * ocpp-gateway ghi khi trụ kết nối/gửi frame (`is_online`, `last_message_at`, `online_changed_at`)
 * — service chỉ đọc các cột đó, không phụ thuộc gateway (ADR-0016 D-F).
 *
 * Mã TC: TC-F10-0x (F-10 giám sát trụ), NFR-06.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { ScheduledTask, Scheduler } from '../src/common/scheduler.js';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { chargePoints, connectors, faultEvents } from '../src/db/schema/index.js';
import { OFFLINE_ERROR_CODE } from '../src/stations/faults/error-code-guide.js';
import { FaultService } from '../src/stations/faults/fault.service.js';
import { OfflineAlertService } from '../src/stations/faults/offline-alert.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const OFFLINE_ALERT_S = 900;
const SWEEP_S = 60;

const CONFIG: CsmsConfig = {
  databaseUrl: DATABASE_URL ?? '',
  ocppPort: 0,
  heartbeatIntervalS: 300,
  sessionStartTimeoutS: 120,
  sessionHardCapH: 24,
  replaySkewThresholdS: 5,
  meterValueSampleIntervalS: 10,
  reconcileGapFactor: 3,
  reconcileEnergyToleranceWh: 1,
  consoleEnabled: false,
  consoleHost: '127.0.0.1',
  consolePort: 0,
  offlineAlertS: OFFLINE_ALERT_S,
  offlineAlertSweepS: SWEEP_S,
};

/** Scheduler điều khiển tay: không có hẹn giờ thật nào chạy trong test. */
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
}

const T0 = Date.parse('2026-11-07T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

describeDb('G10 — cảnh báo trụ im lặng quá OFFLINE_ALERT_S (NFR-OCPP-07, WF-04)', () => {
  let db: Db;
  let faults: FaultService;
  let alerts: OfflineAlertService;
  let cpId: number;
  let idleCpId: number;

  async function offlineFaults(chargePointId = cpId) {
    return db
      .select()
      .from(faultEvents)
      .where(eq(faultEvents.chargePointId, chargePointId))
      .orderBy(asc(faultEvents.id));
  }

  /** Trụ gửi frame lúc `t` (đúng các cột ocpp-gateway cập nhật). */
  async function heard(t: Date, id = cpId) {
    await db
      .update(chargePoints)
      .set({ isOnline: true, lastMessageAt: t, onlineChangedAt: t })
      .where(eq(chargePoints.id, id));
  }

  /** Socket đóng lúc `t` (trụ mất kết nối hẳn). */
  async function socketClosed(t: Date, id = cpId) {
    await db
      .update(chargePoints)
      .set({ isOnline: false, onlineChangedAt: t })
      .where(eq(chargePoints.id, id));
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const inserted = await db
      .insert(chargePoints)
      .values([
        { serialNumber: 'G10-D1-0001', model: 'D1-120', lifecycle: 'in_service' },
        { serialNumber: 'G10-D1-REG', model: 'D1-120', lifecycle: 'awaiting_connection' },
      ])
      .returning({ id: chargePoints.id });
    cpId = inserted[0]!.id;
    idleCpId = inserted[1]!.id;
    await db.insert(connectors).values([
      { chargePointId: cpId, connectorNo: 1 },
      { chargePointId: cpId, connectorNo: 2 },
    ]);
    faults = new FaultService(db, CONFIG, new ManualScheduler());
    alerts = new OfflineAlertService(db, CONFIG, faults, new ManualScheduler());
  });

  beforeEach(async () => {
    await db.delete(faultEvents);
    await heard(at(0));
    // Trụ chưa onboard xong, im lặng từ lâu: không bao giờ được cảnh báo.
    await db
      .update(chargePoints)
      .set({ isOnline: false, lastMessageAt: at(-100_000), onlineChangedAt: at(-100_000) })
      .where(eq(chargePoints.id, idleCpId));
  });

  afterAll(async () => {
    faults?.cancelAll();
    alerts?.onApplicationShutdown();
    await db?.$client.end();
  });

  it('TC-F10-04: im lặng 899 s → chưa có sự cố', async () => {
    await socketClosed(at(1));
    const r = await alerts.sweep(at(899));
    expect(r).toEqual({ raised: 0, attached: 0, resolved: 0 });
    expect(await offlineFaults()).toHaveLength(0);
  });

  it('TC-F10-05: im lặng quá 900 s → đúng một sự cố Offline cả trụ (t1 raised)', async () => {
    await socketClosed(at(1));
    const r = await alerts.sweep(at(901));
    expect(r.raised).toBe(1);
    const [f] = await offlineFaults();
    expect(f).toMatchObject({
      connectorId: null,
      source: 'ocpp',
      errorCode: OFFLINE_ERROR_CODE,
      status: 'raised',
    });
    expect(f!.raisedAt.toISOString()).toBe(at(901).toISOString());
  });

  it('TC-F10-06: quét lại khi vẫn im lặng → không tạo trùng (SIGNAL no-op)', async () => {
    await alerts.sweep(at(901));
    const r = await alerts.sweep(at(961));
    expect(r).toEqual({ raised: 0, attached: 1, resolved: 0 });
    expect(await offlineFaults()).toHaveLength(1);
  });

  it('TC-F10-07: trụ nói lại → sự cố Offline tự đóng (CONNECTOR_AVAILABLE → resolved)', async () => {
    await alerts.sweep(at(901));
    await heard(at(1200));
    const r = await alerts.sweep(at(1210));
    expect(r.resolved).toBe(1);
    const [f] = await offlineFaults();
    expect(f!.status).toBe('resolved');
    expect(f!.resolvedAt!.toISOString()).toBe(at(1210).toISOString());
  });

  it('operator đã xác nhận rồi trụ mới nói lại → vẫn đóng được (t7)', async () => {
    await alerts.sweep(at(901));
    const [f] = await offlineFaults();
    await faults.acknowledge(f!.id, null, at(950));
    await heard(at(1000));
    expect((await alerts.sweep(at(1010))).resolved).toBe(1);
    expect((await offlineFaults())[0]!.status).toBe('resolved');
  });

  it('socket còn mở nhưng không frame nào quá 900 s (trụ treo) → vẫn cảnh báo', async () => {
    // is_online = true từ beforeEach; last_message_at đứng yên ở t=0.
    expect((await alerts.sweep(at(901))).raised).toBe(1);
  });

  it('trụ không ở in_service (awaiting_connection) → bỏ qua dù im lặng rất lâu', async () => {
    await alerts.sweep(at(901));
    expect(await offlineFaults(idleCpId)).toHaveLength(0);
  });

  it('đã có sự cố Faulted cả trụ đang mở → gắn vào, không mở sự cố Offline thứ hai', async () => {
    await db.insert(faultEvents).values({
      chargePointId: cpId,
      connectorId: null,
      source: 'ocpp',
      errorCode: 'UnderVoltage',
      status: 'raised',
      raisedAt: at(0),
    });
    const r = await alerts.sweep(at(901));
    expect(r).toEqual({ raised: 0, attached: 1, resolved: 0 });
    const rows = await offlineFaults();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.errorCode).toBe('UnderVoltage');
    // Sự cố Faulted không bị đóng bởi đường "trụ nói lại" của Offline.
    await heard(at(1000));
    expect((await alerts.sweep(at(1010))).resolved).toBe(0);
    expect((await offlineFaults())[0]!.status).toBe('raised');
  });

  it('NFR-06: từ frame cuối tới cảnh báo ≤ OFFLINE_ALERT_S + một nhịp quét', async () => {
    const lastMessage = at(0);
    await socketClosed(at(1));
    // Quét đều theo nhịp SWEEP_S, như vòng hẹn giờ thật.
    let alertAt: Date | null = null;
    for (let t = SWEEP_S; t <= OFFLINE_ALERT_S + 2 * SWEEP_S; t += SWEEP_S) {
      const r = await alerts.sweep(at(t));
      if (r.raised === 1) {
        alertAt = at(t);
        break;
      }
    }
    expect(alertAt).not.toBeNull();
    const delayS = (alertAt!.getTime() - lastMessage.getTime()) / 1000;
    expect(delayS).toBeGreaterThan(OFFLINE_ALERT_S - 1);
    expect(delayS).toBeLessThanOrEqual(OFFLINE_ALERT_S + SWEEP_S);
  });

  it('khởi động lại CSMS giữa chừng → service mới vẫn thấy và đóng sự cố cũ (không giữ RAM)', async () => {
    await alerts.sweep(at(901));
    const fresh = new OfflineAlertService(db, CONFIG, faults, new ManualScheduler());
    await heard(at(1100));
    expect((await fresh.sweep(at(1110))).resolved).toBe(1);
  });
});
