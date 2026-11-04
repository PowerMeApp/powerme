/**
 * Test tích hợp G6 / BM02 F30 — công tắc `RECONCILIATION_ENABLED` dưới CÙNG kịch bản ngắt EXP-01.
 *
 * Vì sao tồn tại: câu hỏi nghiên cứu so CSMS bật vs tắt engine đối soát. Test phát lại toàn bộ
 * trace thật `exp1-disconnect-81s.jsonl` (cách làm của wf03-exp01.integration.test.ts: đưa frame
 * qua `OcppServer.processCall`, không mở socket, hai epoch) hai lần trên DB sạch:
 *   - bật  → tx3 vào `review` (meterStop 242 vs chuỗi 1042 Wh), có reconciliation_records;
 *   - tắt  → tx3 `reconciled` với 242 Wh (hoá đơn sai 4,3 lần), 0 reconciliation_records,
 *            nhưng vẫn 4 phiên (khử trùng StartTransaction), vẫn 6 MeterValues `replayed=true`,
 *            vẫn log đủ 75 frame thô.
 * Định nghĩa baseline "đối soát tắt": xem đầu src/reconciliation/reconciliation.service.ts.
 *
 * Cần DATABASE_URL; thiếu thì skip. DROP SCHEMA public — dùng DB `powerme_test`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePoints,
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
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

interface TraceFrame {
  received_at: string;
  cp: string;
  dir: 'in' | 'out';
  type: 2 | 3 | 4;
  id: string;
  action: string | null;
  raw: string;
}

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'RH24D1-00001';
const FIXTURE = path.join(__dirname, 'fixtures', 'exp1-disconnect-81s.jsonl');
const SOCKET_CLOSED_AT = new Date('2026-09-16T14:19:01.000Z');
const EPOCH2_OPENED_AT = new Date('2026-09-16T14:20:22.978Z');

const BASE_CONFIG: CsmsConfig = {
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
  constructor(readonly identity: string) {}
  async call(): Promise<unknown> {
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

/** Phát lại toàn bộ trace trên DB sạch với cấu hình cho trước; trả về db đã có dữ liệu. */
async function replayExp01(config: CsmsConfig): Promise<{ db: Db; chargePointId: number }> {
  const frames = readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TraceFrame);
  const inbound = frames
    .filter((f) => f.dir === 'in' && f.type === 2)
    .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  const epoch1 = inbound.filter((f) => Date.parse(f.received_at) < SOCKET_CLOSED_AT.getTime());
  const epoch2 = inbound.filter((f) => Date.parse(f.received_at) >= SOCKET_CLOSED_AT.getTime());

  const db = createDb(DATABASE_URL as string);
  await resetAndMigrate(db.$client);
  const [cp] = await db
    .insert(chargePoints)
    .values({ serialNumber: CP, model: 'D1-120', lifecycle: 'awaiting_connection' })
    .returning({ id: chargePoints.id });
  if (!cp) throw new Error('không tạo được charge_point');
  const chargePointId = cp.id;
  await db.insert(connectors).values([
    { chargePointId, connectorNo: 1 },
    { chargePointId, connectorNo: 2 },
  ]);

  const reconciliation = new ReconciliationService(db, config);
  const sessionsService = new SessionsService(
    db,
    new SessionStateMachine(),
    reconciliation,
    config,
  );
  const serializer = new InboundSerializer();
  const registry1 = new ConnectionRegistry(db);
  const server = new OcppServer(
    config,
    registry1,
    new OcppMessageLogger(db),
    serializer,
    new ReplayDetector(config.replaySkewThresholdS),
    new OcppHandlers(sessionsService, config),
    sessionsService,
  );

  const txMap = new Map<number, number>();
  const play = async (frame: TraceFrame, conn: Connection) => {
    const raw = JSON.parse(frame.raw) as [number, string, string, Record<string, unknown>];
    const action = raw[2];
    let params = raw[3];
    const traceTx =
      typeof params['transactionId'] === 'number' ? (params['transactionId'] as number) : null;
    if ((action === 'MeterValues' || action === 'StopTransaction') && traceTx !== null) {
      params = { ...params, transactionId: txMap.get(traceTx) ?? traceTx };
    }
    const result = await serializer.run(CP, () =>
      server.processCall(conn, { messageId: raw[1], action, params }, new Date(frame.received_at)),
    );
    if (action === 'StartTransaction') {
      const reply = frames.find((f) => f.dir === 'out' && f.id === frame.id);
      if (!reply) throw new Error(`trace thiếu CALLRESULT cho ${frame.id}`);
      const assigned = (JSON.parse(reply.raw) as [number, string, { transactionId: number }])[2]
        .transactionId;
      txMap.set(assigned, result['transactionId'] as number);
    }
  };

  const client1 = new StubClient(CP);
  const first = epoch1[0];
  if (!first) throw new Error('trace rỗng');
  const conn1 = await registry1.open(CP, client1, {
    remoteAddress: '127.0.0.1',
    openedAt: new Date(Date.parse(first.received_at) - 1000),
  });
  for (const f of epoch1) await play(f, conn1);
  await registry1.close(client1, {
    code: 1006,
    reason: 'mini-CSMS bi tat',
    closedAt: SOCKET_CLOSED_AT,
  });
  await sessionsService.onStationOffline(chargePointId, SOCKET_CLOSED_AT);

  const conn2 = await new ConnectionRegistry(db).open(CP, new StubClient(CP), {
    remoteAddress: '127.0.0.1',
    openedAt: EPOCH2_OPENED_AT,
  });
  for (const f of epoch2) await play(f, conn2);
  return { db, chargePointId };
}

