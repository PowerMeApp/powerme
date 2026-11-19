/**
 * FaultService — nơi DUY NHẤT ghi `fault_events` (WF-04 xử lý lỗi trụ, STM-6, FE-04).
 *
 * Vì sao tồn tại: WF-04 (docs/WF-04-XU-LY-LOI-TRU.md) biến tín hiệu lỗi của trụ thành một cảnh
 * báo có vòng đời cho operator: raised → acknowledged → resetting → resolved. Trước FE-04,
 * StatusNotification Faulted chỉ được phản chiếu vào `connectors` / `connector_status_events`,
 * không ai ghi `fault_events`. Theo ADR-0016 D-F service này nằm trong `stations`; gateway gọi
 * vào đây, stations KHÔNG import gateway — vì vậy việc GỬI Reset (cần ConnectionRegistry) do
 * người gọi làm (console), service chỉ ghi `remote_commands`, chuyển trạng thái và giữ hẹn giờ:
 *
 *   beginReset() → [người gọi: markSent() → client.call('Reset') → onResetResult()]
 *
 * Bất biến:
 *   - Một sự cố MỞ (status <> resolved) cho mỗi connector; connector 0 = cả trụ (connector_id
 *     null). Tìm sự cố mở bằng SELECT … FOR UPDATE; chỉ mục UNIQUE của migration 0008 là rào cuối.
 *   - Faulted lặp lại → gắn vào sự cố đang mở, GIỮ error_code đầu tiên (mã sau xem ở
 *     connector_status_events). Sự cố do tài xế báo chưa có mã thì nhận mã của Faulted đầu tiên
 *     (T131) để Operator thấy lỗi phần cứng thật.
 *   - Súng về trạng thái hoạt động ({@link RECOVERED_STATUSES}: Available hoặc bắt đầu phục vụ
 *     ngay — Preparing, Charging…) thì kết thúc sự cố (t3/t5/t7). `Unavailable` sau khi trụ khởi
 *     động lại thì chưa (WF-04 câu hỏi 6, T13: Faulted → Unavailable → Available). Sự cố
 *     `driver_report` KHÔNG đóng theo trạng thái nào (BR-P42, quyết định D-G 14/11): chỉ Operator
 *     đóng hoặc t8.
 *     Sự cố OCPP / Offline có báo cáo tài xế gắn kèm tự đóng thì báo cáo chuyển sang sự cố đang mở
 *     của súng (hoặc một `driver_report` mới), nhãn còn nguyên (T141, D-X 17/11).
 *   - Hai đường mở sự cố (OCPP và tài xế báo) khoá dòng connector `FOR NO KEY UPDATE` trước, theo
 *     thứ tự id (T131): đi tuần tự, không deadlock, không rơi sự cố OCPP vì trùng chỉ mục UNIQUE.
 *   - Thời điểm sự cố lấy theo đồng hồ trụ khi frame là bản PHÁT LẠI (`occurredAt`, do gateway
 *     chọn): trụ mất mạng 30 phút rồi gửi lại Faulted lúc 10:05 thì raised_at = 10:05, không phải
 *     lúc CSMS nhận.
 *   - Hẹn giờ chờ Reset nằm trong RAM ({@link Scheduler}); khởi động lại thì quét DB dựng lại
 *     (cùng cách OfflineGraceService của T61).
 *
 * Trụ im lặng quá OFFLINE_ALERT_S (G10, NFR-OCPP-07): {@link FaultService.raiseOffline} /
 * {@link FaultService.resolveOffline}, do OfflineAlertService gọi theo nhịp quét — sự cố cả trụ
 * (connector 0) với error_code `Offline`.
 *
 * Bố cục module (`stations/faults/`): `fault.types.ts` (kiểu, hằng, lỗi — re-export ở đây),
 * `fault-store.ts` (hàm giao dịch dùng chung, thứ tự khoá), `fault-queries.ts` (phía đọc),
 * `driver-report.ts` (tài xế báo lỗi, t8), `fault-state-machine.ts` (STM-6), `error-code-guide.ts`,
 * `offline-alert.service.ts` (quét trụ im lặng). File này giữ API công khai, tín hiệu OCPP, Offline,
 * hành động của Operator và hẹn giờ Reset.
 *
 * Chưa làm (docs/ITERATION-1-WF04.md mục 7): phiếu bảo trì (Should), huỷ đặt chỗ (Should), sự kiện
 * realtime `alert.*`.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../../common/scheduler.js';
import { CONFIG, CsmsConfig, DEFAULT_FAULT_RESET_TIMEOUT_S } from '../../config.js';
import { DB, Db } from '../../db/db.module.js';
import { faultEvents, remoteCommands } from '../../db/schema/index.js';
import { reportFromDriver, sessionCompleted, type DriverReportDeps } from './driver-report.js';
import { OFFLINE_ERROR_CODE } from './error-code-guide.js';
import {
  FaultStateMachine,
  FaultStatus,
  FaultTrigger,
  InvalidFaultTransitionError,
} from './fault-state-machine.js';
import { countFaults, getFault, listFaults, reportsOf } from './fault-queries.js';
import {
  attachWaitingReports,
  clearReports,
  findOpenForUpdate,
  handOverReports,
  lastResolvedAt,
  lockConnectors,
  lockFault,
  resolveConnectorId,
  type HandOver,
} from './fault-store.js';
import {
  eventTime,
  FAULT_RESET_SCHEDULER,
  RECOVERED_STATUSES,
  type BeginResetResult,
  type ConnectorStatusInput,
  type DriverReportResult,
  type FaultListFilter,
  type FaultListItem,
  type ResetOutcome,
  type ResetType,
  type StatusOutcome,
} from './fault.types.js';

export * from './fault.types.js';

/** Trạng thái lệnh `remote_commands` còn chưa có kết quả. */
const IN_FLIGHT = ['pending', 'sent'] as const;

