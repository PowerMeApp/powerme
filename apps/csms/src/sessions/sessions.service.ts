/**
 * SessionsService — cửa duy nhất ghi vào `sessions`, `meter_values`, `session_pauses`,
 * `connector_status_events`, `connectors.status` (WF-03 mục 4).
 *
 * Vì sao tồn tại: handler OCPP ở gateway không được chứa logic nghiệp vụ (ADR-0004 "ba điều thư
 * viện không làm" → việc của đồ án). Mọi quyết định "phiên này ở trạng thái nào" đi qua
 * SessionStateMachine (T13), mọi kết luận "số đo có khớp không" đi qua ReconciliationService.
 *
 * Bốn luồng chính, bám EXP-01 / WF-03:
 *   - StartTransaction: idempotent theo khoá tự nhiên ADR-0010 (INSERT … ON CONFLICT DO NOTHING,
 *     trùng thì trả transaction_no cũ, ghi `duplicate`); idTag lạ vẫn tạo phiên (ADR-0012) kèm
 *     `unknown_id_tag`; bản tin phát lại → delivered_offline = true kèm `replay`.
 *   - MeterValues: mỗi SampledValue một dòng, dedup theo (session, cp_timestamp, measurand) BẰNG
 *     QUERY trước khi INSERT vì bảng partition không có UNIQUE (T11); bản tin live cho phiên
 *     orphaned → #18 orphaned → active; mẫu muộn sau khi đã có meter_stop → đối soát lại.
 *   - StopTransaction: ghi meter_stop, đối soát, #9/#10/#11 → closed rồi #12/#12a, hoặc từ
 *     orphaned thẳng #16/#16a; StopTransaction cho phiên đã dừng → `orphan_stop`.
 *   - StatusNotification: phản chiếu (T13 2.1), gắn cờ unexpected_transition; SuspendedEV/EVSE
 *     ↔ Charging điều khiển #5/#6 và session_pauses.
 * Cộng onStationOffline (#13–#15) do gateway gọi khi socket đóng.
 *
 * Chưa làm ở Iteration 1 (ghi trong docs/ITERATION-1-WF03.md): pending/RemoteStart (#1, #3, #4),
 * stopping/RemoteStop (#7, #8, #9a), hard cap (#16a nhánh timer), operator resolve (#17).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db, DbExecutor, Tx } from '../db/db.module.js';
import {
  chargePoints,
  connectorStatusEvents,
  connectors,
  meterValues,
  rfidCards,
  sessionPauses,
  sessionStatusHistory,
  sessions,
} from '../db/schema/index.js';
import type { InboundContext } from '../ocpp-gateway/inbound-context.js';
import type {
  MeterValue,
  StartTransactionRequest,
  StatusNotificationRequest,
  StopTransactionRequest,
  MeterValuesRequest,
} from '../ocpp-gateway/ocpp-types.js';
import {
  EnergySample,
  FrameRef,
  ReconciliationService,
} from '../reconciliation/reconciliation.service.js';
import { isConnectorStatus, isExpectedTransition } from './connectors/valid-transitions.js';
import { SessionEvent, SessionStateMachine, SessionStatus } from './session-state-machine.js';

export const ENERGY_MEASURAND = 'Energy.Active.Import.Register';

/** Trạng thái còn "mở" trên trụ — nhận được bản tin live, StopTransaction. */
const OPEN_STATUSES: readonly SessionStatus[] = ['active', 'paused', 'stopping', 'orphaned'];
/** Trạng thái bị kéo sang orphaned khi trụ offline (T13 #13–#15). */
const OFFLINE_AFFECTED: readonly SessionStatus[] = ['active', 'paused', 'stopping'];

/**
 * Event do FRAME của trụ gây ra → actor `station`; còn lại (đối soát, trụ offline, mẫu muộn) là
 * CSMS tự quyết → `system`. Ghi vào session_status_history.actor.
 */
