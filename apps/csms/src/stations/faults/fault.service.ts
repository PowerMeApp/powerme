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
 *     connector_status_events).
 *   - Súng về trạng thái hoạt động ({@link RECOVERED_STATUSES}: Available hoặc bắt đầu phục vụ
 *     ngay — Preparing, Charging…) thì kết thúc sự cố (t3/t5/t7). `Unavailable` sau khi trụ khởi
 *     động lại thì chưa (WF-04 câu hỏi 6, T13: Faulted → Unavailable → Available).
 *   - Thời điểm sự cố lấy theo đồng hồ trụ khi frame là bản PHÁT LẠI (`occurredAt`, do gateway
 *     chọn): trụ mất mạng 30 phút rồi gửi lại Faulted lúc 10:05 thì raised_at = 10:05, không phải
 *     lúc CSMS nhận.
 *   - Hẹn giờ chờ Reset nằm trong RAM ({@link Scheduler}); khởi động lại thì quét DB dựng lại
 *     (cùng cách OfflineGraceService của T61).
 *
 * Chưa làm ở Iteration 1 (docs/ITERATION-1-WF04.md mục 7): báo lỗi từ app tài xế (chưa có API),
 * phiếu bảo trì (Should), ẩn súng + huỷ đặt chỗ (Should), cảnh báo trụ im lặng quá 900 s (G19),
 * sự kiện realtime `alert.*`.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, isNull, ne, SQL, sql, SQLWrapper } from 'drizzle-orm';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../../common/scheduler.js';
import { CONFIG, CsmsConfig, DEFAULT_FAULT_RESET_TIMEOUT_S } from '../../config.js';
import { DB, Db, DbExecutor } from '../../db/db.module.js';
import { chargePoints, connectors, faultEvents, remoteCommands } from '../../db/schema/index.js';
import {
  CHARGE_POINT_ERROR_CODES,
  ERROR_CODE_GUIDE,
  FaultSeverity,
  guideFor,
  severityRank,
} from './error-code-guide.js';
import {
  FaultStateMachine,
  FaultStatus,
  FaultTrigger,
  InvalidFaultTransitionError,
} from './fault-state-machine.js';

export const FAULT_RESET_SCHEDULER = Symbol('FAULT_RESET_SCHEDULER');

export type ResetType = 'Soft' | 'Hard';

/** Không có sự cố với id này. */
export class FaultNotFoundError extends Error {
  constructor(readonly faultId: number) {
    super(`Không có sự cố id=${faultId}`);
    this.name = 'FaultNotFoundError';
  }
}

/** Việc FaultService đã làm với một StatusNotification. */
export type StatusOutcome =
  | { kind: 'raised'; faultId: number }
  | { kind: 'attached'; faultId: number }
  | { kind: 'resolved'; faultId: number; from: FaultStatus }
  | { kind: 'none' };

export interface ConnectorStatusInput {
  chargePointId: number;
  /** connectorId của OCPP: 0 = cả trụ. */
  connectorNo: number;
  status: string;
  errorCode: string | null;
  receivedAt: Date;
  /**
   * Lúc sự việc xảy ra: đồng hồ trụ (`timestamp` trong payload) nếu frame là bản phát lại, ngược
   * lại `receivedAt` (ADR-0009: received_at là đồng hồ tin cậy cho frame live). Ghi raised_at /
   * resolved_at. Bỏ trống = `receivedAt`.
   */
  occurredAt?: Date;
}

/**
 * Trạng thái súng coi là ĐÃ HỒI PHỤC (trigger CONNECTOR_AVAILABLE của STM-6). OCPP 1.6 cho súng
 * thoát Faulted sang bất kỳ trạng thái nào (bảng I1…I8, `valid-transitions.ts`): lỗi tự hết rồi tài
 * xế cắm sạc luôn thì súng đi Faulted → Preparing → Charging, không qua Available. `Unavailable`
 * KHÔNG nằm đây: đó là bước giữa lúc trụ khởi động lại (T13 2.3 #14), lỗi có thể vẫn còn.
 */
