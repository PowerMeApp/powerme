/**
 * ConsoleQueries — các truy vấn CHỈ ĐỌC của bảng điều khiển (Drizzle trên `db` dùng chung).
 *
 * Vì sao tồn tại: gom SQL ở một chỗ; định dạng JSON nằm ở console.mappers.ts (thuần, có spec).
 * Không ghi DB, không gọi service nghiệp vụ. Trạng thái "đang nối socket" lấy từ
 * ConnectionRegistry (RAM) chứ không từ cột lifecycle — sau khi CSMS khởi động lại, lifecycle
 * trong DB có thể còn `in_service` dù chưa trụ nào nối lại (EXP-01).
 *
 * Giới hạn đã biết: `message_frames` dùng count(*) trên cả bảng log (đủ cho demo; ở quy mô lớn
 * phải thay bằng ước lượng). Cờ replayed dựng lại bằng chính ReplayDetector (xem mappers).
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, like, or, sql } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import {
  chargePointConnections,
  chargePoints,
  connectors,
  meterValues,
  ocppMessageLog,
  reconciliationRecords,
  sessionPauses,
  sessions,
} from '../db/schema/index.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { ReplayDetector } from '../reconciliation/replay-detector.js';
import { ENERGY_MEASURAND } from '../sessions/sessions.service.js';
import { ConsoleError } from './console.http.js';
import {
  buildSummary,
  iso,
  mapMessage,
  mapMeterValue,
  mapReconciliation,
  mapSession,
  mapStation,
} from './console.mappers.js';

const SESSION_COLUMNS = {
  id: sessions.id,
  transactionNo: sessions.transactionNo,
  serialNumber: chargePoints.serialNumber,
  connectorNo: sessions.connectorNo,
  idTag: sessions.idTag,
  origin: sessions.origin,
  paymentMode: sessions.paymentMode,
  status: sessions.status,
  receivedStartedAt: sessions.receivedStartedAt,
  receivedStoppedAt: sessions.receivedStoppedAt,
  cpStartedAt: sessions.cpStartedAt,
  cpStoppedAt: sessions.cpStoppedAt,
  meterStartWh: sessions.meterStartWh,
  meterStopWh: sessions.meterStopWh,
  stopReason: sessions.stopReason,
  deliveredOffline: sessions.deliveredOffline,
  energyWh: sessions.energyWh,
};

/**
 * Điều kiện SQL của "bản ghi conflict" (khớp `reconciliationKind() === 'conflict'`):
 *  - record_type = conflict (từ migration 0001);
 *  - record_type = late_sample mà kết luận (tiền tố resolution) là conflict;
 *  - DỮ LIỆU CŨ trước 0001: meter_gap có resolution bắt đầu bằng "conflict".
 */
const IS_CONFLICT = or(
  eq(reconciliationRecords.recordType, 'conflict'),
  and(
    inArray(reconciliationRecords.recordType, ['late_sample', 'meter_gap']),
    like(reconciliationRecords.resolution, 'conflict%'),
  ),
);