const STATION_EVENTS: readonly SessionEvent[] = [
  'START_TRANSACTION',
  'STOP_TRANSACTION',
  'STATUS_SUSPENDED',
  'STATUS_CHARGING',
  'LIVE_MESSAGE',
];

type SessionRow = typeof sessions.$inferSelect;
type ConnectorRow = typeof connectors.$inferSelect;

interface FlatSample {
  cpTimestamp: Date;
  measurand: string;
  value: string;
  unit: string | null;
  context: string | null;
  phase: string | null;
}

export type AuthorizeStatus = 'Accepted' | 'Blocked' | 'Invalid';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stateMachine: SessionStateMachine,
    private readonly reconciliation: ReconciliationService,
    @Inject(CONFIG) private readonly config: CsmsConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Authorize
  // ---------------------------------------------------------------------------

  /** T13 mục 4: thẻ không có trong sổ → Invalid; blocked → Blocked. */
  async authorize(idTag: string): Promise<AuthorizeStatus> {
    const [card] = await this.db
      .select({ status: rfidCards.status })
      .from(rfidCards)
      .where(eq(rfidCards.cardIdentifier, idTag))
      .limit(1);
    if (!card) return 'Invalid';
    return card.status === 'blocked' ? 'Blocked' : 'Accepted';
  }

  // ---------------------------------------------------------------------------
  // StartTransaction — ADR-0010, ADR-0012
  // ---------------------------------------------------------------------------

  async onStartTransaction(
    req: StartTransactionRequest,
    ctx: InboundContext,
  ): Promise<{ transactionId: number; duplicate: boolean }> {
    const connector = await this.findConnector(ctx.chargePointId, req.connectorId);
    if (!connector) {
      // Không có FK để lưu → trả CALLERROR; trường hợp này là cấu hình sai, không phải phiên thật.
      throw new Error(`connectorId ${req.connectorId} không tồn tại trên trụ ${ctx.identity}`);
    }
    const cpStartedAt = new Date(req.timestamp);
    const tag = await this.classifyIdTag(ctx.chargePointId, req.idTag);
    const status = this.stateMachine.apply(null, 'START_TRANSACTION'); // T13 #2
    const frame = this.frameRef('StartTransaction', ctx);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(sessions)
        .values({
          connectorId: connector.id,
          chargePointId: ctx.chargePointId,
          connectorNo: connector.connectorNo,
          idTag: req.idTag,
          driverId: tag.driverId,
          rfidCardId: tag.rfidCardId,
          origin: tag.origin,
          paymentMode: tag.paymentMode,
          status,
          cpStartedAt,
          receivedStartedAt: ctx.receivedAt,
          meterStartWh: req.meterStart,
          deliveredOffline: ctx.replay.replayed,
          updatedAt: ctx.receivedAt,
        })
        .onConflictDoNothing({
          target: [
            sessions.chargePointId,
            sessions.connectorNo,
            sessions.idTag,
            sessions.meterStartWh,
            sessions.cpStartedAt,
          ],
        })
        .returning({ id: sessions.id, transactionNo: sessions.transactionNo });

      const created = inserted[0];
      if (!created) {
        // ADR-0010: trả đúng transactionId cũ, trụ không bao giờ thấy lỗi.
        const [existing] = await tx
          .select({ id: sessions.id, transactionNo: sessions.transactionNo })
          .from(sessions)
          .where(
            and(
              eq(sessions.chargePointId, ctx.chargePointId),
              eq(sessions.connectorNo, connector.connectorNo),
              eq(sessions.idTag, req.idTag),
              eq(sessions.meterStartWh, req.meterStart),
              eq(sessions.cpStartedAt, cpStartedAt),
            ),
          )
          .limit(1);
        if (!existing)
          throw new Error('UNIQUE từ chối nhưng không tìm thấy phiên — không thể xảy ra');
        await this.reconciliation.recordDuplicate(tx, existing.id, frame);
        this.logger.warn(
          `duplicate StartTransaction ${ctx.identity} c${req.connectorId} idTag=${req.idTag} → trả lại tx ${existing.transactionNo}`,
        );
        return { transactionId: existing.transactionNo, duplicate: true };
      }

      // T13 #2: INITIAL ● → active. Cùng transaction với INSERT sessions.
      await this.recordHistory(tx, created.id, null, status, 'START_TRANSACTION', ctx.receivedAt, {
        note: this.frameNote(ctx),
      });

      if (tag.unknown) {
        this.logger.warn(
          `idTag lạ "${req.idTag}" trên ${ctx.identity} c${req.connectorId} — payment_mode=unattributed (ADR-0012)`,
        );
        await this.reconciliation.recordUnknownIdTag(tx, created.id, req.idTag);
      }
      if (ctx.replay.replayed) {
        await this.reconciliation.recordReplay(tx, created.id, frame, ctx.replay);
      }
      this.logger.log(
        `tx ${created.transactionNo} mở: ${ctx.identity} c${req.connectorId} idTag=${req.idTag} meterStart=${req.meterStart}` +
          (ctx.replay.replayed ? ' (phát lại, delivered_offline)' : ''),
      );
      return { transactionId: created.transactionNo, duplicate: false };
    });
  }

  // ---------------------------------------------------------------------------
  // MeterValues
  // ---------------------------------------------------------------------------

  async onMeterValues(req: MeterValuesRequest, ctx: InboundContext): Promise<void> {
    if (req.transactionId === undefined || req.transactionId === null) {
      this.logger.debug(
        `MeterValues không có transactionId (${ctx.identity} c${req.connectorId}) — bỏ qua`,
      );
      return;
    }
    const session = await this.findByTransactionNo(req.transactionId);
    if (!session) {
      this.logger.warn(`MeterValues cho transactionId ${req.transactionId} không tồn tại — bỏ qua`);
      return;
    }
    const frame = this.frameRef('MeterValues', ctx);
    await this.db.transaction(async (tx) => {
      const { inserted, skipped } = await this.ingestSamples(tx, session.id, req.meterValue, ctx);
      if (inserted === 0 && skipped > 0) {
        await this.reconciliation.recordDuplicate(tx, session.id, frame);
      }
      if (ctx.replay.replayed) {
        await this.reconciliation.recordReplay(tx, session.id, frame, ctx.replay);
      }

      // T13 #18: bản tin live tới cho phiên orphaned → phiên vẫn đang sạc thật.
      if (session.status === 'orphaned' && !ctx.replay.replayed) {
        await this.transition(tx, session, 'LIVE_MESSAGE', ctx.receivedAt, this.frameNote(ctx));
        return;
      }

      // Mẫu muộn cho phiên đã có meter_stop → đối soát lại (WF-03 giai đoạn F, T13 #19).
      if (inserted > 0 && session.meterStopWh !== null) {
        await this.reconcileLateSample(tx, session, ctx);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // StopTransaction
  // ---------------------------------------------------------------------------

  async onStopTransaction(req: StopTransactionRequest, ctx: InboundContext): Promise<void> {
    const session = await this.findByTransactionNo(req.transactionId);
    const frame = this.frameRef('StopTransaction', ctx);
    if (!session) {
      // Không có phiên để gắn record (session_id NOT NULL) — chỉ còn ocpp_message_log làm chứng.
      this.logger.warn(
        `StopTransaction cho transactionId ${req.transactionId} không tồn tại (${ctx.identity}) — orphan stop, chỉ có log`,
      );
      return;
    }
    await this.db.transaction(async (tx) => {
      if (session.meterStopWh !== null || !OPEN_STATUSES.includes(session.status)) {
        this.logger.warn(
          `StopTransaction lặp cho tx ${req.transactionId} (status=${session.status}) — orphan_stop`,
        );
        await this.reconciliation.recordOrphanStop(tx, session.id, frame);
        return;
      }

      if (req.transactionData && req.transactionData.length > 0) {
        await this.ingestSamples(tx, session.id, req.transactionData, ctx);
      }

      const meterStopWh = req.meterStop >= session.meterStartWh ? req.meterStop : null;
      if (meterStopWh === null) {
        this.logger.warn(
          `tx ${req.transactionId}: meterStop ${req.meterStop} < meterStart ${session.meterStartWh} — không lưu, đối soát conflict`,
        );
      }
      const cpStoppedAt = new Date(req.timestamp);
      const replayed = ctx.replay.replayed;
      await tx
        .update(sessions)
        .set({
          meterStopWh,
          cpStoppedAt,
          receivedStoppedAt: ctx.receivedAt,
          stopReason: req.reason ?? null,
          deliveredOffline: session.deliveredOffline || replayed,
          energyWh: meterStopWh === null ? null : meterStopWh - session.meterStartWh,
          updatedAt: ctx.receivedAt,
        })
        .where(eq(sessions.id, session.id));
      if (replayed) await this.reconciliation.recordReplay(tx, session.id, frame, ctx.replay);

      // T13 #9/#10/#11: active | paused | stopping → closed. orphaned giữ nguyên để đi #16/#16a.
      let status = session.status;
      if (status !== 'orphaned') {
        const beforeStop = status;
        status = this.stateMachine.apply(status, 'STOP_TRANSACTION');
        await this.recordHistory(
          tx,
          session.id,
          beforeStop,
          status,
          'STOP_TRANSACTION',
          ctx.receivedAt,
          {
            note: this.frameNote(ctx),
          },
        );
      }

      const verdict = await this.evaluateSession(tx, { ...session, meterStopWh, cpStoppedAt });
      await this.reconciliation.recordVerdict(tx, session.id, verdict, { kind: 'stop', replayed });
      const event: SessionEvent =
        verdict.outcome === 'conflict' ? 'RECONCILE_CONFLICT' : 'RECONCILE_OK';
      const beforeReconcile = status;
      status = this.stateMachine.apply(status, event); // #12/#12a hoặc #16/#16a
      await tx
        .update(sessions)
        .set({ status, updatedAt: ctx.receivedAt })
        .where(eq(sessions.id, session.id));
      await this.recordHistory(tx, session.id, beforeReconcile, status, event, ctx.receivedAt, {
        note: `đối soát=${verdict.outcome}`,
      });
      this.logger.log(
        `tx ${req.transactionId} dừng: meterStop=${req.meterStop} reason=${req.reason ?? '-'} ` +
          `đối soát=${verdict.outcome} diff=${verdict.energyDifferenceWh ?? 'null'} → ${status}` +
          (replayed ? ' (StopTransaction phát lại)' : ''),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // StatusNotification — STM-2 phản chiếu, STM-1 #5/#6/#18
  // ---------------------------------------------------------------------------

  async onStatusNotification(req: StatusNotificationRequest, ctx: InboundContext): Promise<void> {
    if (!isConnectorStatus(req.status)) {
      this.logger.warn(`StatusNotification status lạ "${String(req.status)}" — bỏ qua`);
      return;
    }
    let connector: ConnectorRow | null = null;
    if (req.connectorId !== 0) {
      connector = await this.findConnector(ctx.chargePointId, req.connectorId);
      if (!connector) {
        this.logger.warn(
          `StatusNotification cho connector ${req.connectorId} không có trên ${ctx.identity} — bỏ qua`,
        );
        return;
      }
    }
    const previous = connector?.status ?? null;
    const unexpected = !isExpectedTransition(previous, req.status);
    if (unexpected) {
      this.logger.warn(
        `${ctx.identity} c${req.connectorId}: chuyển bất thường ${previous} → ${req.status} (gắn cờ, vẫn ghi)`,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(connectorStatusEvents).values({
        chargePointId: ctx.chargePointId,
        connectorNo: req.connectorId,
        connectorId: connector?.id ?? null,
        status: req.status,
        errorCode: req.errorCode,
        vendorErrorCode: req.vendorErrorCode ?? null,
        info: req.info ?? null,
        cpTimestamp: req.timestamp ? new Date(req.timestamp) : null,
        receivedAt: ctx.receivedAt,
        unexpectedTransition: unexpected,
      });
      if (!connector) return;
      await tx
        .update(connectors)
        .set({ status: req.status, statusChangedAt: ctx.receivedAt })
        .where(eq(connectors.id, connector.id));

      const session = await this.findOpenSession(tx, connector.id);
      if (!session) return;
      let event: SessionEvent | null = null;
      if (req.status === 'SuspendedEV' || req.status === 'SuspendedEVSE') {
        event = 'STATUS_SUSPENDED';
      } else if (req.status === 'Charging') {
        event =
          session.status === 'orphaned' && !ctx.replay.replayed
            ? 'LIVE_MESSAGE'
            : 'STATUS_CHARGING';
      }
      if (!event || !this.stateMachine.canApply(session.status, event)) return;
      await this.transition(tx, session, event, ctx.receivedAt, this.frameNote(ctx));
      if (event === 'STATUS_SUSPENDED') {
        await tx.insert(sessionPauses).values({
          sessionId: session.id,
          pausedAt: ctx.receivedAt,
          pauseCause: req.status === 'SuspendedEV' ? 'ev' : 'evse',
        });
      } else if (event === 'STATUS_CHARGING') {
        const [open] = await tx
          .select({ id: sessionPauses.id })
          .from(sessionPauses)
          .where(and(eq(sessionPauses.sessionId, session.id), isNull(sessionPauses.resumedAt)))
          .orderBy(desc(sessionPauses.pausedAt))
          .limit(1);
        if (open) {
          await tx
            .update(sessionPauses)
            .set({ resumedAt: ctx.receivedAt })
            .where(eq(sessionPauses.id, open.id));
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Trụ offline — STM-3 #4 kéo theo STM-1 #13–#15
  // ---------------------------------------------------------------------------

  async onStationOffline(chargePointId: number, at: Date): Promise<number> {
    const open = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.chargePointId, chargePointId),
          inArray(sessions.status, [...OFFLINE_AFFECTED]),
        ),
      );
    for (const s of open) {
      // UPDATE sessions.status + dòng lịch sử phải cùng transaction.
      await this.db.transaction((tx) =>
        this.transition(tx, s, 'STATION_OFFLINE', at, 'socket đóng / trụ mất kết nối'),
      );
    }
    if (open.length > 0)
      this.logger.warn(`trụ ${chargePointId} offline: ${open.length} phiên → orphaned`);
    return open.length;
  }

  // ---------------------------------------------------------------------------
  // Đọc
  // ---------------------------------------------------------------------------

  async findByTransactionNo(transactionNo: number): Promise<SessionRow | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.transactionNo, transactionNo))
      .limit(1);
    return row ?? null;
  }

  /** Chuỗi Energy.Active.Import.Register của phiên theo cp_timestamp. */
  async getEnergySeries(ex: DbExecutor, sessionId: number): Promise<EnergySample[]> {
    const rows = await ex
      .select({ cpTimestamp: meterValues.cpTimestamp, value: meterValues.value })
      .from(meterValues)
      .where(and(eq(meterValues.sessionId, sessionId), eq(meterValues.measurand, ENERGY_MEASURAND)))
      .orderBy(meterValues.cpTimestamp);
    return rows.map((r) => ({ cpTimestamp: r.cpTimestamp, wh: Number(r.value) }));
  }

  // ---------------------------------------------------------------------------
  // Nội bộ
  // ---------------------------------------------------------------------------

  /**
   * Áp một event lên phiên: UPDATE sessions.status (+ orphaned_at lần đầu sang orphaned) và ghi
   * một dòng session_status_history. `ex` PHẢI là transaction để hai việc cùng thành công/thất bại.
   */
  private async transition(
    ex: DbExecutor,
    session: SessionRow,
    event: SessionEvent,
    at: Date,
    note?: string,
  ): Promise<SessionStatus> {
    const from = session.status;
    const to = this.stateMachine.apply(from, event);
    const patch: Partial<typeof sessions.$inferInsert> = { status: to, updatedAt: at };
    if (to === 'orphaned' && session.orphanedAt === null) {
      patch.orphanedAt = at;
      session.orphanedAt = at;
    }
    await ex.update(sessions).set(patch).where(eq(sessions.id, session.id));
    await this.recordHistory(ex, session.id, from, to, event, at, { note });
    this.logger.log(`tx ${session.transactionNo}: ${from} --${event}--> ${to}`);
    session.status = to;
    return to;
  }

  /** Một dòng session_status_history cho một chuyển state machine đã chấp nhận. */
  private async recordHistory(
    ex: DbExecutor,
    sessionId: number,
    from: SessionStatus | null,
    to: SessionStatus,
    event: SessionEvent,
    at: Date,
    extra: { note?: string | undefined } = {},
  ): Promise<void> {
    await ex.insert(sessionStatusHistory).values({
      sessionId,
      fromStatus: from,
      toStatus: to,
      event,
      actor: STATION_EVENTS.includes(event) ? 'station' : 'system',
      note: extra.note ?? null,
      occurredAt: at,
    });
  }

  /** Dấu vết frame gây ra chuyển trạng thái (để lần ngược về ocpp_message_log). */
  private frameNote(ctx: InboundContext): string {
    return `message_log_id=${ctx.messageLogId}${ctx.replay.replayed ? ' replayed' : ''}`;
  }

  private async reconcileLateSample(
    tx: Tx,
    session: SessionRow,
    ctx: InboundContext,
  ): Promise<void> {
    const verdict = await this.evaluateSession(tx, session);
    await this.reconciliation.recordVerdict(tx, session.id, verdict, {
      kind: 'late_sample',
      replayed: ctx.replay.replayed,
    });
    if (session.status === 'reconciled' && verdict.outcome === 'conflict') {
      if (await this.reconciliation.hasSessionDebit(tx, session.id)) {
        this.logger.warn(
          `tx ${session.transactionNo}: mẫu muộn đổi kết luận nhưng đã trừ tiền — giữ reconciled, chỉ ghi record (T13 #19)`,
        );
        return;
      }
      await this.transition(
        tx,
        session,
        'LATE_SAMPLE_CONFLICT',
        ctx.receivedAt,
        `mẫu muộn đổi kết luận đối soát; ${this.frameNote(ctx)}`,
      ); // #19
    }
  }

  private async evaluateSession(ex: DbExecutor, session: SessionRow) {
    const samples = await this.getEnergySeries(ex, session.id);
    return this.reconciliation.evaluate({
      meterStartWh: session.meterStartWh,
      meterStopWh: session.meterStopWh,
      cpStartedAt: session.cpStartedAt,
      cpStoppedAt: session.cpStoppedAt,
      samples,
    });
  }

  /** Mỗi SampledValue một dòng; dedup bằng query vì partition không cho UNIQUE (T11). */
  private async ingestSamples(
    tx: Tx,
    sessionId: number,
    values: MeterValue[],
    ctx: InboundContext,
  ): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const sample of this.flatten(values)) {
      const [dup] = await tx
        .select({ id: meterValues.id })
        .from(meterValues)
        .where(
          and(
            eq(meterValues.sessionId, sessionId),
            eq(meterValues.cpTimestamp, sample.cpTimestamp),
            eq(meterValues.measurand, sample.measurand),
          ),
        )
        .limit(1);
      if (dup) {
        skipped++;
        continue;
      }
      await tx.insert(meterValues).values({
        sessionId,
        cpTimestamp: sample.cpTimestamp,
        receivedAt: ctx.receivedAt,
        measurand: sample.measurand,
        value: sample.value,
        unit: sample.unit,
        context: sample.context,
        phase: sample.phase,
        // Phán quyết ReplayDetector của CẢ frame áp cho mọi mẫu trong frame (BM02 F09).
        replayed: ctx.replay.replayed,
        epoch: ctx.epoch,
      });
      inserted++;
    }
    return { inserted, skipped };
  }

  private flatten(values: MeterValue[]): FlatSample[] {
    const out: FlatSample[] = [];
    for (const mv of values) {
      const cpTimestamp = new Date(mv.timestamp);
      if (Number.isNaN(cpTimestamp.getTime())) continue;
      for (const sv of mv.sampledValue) {
        if (!Number.isFinite(Number(sv.value))) {
          this.logger.warn(
            `SampledValue không phải số: "${sv.value}" (${sv.measurand ?? ENERGY_MEASURAND}) — bỏ qua`,
          );
          continue;
        }
        out.push({
          cpTimestamp,
          // OCPP 1.6: thiếu measurand nghĩa là Energy.Active.Import.Register.
          measurand: sv.measurand ?? ENERGY_MEASURAND,
          value: sv.value,
          unit: sv.unit ?? null,
          context: sv.context ?? null,
          phase: sv.phase ?? null,
        });
      }
    }
    return out;
  }

  private async findConnector(
    chargePointId: number,
    connectorNo: number,
  ): Promise<ConnectorRow | null> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.chargePointId, chargePointId), eq(connectors.connectorNo, connectorNo)),
      )
      .limit(1);
    return row ?? null;
  }

  /** Phiên còn mở gần nhất trên một súng (để StatusNotification biết phiên nào chịu ảnh hưởng). */
  private async findOpenSession(ex: DbExecutor, connectorId: number): Promise<SessionRow | null> {
    const [row] = await ex
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.connectorId, connectorId), inArray(sessions.status, [...OPEN_STATUSES])),
      )
      .orderBy(desc(sessions.receivedStartedAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * ADR-0012 / T13 mục 4: card_kind quyết payment_mode. Thẻ lạ → vẫn mở phiên với
   * payment_mode = unattributed (chưa biết ai thu tiền; migration 0001), ghi unknown_id_tag.
   */
  private async classifyIdTag(
    chargePointId: number,
    idTag: string,
  ): Promise<{
    origin: (typeof sessions.$inferInsert)['origin'];
    paymentMode: (typeof sessions.$inferInsert)['paymentMode'];
    rfidCardId: number | null;
    driverId: number | null;
    unknown: boolean;
  }> {
    const [card] = await this.db
      .select()
      .from(rfidCards)
      .where(eq(rfidCards.cardIdentifier, idTag))
      .limit(1);
    if (card) {
      const paymentMode =
        card.cardKind === 'online'
          ? 'csms_billed'
          : card.cardKind === 'wallet'
            ? 'station_wallet'
            : 'free';
      return {
        origin: card.cardKind === 'free_vend' ? 'free_vend' : 'rfid',
        paymentMode,
        rfidCardId: card.id,
        driverId: card.driverId,
        unknown: false,
      };
    }
    const [cp] = await this.db
      .select({ freeVendTag: chargePoints.freeVendTag })
      .from(chargePoints)
      .where(eq(chargePoints.id, chargePointId))
      .limit(1);
    if (cp?.freeVendTag && cp.freeVendTag === idTag) {
      return {
        origin: 'free_vend',
        paymentMode: 'free',
        rfidCardId: null,
        driverId: null,
        unknown: false,
      };
    }
    return {
      origin: 'rfid',
      paymentMode: 'unattributed',
      rfidCardId: null,
      driverId: null,
      unknown: true,
    };
  }

  private frameRef(action: string, ctx: InboundContext): FrameRef {
    return {
      action,
      cpTimestamp: ctx.cpTimestamp,
      receivedAt: ctx.receivedAt,
      messageLogId: ctx.messageLogId,
    };
  }
}
