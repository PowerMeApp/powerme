/**
 * Test tích hợp WF-03 "mất kết nối và đối soát" — PHÁT LẠI TRACE THẬT của EXP-01 (T33).
 *
 * Vì sao tồn tại: T13 mục 6 yêu cầu fixture của STM-1 là trace JSONL thật
 * (`test/fixtures/exp1-disconnect-81s.jsonl`, 150 frame, chép từ `apps/csms/lab/ocpp-traces/`).
 * Test này áp migration `drizzle/0000_init.sql` rồi `0001_quyet-dinh-be-11.sql` lên DB sạch, tạo trụ RH24D1-00001 với 2 súng, rồi
 * đưa 75 frame CALL chiều vào qua ĐÚNG đường xử lý của gateway (`OcppServer.processCall` →
 * ReplayDetector → ocpp_message_log → OcppHandlers → SessionsService → ReconciliationService),
 * không mở socket. Hai epoch được mô phỏng như EXP-01: epoch 1 cho frame trước 14:19:01Z (lúc
 * mini-CSMS bị tắt), socket đóng, epoch 2 mở lúc 14:20:22.978Z (trụ nối lại, không Boot).
 *
 * Cần DATABASE_URL (CI có Postgres 16); thiếu thì cả describe bị skip. Máy dev không có Postgres
 * thì chạy `npm test` vẫn xanh (chỉ unit).
 *
 * transactionId trong trace là số mini-CSMS cấp (1, 2, 3 rồi lại 1 sau khi khởi động lại). CSMS
 * thật cấp transaction_no từ DB sequence, nên test ánh xạ "id trong trace → transaction_no CSMS trả"
 * tại mỗi StartTransaction và viết lại transactionId của MeterValues/StopTransaction theo đó — đúng
 * như trụ thật sẽ dùng số CSMS đã trả.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePointConnections,
  chargePoints,
  connectorStatusEvents,
  connectors,
  meterValues,
  ocppMessageLog,
  reconciliationRecords,
  sessionStatusHistory,
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
import { cpTimestampOf } from '../src/ocpp-gateway/ocpp-types.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector, ReplayVerdict } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { ENERGY_MEASURAND, SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

interface TraceFrame {
  received_at: string;
  cp: string;
  dir: 'in' | 'out';
  type: 2 | 3 | 4;
  id: string;
  action: string | null;
  cp_timestamp: string | null;
  raw: string;
}

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'RH24D1-00001';
const FIXTURE = path.join(__dirname, 'fixtures', 'exp1-disconnect-81s.jsonl');
/** Mini-CSMS bị tắt lúc 14:19:01Z (EXP-01): frame trước mốc này thuộc epoch 1. */
const SOCKET_CLOSED_AT = new Date('2026-09-16T14:19:01.000Z');
/** Trụ nối lại (EXP-01): epoch 2 mở lúc này. */
const EPOCH2_OPENED_AT = new Date('2026-09-16T14:20:22.978Z');

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
};

class StubClient implements OcppClientLike {
  readonly calls: { method: string; params: unknown }[] = [];
  constructor(readonly identity: string) {}
  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

function loadTrace(): TraceFrame[] {
  return readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as TraceFrame);
}