describe.each([
  { enabled: false, label: 'TẮT' },
  { enabled: true, label: 'BẬT' },
])('G6 ablation — đối soát $label, trace EXP-01', ({ enabled }) => {
  const describeMode = DATABASE_URL ? describe : describe.skip;
  describeMode('', () => {
    let db: Db;
    let chargePointId: number;

    beforeAll(async () => {
      Logger.overrideLogger(['error']);
      ({ db, chargePointId } = await replayExp01({
        ...BASE_CONFIG,
        reconciliationEnabled: enabled,
      }));
    });
    afterAll(async () => {
      await db?.$client.end();
    });

    const tx = async (no: number) => {
      const [row] = await db.select().from(sessions).where(eq(sessions.transactionNo, no));
      if (!row) throw new Error(`không có tx${no}`);
      return row;
    };

    it('phần không thuộc đối soát giống hệt nhau ở cả hai chế độ: 4 phiên, 75 frame thô, 6 MeterValues phát lại (30 dòng replayed)', async () => {
      const all = await db.select().from(sessions).orderBy(asc(sessions.transactionNo));
      expect(all.map((s) => s.transactionNo)).toEqual([1, 2, 3, 4]);
      const [logged] = await db
        .select({ n: count() })
        .from(ocppMessageLog)
        .where(
          and(eq(ocppMessageLog.chargePointId, chargePointId), eq(ocppMessageLog.direction, 'in')),
        );
      expect(logged?.n).toBe(75);
      const tx3 = await tx(3);
      const [replayedRows] = await db
        .select({ n: count() })
        .from(meterValues)
        .where(and(eq(meterValues.sessionId, tx3.id), eq(meterValues.replayed, true)));
      expect(replayedRows?.n).toBe(30); // 6 MeterValues × 5 SampledValue
      expect(tx3.deliveredOffline).toBe(true);
      expect(tx3.meterStopWh).toBe(242);
      expect(tx3.energyWh).toBe(242);
      expect((await tx(4)).deliveredOffline).toBe(true);
    });

    it('tx1, tx2 (dữ liệu sạch) reconciled với 601 / 997 Wh ở cả hai chế độ', async () => {
      expect([(await tx(1)).status, (await tx(1)).energyWh]).toEqual(['reconciled', 601]);
      expect([(await tx(2)).status, (await tx(2)).energyWh]).toEqual(['reconciled', 997]);
    });

    if (!enabled) {
      it('TẮT: tx3 reconciled với 242 Wh (tin meterStop; chuỗi đo live đã tới 1042 Wh), 0 reconciliation_records', async () => {
        const tx3 = await tx(3);
        expect(tx3.status).toBe('reconciled');
        const [records] = await db.select({ n: count() }).from(reconciliationRecords);
        expect(records?.n).toBe(0);
        const history = await db
          .select()
          .from(sessionStatusHistory)
          .where(eq(sessionStatusHistory.sessionId, tx3.id))
          .orderBy(asc(sessionStatusHistory.id));
        const last = history[history.length - 1];
        expect([last?.fromStatus, last?.toStatus, last?.event]).toEqual([
          'closed',
          'reconciled',
          'RECONCILE_OK',
        ]);
        expect(last?.note).toContain('ablation');
      });
    } else {
      it('BẬT: tx3 vào review (hành vi cũ), có bản ghi conflict diff 801 Wh và 6 late_sample', async () => {
        const tx3 = await tx(3);
        expect(tx3.status).toBe('review');
        const recs = await db
          .select()
          .from(reconciliationRecords)
          .where(eq(reconciliationRecords.sessionId, tx3.id))
          .orderBy(asc(reconciliationRecords.recordNo));
        expect(recs.filter((r) => r.recordType === 'conflict')).toHaveLength(1);
        expect(recs.filter((r) => r.recordType === 'late_sample')).toHaveLength(6);
        expect(recs.find((r) => r.recordType === 'conflict')?.energyDifferenceWh).toBe(801);
      });
    }
  });
});