@Injectable()
export class ConsoleQueries {
  private readonly detector: ReplayDetector;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) config: CsmsConfig,
    private readonly registry: ConnectionRegistry,
  ) {
    this.detector = new ReplayDetector(config.replaySkewThresholdS);
  }

  async stations() {
    const cps = await this.db.select().from(chargePoints).orderBy(asc(chargePoints.serialNumber));
    const conns = await this.db.select().from(connectors).orderBy(asc(connectors.connectorNo));
    return cps.map((cp) =>
      mapStation(
        {
          serialNumber: cp.serialNumber,
          lifecycle: cp.lifecycle,
          currentEpoch: cp.currentEpoch,
          lastMessageAt: cp.lastMessageAt,
          connectors: conns.filter((c) => c.chargePointId === cp.id),
        },
        this.registry.get(cp.serialNumber) !== undefined,
      ),
    );
  }

  async sessions(limit: number) {
    const rows = await this.db
      .select(SESSION_COLUMNS)
      .from(sessions)
      .innerJoin(chargePoints, eq(chargePoints.id, sessions.chargePointId))
      .orderBy(desc(sessions.id))
      .limit(limit);
    return this.attachExtras(rows);
  }

  /** Số mẫu, cờ conflict và số đọc đồng hồ mới nhất cho một lô phiên (3 truy vấn, không N+1). */
  private async attachExtras(rows: Row[]) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const counts = await this.db
      .select({ sessionId: meterValues.sessionId, n: count() })
      .from(meterValues)
      .where(inArray(meterValues.sessionId, ids))
      .groupBy(meterValues.sessionId);
    const conflicts = await this.db
      .selectDistinct({ sessionId: reconciliationRecords.sessionId })
      .from(reconciliationRecords)
      .where(and(inArray(reconciliationRecords.sessionId, ids), IS_CONFLICT));
    const latest = await this.db
      .selectDistinctOn([meterValues.sessionId], {
        sessionId: meterValues.sessionId,
        value: meterValues.value,
      })
      .from(meterValues)
      .where(and(inArray(meterValues.sessionId, ids), eq(meterValues.measurand, ENERGY_MEASURAND)))
      .orderBy(meterValues.sessionId, desc(meterValues.cpTimestamp));
    const countBy = new Map(counts.map((c) => [c.sessionId, Number(c.n)]));
    const conflictSet = new Set(conflicts.map((c) => c.sessionId));
    const latestBy = new Map(latest.map((l) => [l.sessionId, Number(l.value)]));
    return rows.map((r) =>
      mapSession(r, {
        meterValueCount: countBy.get(r.id) ?? 0,
        hasConflict: conflictSet.has(r.id),
        latestMeterWh: latestBy.get(r.id) ?? null,
      }),
    );
  }

  async session(id: number) {
    const [row] = await this.db
      .select({ ...SESSION_COLUMNS, chargePointId: sessions.chargePointId })
      .from(sessions)
      .innerJoin(chargePoints, eq(chargePoints.id, sessions.chargePointId))
      .where(eq(sessions.id, id))
      .limit(1);
    if (!row) throw new ConsoleError(404, 'not_found', `Không có phiên id=${id}`);
    const [summary] = await this.attachExtras([row]);

    const samples = await this.db
      .select()
      .from(meterValues)
      .where(eq(meterValues.sessionId, id))
      .orderBy(asc(meterValues.cpTimestamp), asc(meterValues.id))
      .limit(5000);
    const connections = await this.db
      .select({ openedAt: chargePointConnections.openedAt })
      .from(chargePointConnections)
      .where(eq(chargePointConnections.chargePointId, row.chargePointId));
    const records = await this.db
      .select()
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.sessionId, id))
      .orderBy(asc(reconciliationRecords.recordNo));
    const pauses = await this.db
      .select()
      .from(sessionPauses)
      .where(eq(sessionPauses.sessionId, id))
      .orderBy(asc(sessionPauses.pausedAt));

    return {
      session: summary,
      meter_values: samples.map((s) => mapMeterValue(s, this.detector, connections)),
      reconciliation_records: records.map((r) =>
        mapReconciliation({ ...r, transactionNo: row.transactionNo }),
      ),
      pauses: pauses.map((p) => ({
        paused_at: iso(p.pausedAt),
        resumed_at: iso(p.resumedAt),
        pause_cause: p.pauseCause,
      })),
    };
  }

  async reconciliation(limit: number) {
    const rows = await this.db
      .select({ rec: reconciliationRecords, transactionNo: sessions.transactionNo })
      .from(reconciliationRecords)
      .innerJoin(sessions, eq(sessions.id, reconciliationRecords.sessionId))
      .orderBy(desc(reconciliationRecords.id))
      .limit(limit);
    return rows.map((r) => mapReconciliation({ ...r.rec, transactionNo: r.transactionNo }));
  }

  /**
   * Đuôi ocpp_message_log, luôn trả theo id TĂNG dần. Không có `after`: `limit` dòng mới nhất.
   * Có `after`: các dòng id > after (tối đa `limit`, dòng cũ nhất trước — lần poll sau lấy tiếp).
   */
  async messages(limit: number, after: number | null) {
    const base = this.db
      .select({
        id: ocppMessageLog.id,
        serialNumber: chargePoints.serialNumber,
        receivedAt: ocppMessageLog.receivedAt,
        cpTimestamp: ocppMessageLog.cpTimestamp,
        epoch: ocppMessageLog.epoch,
        direction: ocppMessageLog.direction,
        messageType: ocppMessageLog.messageType,
        action: ocppMessageLog.action,
        uniqueId: ocppMessageLog.uniqueId,
        epochOpenedAt: chargePointConnections.openedAt,
      })
      .from(ocppMessageLog)
      .innerJoin(chargePoints, eq(chargePoints.id, ocppMessageLog.chargePointId))
      .leftJoin(
        chargePointConnections,
        and(
          eq(chargePointConnections.chargePointId, ocppMessageLog.chargePointId),
          eq(chargePointConnections.epoch, ocppMessageLog.epoch),
        ),
      );
    const rows =
      after === null
        ? (await base.orderBy(desc(ocppMessageLog.id)).limit(limit)).reverse()
        : await base
            .where(gt(ocppMessageLog.id, after))
            .orderBy(asc(ocppMessageLog.id))
            .limit(limit);
    return rows.map((r) => mapMessage(r, this.detector));
  }

  async summary() {
    const cps = await this.db.select({ serial: chargePoints.serialNumber }).from(chargePoints);
    const bySession = await this.db
      .select({ status: sessions.status, n: count() })
      .from(sessions)
      .groupBy(sessions.status);
    const byRecord = await this.db
      .select({ type: reconciliationRecords.recordType, n: count() })
      .from(reconciliationRecords)
      .groupBy(reconciliationRecords.recordType);
    const [conflicts] = await this.db
      .select({ n: count() })
      .from(reconciliationRecords)
      .where(IS_CONFLICT);
    const [frames] = await this.db.select({ n: sql<string>`count(*)` }).from(ocppMessageLog);
    const serials = cps.map((c) => c.serial);
    return buildSummary({
      stationSerials: serials,
      connectedSerials: new Set(serials.filter((s) => this.registry.get(s) !== undefined)),
      sessionCounts: new Map(bySession.map((r) => [r.status, Number(r.n)])),
      recordCounts: new Map(byRecord.map((r) => [r.type, Number(r.n)])),
      conflictCount: Number(conflicts?.n ?? 0),
      frameCount: Number(frames?.n ?? 0),
    });
  }
}

type Row = Parameters<typeof mapSession>[0];