describeDb('WF-03 — phát lại trace EXP-01 (ngắt kết nối 81 s giữa phiên sạc)', () => {
  const allFrames = loadTrace();
  const inbound = allFrames
    .filter((f) => f.dir === 'in' && f.type === 2)
    .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  const epoch1Frames = inbound.filter(
    (f) => Date.parse(f.received_at) < SOCKET_CLOSED_AT.getTime(),
  );
  const epoch2Frames = inbound.filter(
    (f) => Date.parse(f.received_at) >= SOCKET_CLOSED_AT.getTime(),
  );

  let db: Db;
  let chargePointId: number;
  let server: OcppServer;
  let serializer: InboundSerializer;
  let sessionsService: SessionsService;
  let replayDetector: ReplayDetector;
  let registry1: ConnectionRegistry;
  let registry2: ConnectionRegistry;
  let client1: StubClient;
  let client2: StubClient;
  let conn1: Connection;
  let conn2: Connection;

  /** transactionId trong trace (mini-CSMS cấp) → transaction_no CSMS thật trả. */
  const txMap = new Map<number, number>();
  /** Phán quyết ReplayDetector cho từng frame đã phát (để kiểm (b), (f) không cần cột replayed). */
  const verdicts: {
    frame: TraceFrame;
    action: string;
    transactionId: number | null;
    verdict: ReplayVerdict;
  }[] = [];

  async function play(frame: TraceFrame, conn: Connection): Promise<Record<string, unknown>> {
    const raw = JSON.parse(frame.raw) as [number, string, string, Record<string, unknown>];
    const action = raw[2];
    let params = raw[3];
    const traceTx =
      typeof params['transactionId'] === 'number' ? (params['transactionId'] as number) : null;
    if ((action === 'MeterValues' || action === 'StopTransaction') && traceTx !== null) {
      params = { ...params, transactionId: txMap.get(traceTx) ?? traceTx };
    }
    const receivedAt = new Date(frame.received_at);
    const result = await serializer.run(CP, () =>
      server.processCall(conn, { messageId: raw[1], action, params }, receivedAt),
    );
    if (action === 'StartTransaction') {
      const reply = allFrames.find((f) => f.dir === 'out' && f.id === frame.id);
      if (!reply) throw new Error(`trace thiếu CALLRESULT cho StartTransaction ${frame.id}`);
      const assigned = (JSON.parse(reply.raw) as [number, string, { transactionId: number }])[2]
        .transactionId;
      txMap.set(assigned, result['transactionId'] as number);
    }
    verdicts.push({
      frame,
      action,
      transactionId: traceTx === null ? null : (txMap.get(traceTx) ?? traceTx),
      verdict: replayDetector.classify({
        cpTimestamp: cpTimestampOf(action, params),
        receivedAt,
        epochOpenedAt: conn.epochOpenedAt,
      }),
    });
    return result;
  }

  async function sessionByTx(transactionNo: number) {
    const [row] = await db.select().from(sessions).where(eq(sessions.transactionNo, transactionNo));
    if (!row) throw new Error(`không có phiên transaction_no=${transactionNo}`);
    return row;
  }

  async function recordsOf(sessionId: number) {
    return db
      .select()
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.sessionId, sessionId))
      .orderBy(asc(reconciliationRecords.recordNo));
  }

  beforeAll(async () => {
    Logger.overrideLogger(['warn', 'error']);
    db = createDb(DATABASE_URL as string);
    // DB sạch + áp tuần tự 0000 → 0001 (migration tạo enum/partition nên không chạy lại được trên schema cũ).
    await resetAndMigrate(db.$client);

    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: CP, model: 'D1-120', lifecycle: 'awaiting_connection' })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    chargePointId = cp.id;
    await db.insert(connectors).values([
      { chargePointId, connectorNo: 1 },
      { chargePointId, connectorNo: 2 },
    ]);

    const stateMachine = new SessionStateMachine();
    const reconciliation = new ReconciliationService(db, CONFIG);
    sessionsService = new SessionsService(db, stateMachine, reconciliation, CONFIG);
    registry1 = new ConnectionRegistry(db);
    serializer = new InboundSerializer();
    replayDetector = new ReplayDetector(CONFIG.replaySkewThresholdS);
    server = new OcppServer(
      CONFIG,
      registry1,
      new OcppMessageLogger(db),
      serializer,
      replayDetector,
      new OcppHandlers(sessionsService, CONFIG),
      sessionsService,
    );
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  it('fixture là trace thật: 150 frame, 75 CALL chiều vào, 54 trước lúc ngắt và 21 sau khi nối lại', () => {
    expect(allFrames).toHaveLength(150);
    expect(inbound).toHaveLength(75);
    expect(epoch1Frames).toHaveLength(54);
    expect(epoch2Frames).toHaveLength(21);
    expect(inbound.every((f) => f.cp === CP)).toBe(true);
  });

  it('epoch 1: mở kết nối → epoch khởi tạo từ DB = MAX(epoch)+1 = 1, trụ in_service', async () => {
    client1 = new StubClient(CP);
    const first = epoch1Frames[0];
    if (!first) throw new Error('trace rỗng');
    conn1 = await registry1.open(CP, client1, {
      remoteAddress: '127.0.0.1',
      openedAt: new Date(Date.parse(first.received_at) - 1000),
    });
    expect(conn1.epoch).toBe(1);
    expect(conn1.chargePointId).toBe(chargePointId);
    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, chargePointId));
    expect(cp?.lifecycle).toBe('in_service'); // awaiting_connection → in_service (STM-3 #3)
    expect(cp?.isOnline).toBe(true);
    expect(cp?.currentEpoch).toBe(1);
  });

  it('epoch 1: phát lại 54 frame → tx1, tx2 reconciled (601 / 997 Wh), tx3 đang active', async () => {
    for (const frame of epoch1Frames) await play(frame, conn1);

    expect([...txMap.entries()]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    const tx1 = await sessionByTx(1);
    expect(tx1.status).toBe('reconciled');
    expect(tx1.meterStopWh).toBe(601);
    expect(tx1.energyWh).toBe(601);
    const tx2 = await sessionByTx(2);
    expect(tx2.status).toBe('reconciled');
    expect(tx2.meterStopWh).toBe(997);
    const tx3 = await sessionByTx(3);
    expect(tx3.status).toBe('active');
    expect(tx3.meterStopWh).toBeNull();
    expect(tx3.deliveredOffline).toBe(false);
  });

  it('socket đóng lúc 14:19:01Z: trụ offline, tx3 active → orphaned (T13 #13), epoch 1 có closed_at', async () => {
    const closed = await registry1.close(client1, {
      code: 1006,
      reason: 'mini-CSMS bi tat',
      closedAt: SOCKET_CLOSED_AT,
    });
    expect(closed?.epoch).toBe(1);
    const orphaned = await sessionsService.onStationOffline(chargePointId, SOCKET_CLOSED_AT);
    expect(orphaned).toBe(1);

    expect((await sessionByTx(3)).status).toBe('orphaned');
    expect((await sessionByTx(1)).status).toBe('reconciled');
    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, chargePointId));
    // T61 (ADR-0016 D-C): socket đóng chỉ đổi is_online, lifecycle hành chính giữ in_service.
    expect(cp?.lifecycle).toBe('in_service');
    expect(cp?.isOnline).toBe(false);
    const [e1] = await db
      .select()
      .from(chargePointConnections)
      .where(
        and(
          eq(chargePointConnections.chargePointId, chargePointId),
          eq(chargePointConnections.epoch, 1),
        ),
      );
    expect(e1?.closedAt).toEqual(SOCKET_CLOSED_AT);
    expect(e1?.closeReason).toBe('1006 mini-CSMS bi tat');
  });

  it('trụ nối lại 14:20:22.978Z KHÔNG gửi Boot: registry MỚI (CSMS khởi động lại) vẫn cấp epoch 2 từ DB, in_service, TriggerMessage c0/c1/c2', async () => {
    // EXP-01 là ca CSMS chết: registry trong RAM mất sạch → dùng instance mới để chứng minh epoch lấy từ DB.
    registry2 = new ConnectionRegistry(db);
    expect(registry2.size).toBe(0);
    client2 = new StubClient(CP);
    conn2 = await registry2.open(CP, client2, {
      remoteAddress: '127.0.0.1',
      openedAt: EPOCH2_OPENED_AT,
    });
    expect(conn2.epoch).toBe(2);
    expect(conn2.epochOpenedAt).toEqual(EPOCH2_OPENED_AT);

    await server.syncConnectorStatus(conn2);
    expect(client2.calls.map((c) => c.method)).toEqual([
      'TriggerMessage',
      'TriggerMessage',
      'TriggerMessage',
    ]);
    expect(client2.calls.map((c) => (c.params as { connectorId: number }).connectorId)).toEqual([
      0, 1, 2,
    ]);
    expect(
      client2.calls.every(
        (c) => (c.params as { requestedMessage: string }).requestedMessage === 'StatusNotification',
      ),
    ).toBe(true);

    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, chargePointId));
    expect(cp?.lifecycle).toBe('in_service');
    expect(cp?.isOnline).toBe(true);
    expect(cp?.currentEpoch).toBe(2);
    // Vẫn orphaned cho tới khi có bản tin live của chính phiên đó.
    expect((await sessionByTx(3)).status).toBe('orphaned');
  });

  it('giai đoạn D: MeterValues live đầu tiên (796 Wh, skew 0) → tx3 orphaned → active (T13 #18)', async () => {
    const first = epoch2Frames[0];
    if (!first || first.action !== 'MeterValues')
      throw new Error('frame đầu epoch 2 phải là MeterValues live');
    await play(first, conn2);
    const last = verdicts[verdicts.length - 1];
    expect(last?.verdict).toEqual({ replayed: false, reason: null, skewS: 0.002 });
    expect((await sessionByTx(3)).status).toBe('active');
  });

  it('giai đoạn D–F: phát lại 20 frame còn lại của epoch 2', async () => {
    for (const frame of epoch2Frames.slice(1)) await play(frame, conn2);
    expect(verdicts).toHaveLength(75);
  });

  // ---------------------------------------------------------------------------
  // Khẳng định (a)–(f) của T33 + vài khẳng định bổ sung theo dữ liệu thật
  // ---------------------------------------------------------------------------

  it('(a) 4 phiên, không trùng: tx1–tx3 ở epoch 1 + tx4 mở lúc offline (StartTransaction c2 phát lại, khoá tự nhiên mới)', async () => {
    // Trace có 4 StartTransaction với 4 khoá tự nhiên khác nhau (ADR-0010). Cái thứ tư
    // (c2, BB2TBR09, meterStart 0, cp_timestamp 14:18:52.934Z) sinh ra khi trụ offline; mini-CSMS
    // của lab cấp lại id 1 cho nó, CSMS thật cấp 4 từ sequence. Vì thế là 4 phiên, không phải 3.
    const all = await db.select().from(sessions).orderBy(asc(sessions.transactionNo));
    expect(all.map((s) => s.transactionNo)).toEqual([1, 2, 3, 4]);
    const naturalKeys = new Set(
      all.map(
        (s) =>
          `${s.chargePointId}|${s.connectorNo}|${s.idTag}|${s.meterStartWh}|${s.cpStartedAt.toISOString()}`,
      ),
    );
    expect(naturalKeys.size).toBe(4);
    expect(txMap.get(1)).toBe(4); // id 1 của mini-CSMS sau khởi động lại → tx4

    const tx4 = await sessionByTx(4);
    expect(tx4.connectorNo).toBe(2);
    expect(tx4.idTag).toBe('BB2TBR09');
    expect(tx4.cpStartedAt).toEqual(new Date('2026-09-16T14:18:52.934Z'));
    expect(tx4.deliveredOffline).toBe(true);
    expect(tx4.status).toBe('active'); // trace kết thúc khi tx4 còn sạc
    expect(tx4.paymentMode).toBe('unattributed'); // thẻ lạ → chưa biết ai thu tiền (ADR-0012, migration 0001)

    const dupes = await db
      .select({ n: count() })
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.recordType, 'duplicate'));
    expect(dupes[0]?.n).toBe(0);
  });

  it('(b) tx3 có 13 mẫu Energy.Active.Import.Register (3 trước + 4 live + 6 phát lại), 65 dòng meter_values, 6 MeterValues phát lại', async () => {
    const tx3 = await sessionByTx(3);
    const energy = await db
      .select({
        cpTimestamp: meterValues.cpTimestamp,
        value: meterValues.value,
        receivedAt: meterValues.receivedAt,
      })
      .from(meterValues)
      .where(and(eq(meterValues.sessionId, tx3.id), eq(meterValues.measurand, ENERGY_MEASURAND)))
      .orderBy(asc(meterValues.cpTimestamp));
    expect(energy.map((r) => Number(r.value))).toEqual([
      64.56, 142.33, 242.04, 303.03, 354.41, 367.34, 385.85, 513.29, 537.94, 796.84, 873.41, 922.42,
      1042.64,
    ]);
    const [total] = await db
      .select({ n: count() })
      .from(meterValues)
      .where(eq(meterValues.sessionId, tx3.id));
    expect(total?.n).toBe(65); // 13 MeterValues × 5 SampledValue (SoC, V, W, A, Wh)

    // Kiểm bằng ReplayDetector trên từng frame và bằng record `replay`; cột replayed: xem (o), (p).
    const replayedMv = verdicts.filter(
      (v) => v.action === 'MeterValues' && v.transactionId === 3 && v.verdict.replayed,
    );
    expect(replayedMv).toHaveLength(6);
    expect(replayedMv.map((v) => v.verdict.reason)).toEqual(Array(6).fill('before_epoch'));
    for (const v of replayedMv) expect(v.verdict.skewS).toBeGreaterThan(100);
    // 6 mẫu phát lại đều nhận SAU StopTransaction (EXP-01 hiện tượng 2 — sai thứ tự).
    const stopReceivedAt = Date.parse('2026-09-16T14:20:58.209Z');
    for (const v of replayedMv)
      expect(Date.parse(v.frame.received_at)).toBeGreaterThan(stopReceivedAt);

    const replayRecords = (await recordsOf(tx3.id)).filter((r) => r.recordType === 'replay');
    expect(replayRecords.filter((r) => r.resolution?.includes('action=MeterValues'))).toHaveLength(
      6,
    );
    expect(
      replayRecords.filter((r) => r.resolution?.includes('action=StopTransaction')),
    ).toHaveLength(1);
  });

  it('(c) tx3 kết thúc ở review: StopTransaction phát lại meterStop=242 mâu thuẫn chuỗi 1042 Wh → meter_gap/conflict, diff 801 Wh', async () => {
    const tx3 = await sessionByTx(3);
    expect(tx3.status).toBe('review');
    expect(tx3.meterStopWh).toBe(242);
    expect(tx3.energyWh).toBe(242);
    expect(tx3.deliveredOffline).toBe(true);
    expect(tx3.cpStoppedAt).toEqual(new Date('2026-09-16T14:18:52.934Z'));
    expect(tx3.receivedStoppedAt).toEqual(new Date('2026-09-16T14:20:58.209Z'));
    expect(tx3.stopReason).toBe('Local');

    // Migration 0001: lần đối soát do StopTransaction → record_type = conflict; các lần do mẫu
    // muộn → late_sample (kết luận vẫn ở tiền tố resolution). meter_gap chỉ cho gap_detected thuần.
    const all = await recordsOf(tx3.id);
    expect(all.filter((r) => r.recordType === 'meter_gap')).toHaveLength(0);
    const gapRecords = all.filter(
      (r) => r.recordType === 'conflict' || r.recordType === 'late_sample',
    );
    expect(all.filter((r) => r.recordType === 'conflict')).toHaveLength(1);
    expect(all.filter((r) => r.recordType === 'late_sample')).toHaveLength(6);
    expect(gapRecords[0]?.recordType).toBe('conflict');
    const first = gapRecords[0];
    expect(first?.resolution).toMatch(/^conflict:/);
    expect(first?.energyDifferenceWh).toBe(801); // round(1042.64) − 242
    expect(first?.gapStart).toEqual(new Date('2026-09-16T14:18:47.811Z'));
    expect(first?.gapEnd).toEqual(new Date('2026-09-16T14:20:27.901Z'));
    expect(first?.reviewedAt).toBeNull();

    // Giai đoạn F: 6 mẫu muộn → đối soát lại, mỗi lần lỗ hổng thu hẹp → bản ghi mới (append-only).
    expect(gapRecords).toHaveLength(7);
    const last = gapRecords[gapRecords.length - 1];
    expect(last?.recordType).toBe('late_sample');
    expect(last?.resolution).toMatch(/^conflict \(late_sample\):/);
    expect(last?.energyDifferenceWh).toBe(801);
    expect(last?.gapStart).toEqual(new Date('2026-09-16T14:19:47.867Z'));
    expect(last?.gapEnd).toEqual(new Date('2026-09-16T14:20:27.901Z'));
  });

  it('(d) tx2 reconciled / consistent (meterStop 997 vs mẫu cuối 996,78), tx1 reconciled (601); không có meter_gap', async () => {
    for (const [no, stop] of [
      [1, 601],
      [2, 997],
    ] as const) {
      const s = await sessionByTx(no);
      expect(s.status).toBe('reconciled');
      expect(s.meterStopWh).toBe(stop);
      expect(s.energyWh).toBe(stop);
      expect(s.deliveredOffline).toBe(false);
      const recs = await recordsOf(s.id);
      expect(recs.filter((r) => r.recordType === 'meter_gap')).toHaveLength(0);
      expect(recs.filter((r) => r.recordType === 'replay')).toHaveLength(0);
    }
    const tx2 = await sessionByTx(2);
    const [n] = await db
      .select({ n: count() })
      .from(meterValues)
      .where(and(eq(meterValues.sessionId, tx2.id), eq(meterValues.measurand, ENERGY_MEASURAND)));
    expect(n?.n).toBe(14);
  });

  it('(e) ocpp_message_log có đúng 75 frame chiều vào đã phát, 54 ở epoch 1 và 21 ở epoch 2, cp_timestamp đúng số frame có timestamp', async () => {
    const rows = await db
      .select()
      .from(ocppMessageLog)
      .where(
        and(eq(ocppMessageLog.chargePointId, chargePointId), eq(ocppMessageLog.direction, 'in')),
      )
      .orderBy(asc(ocppMessageLog.receivedAt));
    expect(rows).toHaveLength(75);
    expect(rows.filter((r) => r.epoch === 1)).toHaveLength(54);
    expect(rows.filter((r) => r.epoch === 2)).toHaveLength(21);
    expect(rows.every((r) => r.messageType === 2 && r.action !== null)).toBe(true);
    expect(rows.map((r) => r.uniqueId)).toEqual(inbound.map((f) => f.id));
    expect(rows.map((r) => r.receivedAt.toISOString())).toEqual(inbound.map((f) => f.received_at));
    expect(rows.filter((r) => r.cpTimestamp !== null)).toHaveLength(
      inbound.filter((f) => f.cp_timestamp !== null).length,
    );

    const byAction = new Map<string, number>();
    for (const r of rows)
      byAction.set(r.action as string, (byAction.get(r.action as string) ?? 0) + 1);
    expect(Object.fromEntries(byAction)).toEqual({
      BootNotification: 2,
      StatusNotification: 18,
      Heartbeat: 5,
      Authorize: 2,
      StartTransaction: 4,
      MeterValues: 41,
      StopTransaction: 3,
    });
    const fromTrace = new Map<string, number>();
    for (const f of inbound)
      fromTrace.set(f.action as string, (fromTrace.get(f.action as string) ?? 0) + 1);
    expect(Object.fromEntries(byAction)).toEqual(Object.fromEntries(fromTrace));
    // raw là frame đã parse, đọc lại được action/params.
    const stop = rows.find((r) => r.action === 'StopTransaction' && r.epoch === 2);
    expect((stop?.raw as unknown[])[0]).toBe(2);
    expect(((stop?.raw as unknown[])[3] as { meterStop: number }).meterStop).toBe(242);
  });

  it('(f) đúng 8 frame bị phân loại phát lại (skew > 100 s, before_epoch): StopTransaction tx3, StartTransaction c2, 6 MeterValues; 67 frame còn lại là live', () => {
    const replayed = verdicts.filter((v) => v.verdict.replayed);
    expect(replayed).toHaveLength(8);
    expect(replayed.map((v) => v.action).sort()).toEqual(
      [
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'StartTransaction',
        'StopTransaction',
      ].sort(),
    );
    for (const v of replayed) {
      expect(v.verdict.reason).toBe('before_epoch');
      expect(v.verdict.skewS).toBeGreaterThan(100);
      expect(v.verdict.skewS).toBeLessThan(130);
      expect(Date.parse(v.frame.received_at)).toBeGreaterThanOrEqual(EPOCH2_OPENED_AT.getTime());
    }
    const stop = replayed.find((v) => v.action === 'StopTransaction');
    expect(stop?.verdict.skewS).toBeCloseTo(125.275, 3);
    const start = replayed.find((v) => v.action === 'StartTransaction');
    expect(start?.verdict.skewS).toBeCloseTo(125.709, 3);

    const live = verdicts.filter((v) => !v.verdict.replayed);
    expect(live).toHaveLength(67);
    for (const v of live) {
      // live: skew ≈ 0 (≤ 10 ms trong EXP-01) hoặc không có timestamp (Heartbeat/StatusNotification/Boot/Authorize).
      if (v.verdict.skewS !== null) expect(Math.abs(v.verdict.skewS)).toBeLessThanOrEqual(0.01);
    }
  });

  it('(g) 18 StatusNotification → 18 connector_status_events, 0 chuyển bất thường; c1 Available, c2 Charging cuối trace', async () => {
    const events = await db
      .select()
      .from(connectorStatusEvents)
      .where(eq(connectorStatusEvents.chargePointId, chargePointId))
      .orderBy(asc(connectorStatusEvents.receivedAt));
    expect(events).toHaveLength(18);
    expect(events.filter((e) => e.unexpectedTransition)).toHaveLength(0);
    expect(events.every((e) => e.connectorId !== null && e.errorCode === 'NoError')).toBe(true);
    const c = await db
      .select()
      .from(connectors)
      .where(eq(connectors.chargePointId, chargePointId))
      .orderBy(asc(connectors.connectorNo));
    expect(c.map((x) => x.status)).toEqual(['Available', 'Charging']);
  });

  it('(h) charge_point_connections: 2 epoch, epoch 1 đóng, epoch 2 mở; charge_points.current_epoch = 2, last_message_at = frame cuối', async () => {
    const conns = await db
      .select()
      .from(chargePointConnections)
      .where(eq(chargePointConnections.chargePointId, chargePointId))
      .orderBy(asc(chargePointConnections.epoch));
    expect(conns.map((c) => c.epoch)).toEqual([1, 2]);
    expect(conns[0]?.closedAt).not.toBeNull();
    expect(conns[1]?.closedAt).toBeNull();
    expect(conns[1]?.openedAt).toEqual(EPOCH2_OPENED_AT);
    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.id, chargePointId));
    expect(cp?.currentEpoch).toBe(2);
    expect(cp?.lifecycle).toBe('in_service');
    const lastFrame = inbound[inbound.length - 1];
    expect(cp?.lastMessageAt?.toISOString()).toBe(lastFrame?.received_at);
  });

  it('(i) idTag lạ (UNDEFINED, BB2TBR09 không có trong rfid_cards) → mỗi phiên một record unknown_id_tag (ADR-0012)', async () => {
    const rows = await db
      .select({
        sessionId: reconciliationRecords.sessionId,
        recordNo: reconciliationRecords.recordNo,
      })
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.recordType, 'unknown_id_tag'));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.recordNo === 1)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Migration 0001 — khẳng định theo DỮ LIỆU THẬT chạy ra từ trace (BM02 F09, F13)
  // ---------------------------------------------------------------------------

  it('(m) session_status_history: mỗi kịch bản trace để lại đúng chuỗi chuyển trạng thái, liền mạch và khớp sessions.status', async () => {
    const rows = await db
      .select({
        transactionNo: sessions.transactionNo,
        status: sessions.status,
        from: sessionStatusHistory.fromStatus,
        to: sessionStatusHistory.toStatus,
        event: sessionStatusHistory.event,
        actor: sessionStatusHistory.actor,
        at: sessionStatusHistory.occurredAt,
      })
      .from(sessionStatusHistory)
      .innerJoin(sessions, eq(sessions.id, sessionStatusHistory.sessionId))
      .orderBy(
        asc(sessionStatusHistory.sessionId),
        asc(sessionStatusHistory.occurredAt),
        asc(sessionStatusHistory.id),
      );
    const byTx = new Map<number, typeof rows>();
    for (const r of rows) byTx.set(r.transactionNo, [...(byTx.get(r.transactionNo) ?? []), r]);
    const chain = (tx: number) =>
      (byTx.get(tx) ?? []).map((r) => `${r.from ?? '●'} -${r.event}-> ${r.to}`);

    expect(chain(1)).toEqual([
      '● -START_TRANSACTION-> active',
      'active -STOP_TRANSACTION-> closed',
      'closed -RECONCILE_OK-> reconciled',
    ]);
    expect(chain(2)).toEqual(chain(1));
    // tx3: đúng kịch bản EXP-01 — offline giữa phiên, live quay lại, StopTransaction phát lại → conflict.
    expect(chain(3)).toEqual([
      '● -START_TRANSACTION-> active',
      'active -STATION_OFFLINE-> orphaned',
      'orphaned -LIVE_MESSAGE-> active',
      'active -STOP_TRANSACTION-> closed',
      'closed -RECONCILE_CONFLICT-> review',
    ]);
    expect(chain(4)).toEqual(['● -START_TRANSACTION-> active']);

    for (const [tx, list] of byTx) {
      // liền mạch: from của dòng sau = to của dòng trước; dòng cuối = sessions.status
      list.forEach((r, i) => {
        if (i > 0) expect(r.from).toBe(list[i - 1]?.to);
        else expect(r.from).toBeNull();
      });
      expect(list.at(-1)?.to).toBe(list[0]?.status);
      // thời gian không lùi (đồng hồ CSMS)
      for (let i = 1; i < list.length; i++) {
        expect(list[i]?.at.getTime()).toBeGreaterThanOrEqual(list[i - 1]?.at.getTime() ?? 0);
      }
      expect(tx).toBeGreaterThan(0);
    }
    // actor: frame của trụ → station; CSMS tự quyết (offline, đối soát) → system
    const actors = Object.fromEntries(
      rows.filter((r) => r.transactionNo === 3).map((r) => [r.event, r.actor]),
    );
    expect(actors).toEqual({
      START_TRANSACTION: 'station',
      STATION_OFFLINE: 'system',
      LIVE_MESSAGE: 'station',
      STOP_TRANSACTION: 'station',
      RECONCILE_CONFLICT: 'system',
    });
    // 3 + 3 + 5 + 1 dòng: không chuyển nào bị bỏ sót hay ghi trùng
    expect(rows).toHaveLength(12);
  });

  it('(n) sessions.orphaned_at: chỉ tx3 từng orphaned, giữ nguyên sau orphaned → active → review', async () => {
    const all = await db.select().from(sessions).orderBy(asc(sessions.transactionNo));
    expect(all.map((s) => s.orphanedAt)).toEqual([null, null, SOCKET_CLOSED_AT, null]);
    expect((await sessionByTx(3)).status).toBe('review');
  });

  it('(o) meter_values.replayed / epoch: 30 dòng (6 MeterValues × 5 SampledValue) phát lại của tx3 đều replayed=true, epoch 2', async () => {
    const tx3 = await sessionByTx(3);
    const rows = await db.select().from(meterValues).where(eq(meterValues.sessionId, tx3.id));
    const replayed = rows.filter((r) => r.replayed);
    expect(replayed).toHaveLength(30);
    expect(replayed.filter((r) => r.measurand === ENERGY_MEASURAND)).toHaveLength(6);
    expect(replayed.every((r) => r.epoch === 2)).toBe(true);
    // 6 mẫu phát lại tới SAU StopTransaction (EXP-01 hiện tượng 2)
    for (const r of replayed) {
      expect(r.receivedAt.getTime()).toBeGreaterThan(Date.parse('2026-09-16T14:20:58.209Z'));
    }
    // 15 dòng epoch 1 (3 MV) + 20 dòng epoch 2 live (4 MV) = replayed=false
    const live = rows.filter((r) => !r.replayed);
    expect(live).toHaveLength(35);
    expect(live.filter((r) => r.epoch === 1)).toHaveLength(15);
    expect(live.filter((r) => r.epoch === 2)).toHaveLength(20);
    // mọi dòng ghi sau 0001 đều có epoch
    const [nullEpoch] = await db
      .select({ n: count() })
      .from(meterValues)
      .where(sql`${meterValues.epoch} IS NULL`);
    expect(nullEpoch?.n).toBe(0);
    // ReplayDetector đã phán cả frame; ở đây chỉ tx3 có mẫu phát lại
    const [other] = await db
      .select({ n: count() })
      .from(meterValues)
      .where(and(eq(meterValues.replayed, true), sql`${meterValues.sessionId} <> ${tx3.id}`));
    expect(other?.n).toBe(0);
  });

  it('(p) ocpp_message_log.replayed: bằng phán quyết ReplayDetector khi có cp_timestamp, null khi không phân loại được', async () => {
    const rows = await db
      .select()
      .from(ocppMessageLog)
      .where(eq(ocppMessageLog.direction, 'in'))
      .orderBy(asc(ocppMessageLog.id));
    expect(rows).toHaveLength(75);
    expect(rows.map((r) => r.uniqueId)).toEqual(verdicts.map((v) => v.frame.id));
    rows.forEach((r, i) => {
      const v = verdicts[i];
      expect(r.replayed).toBe(v?.verdict.skewS === null ? null : v?.verdict.replayed);
    });
    expect(rows.filter((r) => r.replayed === true)).toHaveLength(8);
    // Heartbeat / StatusNotification / Authorize / Boot của SAP không có timestamp → null, không phải false
    const unclassifiable = rows.filter((r) => r.cpTimestamp === null);
    expect(unclassifiable.length).toBeGreaterThan(0);
    expect(unclassifiable.every((r) => r.replayed === null)).toBe(true);
    expect(rows.filter((r) => r.cpTimestamp !== null).every((r) => r.replayed !== null)).toBe(true);
  });

  it('(j) ADR-0010: phát lại lần nữa StartTransaction của tx3 → trả đúng transactionId 3, không phiên mới, ghi duplicate', async () => {
    const frame = epoch1Frames.find(
      (f) => f.action === 'StartTransaction' && f.received_at === '2026-09-16T14:18:17.785Z',
    );
    if (!frame) throw new Error('không thấy StartTransaction của tx3 trong trace');
    const res = await play(frame, conn2);
    expect(res['transactionId']).toBe(3);
    expect(res['idTagInfo']).toEqual({ status: 'Accepted' });
    const [n] = await db.select({ n: count() }).from(sessions);
    expect(n?.n).toBe(4);
    const tx3 = await sessionByTx(3);
    expect(tx3.status).toBe('review'); // không đụng trạng thái
    const dupes = (await recordsOf(tx3.id)).filter((r) => r.recordType === 'duplicate');
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.resolution).toContain('action=StartTransaction');
  });

  it('(k) StopTransaction lặp cho phiên đã dừng → orphan_stop, phiên giữ nguyên review', async () => {
    const frame = epoch2Frames.find((f) => f.action === 'StopTransaction');
    if (!frame) throw new Error('không thấy StopTransaction tx3 trong epoch 2');
    const res = await play(frame, conn2);
    expect(res['idTagInfo']).toEqual({ status: 'Accepted' }); // trụ không bao giờ thấy lỗi
    const tx3 = await sessionByTx(3);
    expect(tx3.status).toBe('review');
    expect(tx3.meterStopWh).toBe(242);
    const orphan = (await recordsOf(tx3.id)).filter((r) => r.recordType === 'orphan_stop');
    expect(orphan).toHaveLength(1);
  });

  it('(l) nối lại cùng identity khi socket cũ còn treo: registry đóng socket cũ (1012) và cấp epoch 3', async () => {
    const client3 = new StubClient(CP);
    const closeSpy = jest.spyOn(client2, 'close');
    const conn3 = await registry2.open(CP, client3, {
      openedAt: new Date('2026-09-16T14:30:00.000Z'),
    });
    expect(conn3.epoch).toBe(3);
    expect(closeSpy).toHaveBeenCalledWith({ code: 1012, reason: 'Thay the boi ket noi moi' });
    expect(registry2.get(CP)?.client).toBe(client3);
    // Sự kiện close của socket cũ tới muộn → không được coi là trụ mất kết nối.
    expect(await registry2.close(client2, { code: 1012 })).toBeNull();
    const conns = await db
      .select()
      .from(chargePointConnections)
      .where(eq(chargePointConnections.chargePointId, chargePointId))
      .orderBy(asc(chargePointConnections.epoch));
    expect(conns.map((c) => [c.epoch, c.closedAt !== null, c.closeReason])).toEqual([
      [1, true, '1006 mini-CSMS bi tat'],
      [2, true, '1012 superseded'],
      [3, false, null],
    ]);
  });
});
