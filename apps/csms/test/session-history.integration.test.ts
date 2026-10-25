/**
 * Test tích hợp lịch sử chuyển trạng thái phiên và các thay đổi hành vi của migration 0001 trên
 * những đường KHÔNG có trong trace EXP-01 (BM02 F10, F13).
 *
 * Vì sao tồn tại: trace EXP-01 chỉ đi qua active → orphaned → active → closed → review. Đường
 * tạm dừng (#5, #6), orphaned → reconciled (#16), mẫu muộn đổi kết luận (#19), conflict tại
 * StopTransaction, lỗ hổng thuần (meter_gap) và phân loại payment_mode của idTag đều phải để lại
 * dấu vết đúng. Test gọi thẳng SessionsService (không qua gateway) với InboundContext dựng tay.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePoints,
  connectors,
  meterValues,
  reconciliationRecords,
  rfidCards,
  sessionPauses,
  sessionStatusHistory,
  sessions,
} from '../src/db/schema/index.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { ENERGY_MEASURAND, SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'HIST-00001';
const FREE_VEND_TAG = 'HMI-FREEVEND';
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

/** 2026-10-25T10:MM:SSZ */
const T = (mmss: string) => new Date(`2026-10-25T10:${mmss}Z`);

describeDb(
  'lịch sử chuyển trạng thái phiên + hành vi mới của 0001 (đường ngoài trace EXP-01)',
  () => {
    let db: Db;
    let svc: SessionsService;
    let chargePointId: number;
    let logId = 0;

    function ctx(receivedAt: Date, replayed = false): InboundContext {
      return {
        identity: CP,
        chargePointId,
        epoch: 1,
        epochOpenedAt: T('00:00'),
        receivedAt,
        cpTimestamp: receivedAt,
        messageId: `m${++logId}`,
        messageLogId: logId,
        replay: { replayed, reason: replayed ? 'before_epoch' : null, skewS: replayed ? 120 : 0 },
      };
    }

    async function start(connectorId: number, idTag: string, meterStart: number, at: Date) {
      const r = await svc.onStartTransaction(
        { connectorId, idTag, meterStart, timestamp: at.toISOString() },
        ctx(at),
      );
      return r.transactionId;
    }

    async function meter(tx: number, wh: number, cpAt: Date, receivedAt = cpAt, replayed = false) {
      await svc.onMeterValues(
        {
          connectorId: 1,
          transactionId: tx,
          meterValue: [
            {
              timestamp: cpAt.toISOString(),
              sampledValue: [{ value: String(wh), measurand: ENERGY_MEASURAND, unit: 'Wh' }],
            },
          ],
        },
        ctx(receivedAt, replayed),
      );
    }

    const stop = (tx: number, meterStop: number, at: Date) =>
      svc.onStopTransaction({ transactionId: tx, meterStop, timestamp: at.toISOString() }, ctx(at));

    async function session(tx: number) {
      const [row] = await db.select().from(sessions).where(eq(sessions.transactionNo, tx));
      if (!row) throw new Error(`không có tx ${tx}`);
      return row;
    }

    async function chain(tx: number): Promise<string[]> {
      const s = await session(tx);
      const rows = await db
        .select()
        .from(sessionStatusHistory)
        .where(eq(sessionStatusHistory.sessionId, s.id))
        .orderBy(asc(sessionStatusHistory.occurredAt), asc(sessionStatusHistory.id));
      return rows.map((r) => `${r.fromStatus ?? '●'} -${r.event}-> ${r.toStatus}`);
    }

    async function records(tx: number) {
      const s = await session(tx);
      return db
        .select()
        .from(reconciliationRecords)
        .where(eq(reconciliationRecords.sessionId, s.id))
        .orderBy(asc(reconciliationRecords.recordNo));
    }

    beforeAll(async () => {
      Logger.overrideLogger(['error']);
      db = createDb(DATABASE_URL as string);
      await resetAndMigrate(db.$client);
      const [cp] = await db
        .insert(chargePoints)
        .values({ serialNumber: CP, lifecycle: 'in_service', freeVendTag: FREE_VEND_TAG })
        .returning({ id: chargePoints.id });
      if (!cp) throw new Error('không tạo được charge_point');
      chargePointId = cp.id;
      await db.insert(connectors).values([
        { chargePointId, connectorNo: 1 },
        { chargePointId, connectorNo: 2 },
      ]);
      await db.insert(rfidCards).values([
        { cardIdentifier: 'CARD-ONLINE', cardKind: 'online', status: 'active' },
        { cardIdentifier: 'CARD-WALLET', cardKind: 'wallet', status: 'active' },
      ]);
      svc = new SessionsService(
        db,
        new SessionStateMachine(),
        new ReconciliationService(db, CONFIG),
        CONFIG,
      );
    });

    afterAll(async () => {
      await db?.$client.end();
    });

    it('tạm dừng: active → paused → active → closed → reconciled (#5, #6, #10, #12); event không hợp lệ KHÔNG để lại dòng', async () => {
      const tx = await start(2, 'CARD-ONLINE', 0, T('00:00'));
      // Charging khi đang active: state machine không có chuyển → không ghi lịch sử
      await svc.onStatusNotification(
        {
          connectorId: 2,
          errorCode: 'NoError',
          status: 'Charging',
          timestamp: T('00:02').toISOString(),
        },
        ctx(T('00:02')),
      );
      expect(await chain(tx)).toEqual(['● -START_TRANSACTION-> active']);

      await svc.onStatusNotification(
        {
          connectorId: 2,
          errorCode: 'NoError',
          status: 'SuspendedEV',
          timestamp: T('00:05').toISOString(),
        },
        ctx(T('00:05')),
      );
      await svc.onStatusNotification(
        {
          connectorId: 2,
          errorCode: 'NoError',
          status: 'Charging',
          timestamp: T('00:08').toISOString(),
        },
        ctx(T('00:08')),
      );
      await stop(tx, 20, T('00:10'));

      expect(await chain(tx)).toEqual([
        '● -START_TRANSACTION-> active',
        'active -STATUS_SUSPENDED-> paused',
        'paused -STATUS_CHARGING-> active',
        'active -STOP_TRANSACTION-> closed',
        'closed -RECONCILE_OK-> reconciled',
      ]);
      const s = await session(tx);
      expect(s.status).toBe('reconciled');
      expect(s.orphanedAt).toBeNull();
      expect(
        await db.select().from(sessionPauses).where(eq(sessionPauses.sessionId, s.id)),
      ).toHaveLength(1);
    });

    it('orphaned → reconciled thẳng (#16); orphaned_at giữ lần ĐẦU dù orphaned lần hai', async () => {
      const tx = await start(1, 'CARD-WALLET', 100, T('01:00'));
      await svc.onStationOffline(chargePointId, T('01:10'));
      expect((await session(tx)).orphanedAt).toEqual(T('01:10'));

      await meter(tx, 115, T('01:20')); // live → #18
      expect((await session(tx)).status).toBe('active');
      expect((await session(tx)).orphanedAt).toEqual(T('01:10')); // giữ nguyên khi → active

      await svc.onStationOffline(chargePointId, T('01:30'));
      expect((await session(tx)).orphanedAt).toEqual(T('01:10')); // lần hai không ghi đè
      await stop(tx, 130, T('01:40'));

      expect(await chain(tx)).toEqual([
        '● -START_TRANSACTION-> active',
        'active -STATION_OFFLINE-> orphaned',
        'orphaned -LIVE_MESSAGE-> active',
        'active -STATION_OFFLINE-> orphaned',
        'orphaned -RECONCILE_OK-> reconciled',
      ]);
      expect((await session(tx)).status).toBe('reconciled');
    });

    it('mẫu muộn đổi kết luận sau reconciled (#19): record_type late_sample + lịch sử reconciled → review', async () => {
      const tx = await start(1, 'CARD-ONLINE', 0, T('02:00'));
      await meter(tx, 50, T('02:05'));
      await stop(tx, 100, T('02:10'));
      expect((await session(tx)).status).toBe('reconciled');
      expect(await records(tx)).toHaveLength(0);

      // mẫu phát lại tới muộn: chuỗi 500 Wh vượt meterStop 100 Wh
      await meter(tx, 500, T('02:08'), T('03:00'), true);

      expect(await chain(tx)).toEqual([
        '● -START_TRANSACTION-> active',
        'active -STOP_TRANSACTION-> closed',
        'closed -RECONCILE_OK-> reconciled',
        'reconciled -LATE_SAMPLE_CONFLICT-> review',
      ]);
      const recs = await records(tx);
      expect(recs.map((r) => r.recordType)).toEqual(['replay', 'late_sample']);
      expect(recs[1]?.resolution).toMatch(/^conflict \(late_sample\):/);
      expect(recs[1]?.energyDifferenceWh).toBe(400);
      // mẫu phát lại mang replayed=true và epoch của frame; mẫu live trước đó replayed=false
      const mv = await db
        .select({
          value: meterValues.value,
          replayed: meterValues.replayed,
          epoch: meterValues.epoch,
        })
        .from(meterValues)
        .where(eq(meterValues.sessionId, (await session(tx)).id))
        .orderBy(asc(meterValues.id));
      expect(mv.map((m) => [Number(m.value), m.replayed, m.epoch])).toEqual([
        [50, false, 1],
        [500, true, 1],
      ]);
      const history = await db
        .select()
        .from(sessionStatusHistory)
        .orderBy(asc(sessionStatusHistory.id));
      expect(history.at(-1)).toMatchObject({ actor: 'system', occurredAt: T('03:00') });
    });

    it('conflict tại StopTransaction → record_type conflict (không còn meter_gap + tiền tố); review', async () => {
      const tx = await start(1, 'CARD-ONLINE', 0, T('04:00'));
      await meter(tx, 500, T('04:05'));
      await stop(tx, 100, T('04:10'));
      expect(await chain(tx)).toEqual([
        '● -START_TRANSACTION-> active',
        'active -STOP_TRANSACTION-> closed',
        'closed -RECONCILE_CONFLICT-> review',
      ]);
      const recs = await records(tx);
      expect(recs.map((r) => r.recordType)).toEqual(['conflict']);
      expect(recs[0]?.resolution).toMatch(/^conflict:/);
    });

    it('lỗ hổng thuần (gap_detected) → record_type meter_gap; phiên vẫn reconciled', async () => {
      const tx = await start(1, 'CARD-ONLINE', 0, T('05:00'));
      await stop(tx, 100, T('06:40')); // 100 s không có mẫu nào, ngưỡng 30 s
      const recs = await records(tx);
      expect(recs.map((r) => r.recordType)).toEqual(['meter_gap']);
      expect(recs[0]?.resolution).toMatch(/^gap_detected:/);
      expect((await session(tx)).status).toBe('reconciled');
      expect(await chain(tx)).toContain('closed -RECONCILE_OK-> reconciled');
    });

    it('payment_mode theo idTag: online → csms_billed, wallet → station_wallet, free vend → free, thẻ lạ → unattributed (+ unknown_id_tag)', async () => {
      const online = await start(1, 'CARD-ONLINE', 1000, T('07:00'));
      const wallet = await start(1, 'CARD-WALLET', 1000, T('07:01'));
      const free = await start(1, FREE_VEND_TAG, 1000, T('07:02'));
      const unknown = await start(1, 'KHONG-CO-TRONG-SO', 1000, T('07:03'));

      expect(await session(online)).toMatchObject({ paymentMode: 'csms_billed', origin: 'rfid' });
      expect(await session(wallet)).toMatchObject({
        paymentMode: 'station_wallet',
        origin: 'rfid',
      });
      expect(await session(free)).toMatchObject({ paymentMode: 'free', origin: 'free_vend' });
      expect(await session(unknown)).toMatchObject({ paymentMode: 'unattributed', origin: 'rfid' });
      expect((await records(unknown)).map((r) => r.recordType)).toEqual(['unknown_id_tag']);
      for (const tx of [online, wallet, free]) {
        expect((await records(tx)).map((r) => r.recordType)).not.toContain('unknown_id_tag');
      }
    });

    it('UPDATE sessions.status và dòng lịch sử cùng transaction: lịch sử không ghi được thì phiên không đổi trạng thái', async () => {
      const tx = await start(1, 'CARD-ONLINE', 5000, T('08:00'));
      await db.$client.query(
        `ALTER TABLE session_status_history ADD CONSTRAINT tmp_block_offline CHECK (event <> 'STATION_OFFLINE') NOT VALID`,
      );
      try {
        await expect(svc.onStationOffline(chargePointId, T('08:10'))).rejects.toThrow();
      } finally {
        await db.$client.query(
          `ALTER TABLE session_status_history DROP CONSTRAINT tmp_block_offline`,
        );
      }
      const s = await session(tx);
      expect(s.status).toBe('active');
      expect(s.orphanedAt).toBeNull();
      expect(await chain(tx)).toEqual(['● -START_TRANSACTION-> active']);
    });

    it('mỗi phiên: dòng lịch sử cuối = sessions.status, và chuỗi liền mạch (from của dòng sau = to dòng trước)', async () => {
      const all = await db.select().from(sessions);
      expect(all.length).toBeGreaterThanOrEqual(10);
      for (const s of all) {
        const rows = await db
          .select()
          .from(sessionStatusHistory)
          .where(eq(sessionStatusHistory.sessionId, s.id))
          .orderBy(asc(sessionStatusHistory.occurredAt), asc(sessionStatusHistory.id));
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0]?.fromStatus).toBeNull();
        rows.forEach((r, i) => {
          if (i > 0) expect(r.fromStatus).toBe(rows[i - 1]?.toStatus);
        });
        expect(rows.at(-1)?.toStatus).toBe(s.status);
      }
    });
  },
);