export const RECOVERED_STATUSES: ReadonlySet<string> = new Set([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
]);

export interface BeginResetResult {
  faultId: number;
  commandId: number;
  serial: string;
}

/** Kết quả CALL Reset do người gọi báo lại. */
export type ResetOutcome =
  { status: 'Accepted' | 'Rejected'; response?: unknown } | { error: string };

/** Một dòng của danh sách cảnh báo (console, sau này dashboard FE-04). */
export interface FaultListItem {
  id: number;
  eventNo: number;
  serial: string;
  connectorNo: number | null;
  source: string;
  errorCode: string | null;
  severity: FaultSeverity;
  hint: string;
  status: FaultStatus;
  raisedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resetCommandId: number | null;
  resetCommandStatus: string | null;
  isOnline: boolean;
}

/**
 * `CASE error_code WHEN 'GroundFailure' THEN 0 … ELSE <hạng của OtherError> END` — hạng nặng nhẹ của
 * ErrorCodeGuide đưa vào ORDER BY để sắp trước LIMIT. Mã và số đều là hằng của bảng tĩnh (không
 * phải dữ liệu người dùng) nên ghép thẳng vào SQL.
 */
function severityRankSql(column: SQLWrapper): SQL {
  const whens = CHARGE_POINT_ERROR_CODES.map((code) =>
    sql.raw(`WHEN '${code}' THEN ${severityRank(ERROR_CODE_GUIDE[code].severity)}`),
  );
  return sql`CASE ${column} ${sql.join(whens, sql` `)} ELSE ${sql.raw(String(severityRank(guideFor(null).severity)))} END`;
}

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
   */
  async onConnectorStatus(input: ConnectorStatusInput): Promise<StatusOutcome> {
    if (input.status !== 'Faulted' && !RECOVERED_STATUSES.has(input.status)) {
      return { kind: 'none' };
    }
    const at = input.occurredAt ?? input.receivedAt;
    const connectorId = await this.resolveConnectorId(input.chargePointId, input.connectorNo);
    if (connectorId === undefined) return { kind: 'none' };

    const outcome = await this.db.transaction(async (tx) => {
      const open = await this.findOpenForUpdate(tx, input.chargePointId, connectorId);
      if (input.status === 'Faulted') {
        if (open) {
          this.sm.apply(open.status, 'SIGNAL'); // no-op, ném nếu bảng đổi
          return { kind: 'attached', faultId: open.id } as const;
        }
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
        return { kind: 'raised', faultId: row.id } as const;
      }
      if (!open) return { kind: 'none' } as const;
      const step = this.sm.apply(open.status, 'CONNECTOR_AVAILABLE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, open.id));
      return { kind: 'resolved', faultId: open.id, from: open.status } as const;
    });

    if (outcome.kind === 'resolved') this.clearTimer(outcome.faultId);
    if (outcome.kind === 'raised') {
      this.logger.warn(
        `sự cố #${outcome.faultId} raised: trụ ${input.chargePointId} c${input.connectorNo} ${input.errorCode ?? '?'}`,
      );
    }
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // Hành động của operator
  // ---------------------------------------------------------------------------------------------

  /** t2 raised → acknowledged. `operatorId` = operator_staff.user_id; null khi chưa có đăng nhập. */
  async acknowledge(faultId: number, operatorId: number | null, at: Date = new Date()) {
    return this.db.transaction(async (tx) => {
      const fault = await this.lockFault(tx, faultId);
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
      const fault = await this.lockFault(tx, faultId);
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
   * Kết quả CALL Reset. Accepted: chỉ ghi lệnh — sự cố vẫn `resetting` chờ súng Available hoặc
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
      const fault = await this.lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'OPERATOR_CLOSE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, faultId));
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

  /**
   * Danh sách cảnh báo: sự cố mở trước, nặng trước, mới trước — sắp XẾP TRONG SQL rồi mới LIMIT, để
   * 25 lỗi nhẹ mới hơn không đẩy một lỗi nghiêm trọng cũ ra khỏi trang (review #61).
   */
  async list(filter: 'open' | 'all', limit: number): Promise<FaultListItem[]> {
    const rows = await this.db
      .select({
        id: faultEvents.id,
        eventNo: faultEvents.eventNo,
        serial: chargePoints.serialNumber,
        connectorNo: connectors.connectorNo,
        source: faultEvents.source,
        errorCode: faultEvents.errorCode,
        status: faultEvents.status,
        raisedAt: faultEvents.raisedAt,
        acknowledgedAt: faultEvents.acknowledgedAt,
        resolvedAt: faultEvents.resolvedAt,
        resetCommandId: faultEvents.resetCommandId,
        resetCommandStatus: remoteCommands.status,
        isOnline: chargePoints.isOnline,
      })
      .from(faultEvents)
      .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
      .leftJoin(connectors, eq(connectors.id, faultEvents.connectorId))
      .leftJoin(remoteCommands, eq(remoteCommands.id, faultEvents.resetCommandId))
      .where(filter === 'open' ? ne(faultEvents.status, 'resolved') : undefined)
      .orderBy(
        sql`(${faultEvents.status} = 'resolved')`,
        severityRankSql(faultEvents.errorCode),
        desc(faultEvents.raisedAt),
        desc(faultEvents.id),
      )
      .limit(limit);
    return rows.map((r) => {
      const g = guideFor(r.errorCode);
      return {
        ...r,
        connectorNo: r.connectorNo ?? (r.source === 'ocpp' ? 0 : null),
        severity: g.severity,
        hint: g.hint,
      };
    });
  }

  /** Một sự cố (không khoá) — để người gọi kiểm trước khi gửi lệnh. */
  async get(faultId: number) {
    const [row] = await this.db
      .select({
        id: faultEvents.id,
        status: faultEvents.status,
        chargePointId: faultEvents.chargePointId,
        serial: chargePoints.serialNumber,
      })
      .from(faultEvents)
      .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
      .where(eq(faultEvents.id, faultId));
    if (!row) throw new FaultNotFoundError(faultId);
    return row;
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

  /** connectors.id; null cho connector 0 (cả trụ); undefined khi trụ không có súng số này. */
  private async resolveConnectorId(
    chargePointId: number,
    connectorNo: number,
  ): Promise<number | null | undefined> {
    if (connectorNo === 0) return null;
    const [row] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(eq(connectors.chargePointId, chargePointId), eq(connectors.connectorNo, connectorNo)),
      );
    return row?.id;
  }

  private async findOpenForUpdate(
    tx: DbExecutor,
    chargePointId: number,
    connectorId: number | null,
  ) {
    const [row] = await tx
      .select({ id: faultEvents.id, status: faultEvents.status })
      .from(faultEvents)
      .where(
        and(
          eq(faultEvents.chargePointId, chargePointId),
          connectorId === null
            ? isNull(faultEvents.connectorId)
            : eq(faultEvents.connectorId, connectorId),
          ne(faultEvents.status, 'resolved'),
        ),
      )
      .for('update');
    return row;
  }

  private async lockFault(tx: DbExecutor, faultId: number) {
    const [row] = await tx
      .select({
        id: faultEvents.id,
        status: faultEvents.status,
        chargePointId: faultEvents.chargePointId,
        serial: chargePoints.serialNumber,
      })
      .from(faultEvents)
      .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
      .where(eq(faultEvents.id, faultId))
      .for('update', { of: faultEvents });
    if (!row) throw new FaultNotFoundError(faultId);
    return row;
  }
}

export { InvalidFaultTransitionError };