@Injectable()
export class FaultService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FaultService.name);
  private readonly sm = new FaultStateMachine();
  /** faultId → hẹn giờ chờ Reset. */
  private readonly timers = new Map<number, ScheduledTask>();
  private readonly scheduler: Scheduler;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    @Optional() @Inject(FAULT_RESET_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  /** Phụ thuộc truyền cho driver-report.ts. */
  private get deps(): DriverReportDeps {
    return { db: this.db, config: this.config, logger: this.logger };
  }

  /** Hạn chờ Reset hiệu lực (giây). */
  get resetTimeoutS(): number {
    return this.config.faultResetTimeoutS ?? DEFAULT_FAULT_RESET_TIMEOUT_S;
  }

  /** Số hẹn giờ đang chờ (để test / quan sát). */
  get pendingResetCount(): number {
    return this.timers.size;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const s = await this.recoverAfterRestart();
      if (s.timedOut + s.scheduled > 0)
        this.logger.warn(
          `khởi động: ${s.timedOut} sự cố resetting quá hạn → acknowledged, ${s.scheduled} hẹn giờ dựng lại`,
        );
    } catch (err) {
      this.logger.error(`quét sự cố resetting sau khởi động lỗi: ${String(err)}`);
    }
  }

  onApplicationShutdown(): void {
    this.cancelAll();
  }

  /** Huỷ mọi hẹn giờ (Jest không treo "open handles"). */
  cancelAll(): void {
    for (const task of this.timers.values()) task.cancel();
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Tín hiệu từ trụ
  // ---------------------------------------------------------------------------------------------

  /**
   * Gọi SAU khi SessionsService đã phản chiếu StatusNotification (frame của một trụ được tuần tự
   * hoá nên thứ tự an toàn). `Faulted` → t1 hoặc gắn vào sự cố mở; trạng thái hồi phục
   * ({@link RECOVERED_STATUSES}) → kết thúc sự cố mở. `Unavailable` / status lạ: không làm gì.
   *
   * Chống bản phát lại cũ (hàng đợi offline trộn với frame live, EXP-01): frame hồi phục có thời
   * điểm TRƯỚC `raised_at` của sự cố đang mở không đóng sự cố (vd. `Charging` 10:00 phát lại sau
   * khi `Faulted` live 10:30 đã mở sự cố); `Faulted` có thời điểm trước lúc sự cố gần nhất của súng
   * đã đóng không mở lại sự cố cũ. Cả hai trả `stale`, frame vẫn nằm trong log.
   */
  async onConnectorStatus(input: ConnectorStatusInput): Promise<StatusOutcome> {
    if (input.status !== 'Faulted' && !RECOVERED_STATUSES.has(input.status)) {
      return { kind: 'none' };
    }
    const at = eventTime(input);
    const connectorId = await resolveConnectorId(this.db, input.chargePointId, input.connectorNo);
    if (connectorId === undefined) return { kind: 'none' };

    const outcome = await this.db.transaction(async (tx) => {
      await lockConnectors(tx, input.chargePointId, connectorId);
      const open = await findOpenForUpdate(tx, input.chargePointId, connectorId);
      if (input.status === 'Faulted') {
        if (open) {
          this.sm.apply(open.status, 'SIGNAL'); // no-op, ném nếu bảng đổi
          // T131: lỗi phần cứng thật trong lúc đang có sự cố tài xế báo → ghi mã cho Operator thấy.
          const code = input.errorCode;
          if (
            open.source === 'driver_report' &&
            open.errorCode === null &&
            code &&
            code !== 'NoError'
          ) {
            await tx
              .update(faultEvents)
              .set({ errorCode: code })
              .where(eq(faultEvents.id, open.id));
            return { kind: 'attached', faultId: open.id, errorCode: code } as const;
          }
          return { kind: 'attached', faultId: open.id } as const;
        }
        const lastResolved = await lastResolvedAt(tx, input.chargePointId, connectorId);
        if (lastResolved && at < lastResolved) return { kind: 'stale', faultId: null } as const;
        const [row] = await tx
          .insert(faultEvents)
          .values({
            chargePointId: input.chargePointId,
            connectorId,
            source: 'ocpp',
            errorCode: input.errorCode,
            status: this.sm.initial(),
            raisedAt: at,
          })
          .returning({ id: faultEvents.id });
        if (!row) throw new Error('INSERT fault_events không trả id');
        await attachWaitingReports(tx, input.chargePointId, connectorId, row.id, at);
        return { kind: 'raised', faultId: row.id } as const;
      }
      if (!open) return { kind: 'none' } as const;
      // BR-P42 (D-G 14/11, T131): đổi trạng thái súng — kể cả `Available`, trụ khởi động lại — không
      // xoá nhãn "reported issue"; sự cố tài xế báo chỉ đóng khi Operator đóng hoặc t8.
      if (open.source === 'driver_report') return { kind: 'none' } as const;
      if (at < open.raisedAt) return { kind: 'stale', faultId: open.id } as const;
      const step = this.sm.apply(open.status, 'CONNECTOR_AVAILABLE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, open.id));
      const handedOver = await handOverReports(tx, open.id, input.chargePointId, at);
      return {
        kind: 'resolved',
        faultId: open.id,
        from: open.status,
        ...(handedOver.length ? { handedOver } : {}),
      } as const;
    });

    if (outcome.kind === 'resolved') {
      this.clearTimer(outcome.faultId);
      if (outcome.handedOver) this.logHandOver(outcome.faultId, outcome.handedOver);
    }
    if (outcome.kind === 'attached' && 'errorCode' in outcome) {
      this.logger.warn(
        `sự cố #${outcome.faultId} (tài xế báo): trụ ${input.chargePointId} c${input.connectorNo} báo thêm Faulted ${outcome.errorCode}`,
      );
    }
    if (outcome.kind === 'stale') {
      this.logger.warn(
        `trụ ${input.chargePointId} c${input.connectorNo}: bỏ qua ${input.status} phát lại lúc ${at.toISOString()} (cũ hơn trạng thái sự cố hiện tại)`,
      );
    }
    if (outcome.kind === 'raised') {
      this.logger.warn(
        `sự cố #${outcome.faultId} raised: trụ ${input.chargePointId} c${input.connectorNo} ${input.errorCode ?? '?'}`,
      );
    }
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // Trụ im lặng (G10, NFR-OCPP-07) — OfflineAlertService gọi theo nhịp quét
  // ---------------------------------------------------------------------------------------------

  /**
   * t1 cho trụ im lặng quá OFFLINE_ALERT_S: sự cố cả trụ (connector 0, `connector_id` null),
   * `error_code` = {@link OFFLINE_ERROR_CODE}. Đã có sự cố connector 0 đang mở (Faulted cả trụ, hoặc
   * Offline từ lần quét trước) → `SIGNAL` là no-op, trả `attached` — bất biến "một sự cố mở mỗi
   * connector" giữ nguyên.
   *
   * `source = 'ocpp'`: enum `fault_source` chưa có giá trị riêng cho tín hiệu do CSMS tự phát hiện;
   * thêm giá trị mới cần migration + ERD (Ân), nên tạm phân biệt bằng `error_code`.
   */
  async raiseOffline(chargePointId: number, at: Date = new Date()): Promise<StatusOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      await lockConnectors(tx, chargePointId, null);
      const open = await findOpenForUpdate(tx, chargePointId, null);
      if (open) {
        this.sm.apply(open.status, 'SIGNAL'); // no-op, ném nếu bảng đổi
        return { kind: 'attached', faultId: open.id } as const;
      }
      const [row] = await tx
        .insert(faultEvents)
        .values({
          chargePointId,
          connectorId: null,
          source: 'ocpp',
          errorCode: OFFLINE_ERROR_CODE,
          status: this.sm.initial(),
          raisedAt: at,
        })
        .returning({ id: faultEvents.id });
      if (!row) throw new Error('INSERT fault_events không trả id');
      await attachWaitingReports(tx, chargePointId, null, row.id, at);
      return { kind: 'raised', faultId: row.id } as const;
    });
    if (outcome.kind === 'raised') {
      this.logger.warn(`sự cố #${outcome.faultId} raised: trụ ${chargePointId} im lặng (Offline)`);
    }
    return outcome;
  }

  /**
   * Trụ đã nói lại: đóng sự cố `Offline` đang mở bằng `CONNECTOR_AVAILABLE` (t3/t5/t7). Chỉ đụng sự
   * cố còn mở và đúng mã `Offline` — sự cố Faulted cả trụ vẫn chờ StatusNotification hồi phục.
   */
  async resolveOffline(faultId: number, at: Date = new Date()): Promise<'resolved' | 'noop'> {
    const res = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ chargePointId: faultEvents.chargePointId })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId));
      if (!target) return { kind: 'noop' } as const;
      // T141: khoá connector trước rồi mới tới sự cố — cùng thứ tự với báo cáo tài xế (T131).
      await lockConnectors(tx, target.chargePointId, null);
      const [fault] = await tx
        .select({ status: faultEvents.status, errorCode: faultEvents.errorCode })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId))
        .for('update');
      if (!fault || fault.status === 'resolved' || fault.errorCode !== OFFLINE_ERROR_CODE) {
        return { kind: 'noop' } as const;
      }
      const step = this.sm.apply(fault.status, 'CONNECTOR_AVAILABLE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, faultId));
      const handedOver = await handOverReports(tx, faultId, target.chargePointId, at);
      return { kind: 'resolved', handedOver } as const;
    });
    if (res.kind === 'resolved') {
      this.clearTimer(faultId);
      this.logger.log(`sự cố #${faultId} resolved: trụ đã kết nối lại`);
      this.logHandOver(faultId, res.handedOver);
    }
    return res.kind;
  }

  // ---------------------------------------------------------------------------------------------
  // Tài xế báo lỗi (FE-17: UC-CHG-05, BR-P42, Q75–Q81)
  // ---------------------------------------------------------------------------------------------

  /** FE-17 / BR-P42 (Q75–Q81, T131): xem {@link reportFromDriver} trong driver-report.ts. */
  async reportFromDriver(
    driverId: number,
    connectorId: number,
    description: string,
    at: Date = new Date(),
  ): Promise<DriverReportResult> {
    return reportFromDriver(this.deps, driverId, connectorId, description, at);
  }

  /** t8 (BR-P42, Q77, ADR-0019): xem {@link sessionCompleted} trong driver-report.ts. */
  async onSessionCompleted(transactionNo: number): Promise<'resolved' | 'none'> {
    return sessionCompleted(this.deps, transactionNo);
  }

  /** Báo cáo của tài xế gắn vào một sự cố (F-05: Operator thấy nội dung). */
  async reportsOf(faultId: number) {
    return reportsOf(this.db, faultId);
  }

  // ---------------------------------------------------------------------------------------------
  // Hành động của operator
  // ---------------------------------------------------------------------------------------------

  /** t2 raised → acknowledged. `operatorId` = operator_staff.user_id; null khi chưa có đăng nhập. */
  async acknowledge(faultId: number, operatorId: number | null, at: Date = new Date()) {
    return this.db.transaction(async (tx) => {
      const fault = await lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'ACKNOWLEDGE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, acknowledgedBy: operatorId, acknowledgedAt: at })
        .where(eq(faultEvents.id, faultId));
      return { id: faultId, status: step.to };
    });
  }

  /**
   * t4 acknowledged → resetting: ghi lệnh Reset (pending) và gắn vào sự cố, rồi hẹn giờ chờ.
   * Người gọi gửi CALL thật và báo kết quả bằng {@link markSent} + {@link onResetResult}.
   */
  async beginReset(
    faultId: number,
    opts: { type: ResetType; requestedBy: number | null; at?: Date; force?: boolean },
  ): Promise<BeginResetResult> {
    const at = opts.at ?? new Date();
    const result = await this.db.transaction(async (tx) => {
      const fault = await lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'RESET_SENT');
      const [cmd] = await tx
        .insert(remoteCommands)
        .values({
          chargePointId: fault.chargePointId,
          action: 'Reset',
          payload: opts.force ? { type: opts.type, force: true } : { type: opts.type },
          status: 'pending',
          requestedBy: opts.requestedBy,
          requestedAt: at,
        })
        .returning({ id: remoteCommands.id });
      if (!cmd) throw new Error('INSERT remote_commands không trả id');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resetCommandId: cmd.id })
        .where(eq(faultEvents.id, faultId));
      return { faultId, commandId: cmd.id, serial: fault.serial };
    });
    this.armTimer(result.faultId, result.commandId, this.resetTimeoutS * 1000);
    return result;
  }

  /** Lệnh sắp được gửi qua socket: pending → sent. */
  async markSent(commandId: number, at: Date = new Date()): Promise<void> {
    await this.db
      .update(remoteCommands)
      .set({ status: 'sent', sentAt: at })
      .where(and(eq(remoteCommands.id, commandId), eq(remoteCommands.status, 'pending')));
  }

  /**
   * Kết quả CALL Reset. Accepted: chỉ ghi lệnh — sự cố vẫn `resetting` chờ súng hoạt động lại hoặc
   * hết hạn. Rejected / lỗi gửi: ghi lệnh và t6 resetting → acknowledged.
   * Kết quả tới muộn của một lệnh không còn gắn với sự cố đang `resetting` thì chỉ ghi lệnh.
   */
  async onResetResult(
    commandId: number,
    outcome: ResetOutcome,
    at: Date = new Date(),
  ): Promise<{ faultId: number | null; faultStatus: FaultStatus | null }> {
    const failed = 'error' in outcome || outcome.status === 'Rejected';
    const res = await this.db.transaction(async (tx) => {
      const [cmd] = await tx
        .select({ status: remoteCommands.status, sentAt: remoteCommands.sentAt })
        .from(remoteCommands)
        .where(eq(remoteCommands.id, commandId))
        .for('update');
      if (!cmd) throw new Error(`Không có remote_commands id=${commandId}`);
      if ((IN_FLIGHT as readonly string[]).includes(cmd.status)) {
        const sentAt = cmd.sentAt ?? at;
        await tx
          .update(remoteCommands)
          .set(
            'error' in outcome
              ? { status: 'failed', sentAt, respondedAt: at, error: outcome.error }
              : {
                  status: outcome.status === 'Accepted' ? 'accepted' : 'rejected',
                  sentAt,
                  respondedAt: at,
                  response: outcome.response ?? { status: outcome.status },
                },
          )
          .where(eq(remoteCommands.id, commandId));
      }
      const [fault] = await tx
        .select({ id: faultEvents.id, status: faultEvents.status })
        .from(faultEvents)
        .where(eq(faultEvents.resetCommandId, commandId))
        .for('update');
      if (!fault) return { faultId: null, faultStatus: null, changed: false };
      if (!failed || fault.status !== 'resetting') {
        return { faultId: fault.id, faultStatus: fault.status, changed: false };
      }
      const step = this.sm.apply(fault.status, 'RESET_FAILED');
      await tx.update(faultEvents).set({ status: step.to }).where(eq(faultEvents.id, fault.id));
      return { faultId: fault.id, faultStatus: step.to, changed: true };
    });
    if (res.changed && res.faultId !== null) this.clearTimer(res.faultId);
    return { faultId: res.faultId, faultStatus: res.faultStatus };
  }

  /**
   * Hết hạn chờ Reset (t6). Chỉ áp khi sự cố còn `resetting` VỚI ĐÚNG lệnh này; lệnh chưa có kết
   * quả thì thành `timeout` (lệnh đã Accepted giữ nguyên — trụ nhận lệnh nhưng lỗi chưa hết).
   * Public để test và quét khởi động gọi thẳng.
   */
  async onResetTimeout(faultId: number, commandId: number): Promise<'timed_out' | 'noop'> {
    this.timers.delete(faultId);
    return this.db.transaction(async (tx) => {
      const [fault] = await tx
        .select({ status: faultEvents.status, resetCommandId: faultEvents.resetCommandId })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId))
        .for('update');
      if (!fault || fault.status !== 'resetting' || fault.resetCommandId !== commandId) {
        return 'noop';
      }
      const step = this.sm.apply(fault.status, 'RESET_FAILED');
      await tx.update(faultEvents).set({ status: step.to }).where(eq(faultEvents.id, faultId));
      await tx
        .update(remoteCommands)
        .set({ status: 'timeout', error: `Hết hạn chờ ${this.resetTimeoutS} s` })
        .where(
          and(
            eq(remoteCommands.id, commandId),
            sql`${remoteCommands.status} IN ('pending', 'sent')`,
          ),
        );
      this.logger.warn(`sự cố #${faultId}: Reset hết hạn chờ → acknowledged`);
      return 'timed_out';
    });
  }

  /** t7 acknowledged → resolved bằng OPERATOR_CLOSE (sau khi kiểm tra tại chỗ). */
  async close(faultId: number, operatorId: number | null, at: Date = new Date()) {
    const res = await this.db.transaction(async (tx) => {
      const fault = await lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'OPERATOR_CLOSE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, faultId));
      await clearReports(tx, faultId, at, operatorId);
      return { id: faultId, status: step.to };
    });
    // fault_events chưa có cột "ai đóng" — chỉ vào log (ITERATION-1-WF04 câu hỏi mở).
    this.logger.log(`sự cố #${faultId} đóng bởi operator ${operatorId ?? 'console'}`);
    this.clearTimer(faultId);
    return res;
  }

  // ---------------------------------------------------------------------------------------------
  // Đọc
  // ---------------------------------------------------------------------------------------------

  /** Danh sách cảnh báo theo thứ tự D39 — xem {@link listFaults} trong fault-queries.ts. */
  async list(
    filter: FaultListFilter,
    limit: number,
    operatorId?: number,
    offset = 0,
    chargePointId?: number,
  ): Promise<FaultListItem[]> {
    return listFaults(this.db, filter, limit, operatorId, offset, chargePointId);
  }

  /** Rows `list` would page through (same filter and Operator scope), for the pager's total. */
  async count(
    filter: FaultListFilter,
    operatorId?: number,
    chargePointId?: number,
  ): Promise<number> {
    return countFaults(this.db, filter, operatorId, chargePointId);
  }

  /** Một sự cố (không khoá); sự cố của Operator khác → FaultNotFoundError (404). */
  async get(faultId: number, operatorId?: number) {
    return getFault(this.db, faultId, operatorId);
  }

  /** Trigger có áp được cho trạng thái hiện tại không (để trả 409 trước khi đụng tới trụ). */
  canApply(status: FaultStatus, trigger: FaultTrigger): boolean {
    return this.sm.canApply(status, trigger);
  }

  // ---------------------------------------------------------------------------------------------
  // Phục hồi sau khởi động
  // ---------------------------------------------------------------------------------------------

  /**
   * Hẹn giờ trong RAM đã mất: với mỗi sự cố `resetting`, mốc là `remote_commands.requested_at`
   * của lệnh đang chờ. Quá hạn → t6 ngay; chưa quá → hẹn giờ cho phần còn lại.
   */
  async recoverAfterRestart(
    now: Date = new Date(),
  ): Promise<{ timedOut: number; scheduled: number }> {
    const rows = await this.db
      .select({
        id: faultEvents.id,
        commandId: faultEvents.resetCommandId,
        requestedAt: remoteCommands.requestedAt,
      })
      .from(faultEvents)
      .leftJoin(remoteCommands, eq(remoteCommands.id, faultEvents.resetCommandId))
      .where(eq(faultEvents.status, 'resetting'));
    const summary = { timedOut: 0, scheduled: 0 };
    const timeoutMs = this.resetTimeoutS * 1000;
    for (const r of rows) {
      if (r.commandId === null) {
        // Dữ liệu trước migration 0008 / sửa tay: không biết lệnh nào → coi như hết hạn.
        await this.db
          .update(faultEvents)
          .set({ status: this.sm.apply('resetting', 'RESET_FAILED').to })
          .where(and(eq(faultEvents.id, r.id), eq(faultEvents.status, 'resetting')));
        summary.timedOut += 1;
        continue;
      }
      const elapsed = now.getTime() - (r.requestedAt ?? now).getTime();
      if (elapsed >= timeoutMs) {
        if ((await this.onResetTimeout(r.id, r.commandId)) === 'timed_out') {
          summary.timedOut += 1;
        }
      } else {
        this.armTimer(r.id, r.commandId, timeoutMs - elapsed);
        summary.scheduled += 1;
      }
    }
    return summary;
  }

  // ---------------------------------------------------------------------------------------------
  // Nội bộ
  // ---------------------------------------------------------------------------------------------

  private armTimer(faultId: number, commandId: number, delayMs: number): void {
    this.clearTimer(faultId);
    const task = this.scheduler.schedule(delayMs, () => {
      this.onResetTimeout(faultId, commandId).catch((err: unknown) =>
        this.logger.error(`hết hạn Reset sự cố #${faultId} lỗi: ${String(err)}`),
      );
    });
    this.timers.set(faultId, task);
  }

  private clearTimer(faultId: number): void {
    this.timers.get(faultId)?.cancel();
    this.timers.delete(faultId);
  }

  private logHandOver(faultId: number, moved: HandOver[]): void {
    for (const m of moved)
      this.logger.warn(
        `sự cố #${faultId} đóng, ${m.reports} báo cáo tài xế chuyển sang sự cố #${m.toFaultId}${m.created ? ' (driver_report mới)' : ''} (BR-P42)`,
      );
  }
}

export { InvalidFaultTransitionError };
