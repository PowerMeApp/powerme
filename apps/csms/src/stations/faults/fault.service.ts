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

const IN_FLIGHT = ['pending', 'sent'] as const;

@Injectable()
export class FaultService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FaultService.name);
  private readonly sm = new FaultStateMachine();
  private readonly timers = new Map<number, ScheduledTask>();
  private readonly scheduler: Scheduler;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    @Optional() @Inject(FAULT_RESET_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  private get deps(): DriverReportDeps {
    return { db: this.db, config: this.config, logger: this.logger };
  }

  get resetTimeoutS(): number {
    return this.config.faultResetTimeoutS ?? DEFAULT_FAULT_RESET_TIMEOUT_S;
  }

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

  cancelAll(): void {
    for (const task of this.timers.values()) task.cancel();
    this.timers.clear();
  }

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
          this.sm.apply(open.status, 'SIGNAL');
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

  async resolveOffline(faultId: number, at: Date = new Date()): Promise<'resolved' | 'noop'> {
    const res = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ chargePointId: faultEvents.chargePointId })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId));
      if (!target) return { kind: 'noop' } as const;
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

  async reportFromDriver(
    driverId: number,
    connectorId: number,
    description: string,
    at: Date = new Date(),
  ): Promise<DriverReportResult> {
    return reportFromDriver(this.deps, driverId, connectorId, description, at);
  }

  async onSessionCompleted(transactionNo: number): Promise<'resolved' | 'none'> {
    return sessionCompleted(this.deps, transactionNo);
  }

  async reportsOf(faultId: number) {
    return reportsOf(this.db, faultId);
  }

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

  async markSent(commandId: number, at: Date = new Date()): Promise<void> {
    await this.db
      .update(remoteCommands)
      .set({ status: 'sent', sentAt: at })
      .where(and(eq(remoteCommands.id, commandId), eq(remoteCommands.status, 'pending')));
  }

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
    this.logger.log(`sự cố #${faultId} đóng bởi operator ${operatorId ?? 'console'}`);
    this.clearTimer(faultId);
    return res;
  }

  async list(
    filter: FaultListFilter,
    limit: number,
    operatorId?: number,
    offset = 0,
    chargePointId?: number,
  ): Promise<FaultListItem[]> {
    return listFaults(this.db, filter, limit, operatorId, offset, chargePointId);
  }

  async count(
    filter: FaultListFilter,
    operatorId?: number,
    chargePointId?: number,
  ): Promise<number> {
    return countFaults(this.db, filter, operatorId, chargePointId);
  }

  async get(faultId: number, operatorId?: number) {
    return getFault(this.db, faultId, operatorId);
  }

  canApply(status: FaultStatus, trigger: FaultTrigger): boolean {
    return this.sm.canApply(status, trigger);
  }

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
