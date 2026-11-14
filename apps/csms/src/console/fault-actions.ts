/**
 * FaultActions — Operator actions on a FaultEvent (WF-04, STM-6): list, acknowledge (t2), Reset
 * (t4 + the OCPP Reset CALL), close (t7). One module shared by the dev console (`/api/admin/faults*`)
 * and the operator API (`/api/operator/v1/faults*`, D37), so both apply the same checks.
 *
 * FaultService (module stations) owns the fault state; the Reset CALL is sent here through
 * ConnectionRegistry because stations may not import the gateway (ADR-0016 D-F).
 *
 * `actor` is the signed-in staff user (operator API) or null (dev console, no login): it fills
 * `fault_events.acknowledged_by` and `remote_commands.requested_by`.
 *
 * Errors are {@link FaultActionError} (transport-neutral); each HTTP surface maps them to its own
 * error body: 404 FaultEvent unknown · 409 state does not allow it, charge point offline, another
 * Reset pending, or sessions charging beside the fault (unless `force`) · 502 charge point answered
 * badly or not at all · 503 FaultService not loaded.
 */
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { connectors, faultEvents, sessions } from '../db/schema/index.js';
import type { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import {
  FaultNotFoundError,
  FaultListFilter,
  FaultService,
  InvalidFaultTransitionError,
  ResetType,
} from '../stations/faults/fault.service.js';
import type { FaultStatus, FaultTrigger } from '../stations/faults/fault-state-machine.js';

/** Who acts: `operator_staff.user_id` and that staff's Operator (from the token, BR-P16). */
export interface FaultActor {
  userId: number;
  operatorId: number;
}

export class FaultActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    /** Extra fields for the error body, e.g. `sessions` on 409 `sessions_active` (D40). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail);
  }
}

export interface ResetResult {
  fault_id: number;
  command_id: number;
  serial: string;
  reset_status: 'Accepted' | 'Rejected';
  fault_status: string | null;
  forced: boolean;
}

/**
 * Sessions a Reset (always the WHOLE charge point in OCPP 1.6) would cut: delivering energy, about
 * to start (`pending` — RemoteStart Accepted, driver about to plug in), or `orphaned` — reconnected
 * but no live message yet (STM-1 #18), so it may still be charging. An old orphaned session (24 h
 * cap) blocks too: the operator sees it in the 409 and uses `force`.
 */
const CHARGING = ['pending', 'active', 'paused', 'stopping', 'orphaned'] as const;
const RESET_CALL_TIMEOUT_MS = 15_000;
const OPERATOR_TRIGGERS = [
  ['acknowledge', 'ACKNOWLEDGE'],
  ['reset', 'RESET_SENT'],
  ['close', 'OPERATOR_CLOSE'],
] as const satisfies readonly (readonly [string, FaultTrigger])[];

export class FaultActions {
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectionRegistry,
    private readonly faultService?: FaultService,
  ) {}

  /** STM-6 transitions an Operator may trigger from `status` (D38: t2, t4, t7). */
  allowedActions(status: FaultStatus): ('acknowledge' | 'reset' | 'close')[] {
    const faults = this.requireFaults();
    return OPERATOR_TRIGGERS.filter(([, trigger]) => faults.canApply(status, trigger)).map(
      ([action]) => action,
    );
  }

  /** How long a Reset waits for the connector to recover (t5) before t6. */
  get resetTimeoutS(): number {
    return this.requireFaults().resetTimeoutS;
  }

  /** With an actor: only FaultEvents of that staff's Operator (BR-P11, BR-P16, D3). */
  async list(filter: FaultListFilter, limit: number, actor: FaultActor | null = null, offset = 0) {
    return this.requireFaults().list(filter, limit, actor?.operatorId, offset);
  }

  /** Total rows behind `list` for the same filter and actor (screen 21 pager). */
  async count(filter: FaultListFilter, actor: FaultActor | null = null) {
    return this.requireFaults().count(filter, actor?.operatorId);
  }

  /** t2. */
  async acknowledge(id: number, actor: FaultActor | null) {
    const faults = this.requireFaults();
    return this.mapFaultErrors(async () => {
      await this.ownFault(faults, id, actor);
      return faults.acknowledge(id, actor?.userId ?? null);
    });
  }

  /** t7 OPERATOR_CLOSE. */
  async close(id: number, actor: FaultActor | null) {
    const faults = this.requireFaults();
    return this.mapFaultErrors(async () => {
      await this.ownFault(faults, id, actor);
      return faults.close(id, actor?.userId ?? null);
    });
  }

  /** 404 when the FaultEvent is not on the actor's Operator's charge points (D37). */
  private async ownFault(faults: FaultService, id: number, actor: FaultActor | null) {
    if (actor) await faults.get(id, actor.operatorId);
  }

  /**
   * t4 then the Reset CALL. Checked first (nothing written): the fault must be `acknowledged`, the
   * charge point connected, and no session charging on ANOTHER connector — an OCPP 1.6 Reset
   * reboots the whole charge point, so a driver next door would be cut off without notice (review
   * #61, BR-P07 "communicated downtime"). The operator confirms a second time and sends `force`; the
   * command then records `payload.force = true`. A session on the faulted connector itself does not
   * count: WF-04 step 1 already closed it (StopTransaction reason Other).
   * Accepted → the fault stays `resetting` until the connector recovers or the wait expires;
   * Rejected → `acknowledged` (t6); no valid answer → command `failed`, fault `acknowledged`, 502.
   */
  async reset(
    id: number,
    type: ResetType,
    force: boolean,
    actor: FaultActor | null,
  ): Promise<ResetResult> {
    const faults = this.requireFaults();
    const fault = await this.mapFaultErrors(() => faults.get(id, actor?.operatorId));
    if (!faults.canApply(fault.status, 'RESET_SENT')) {
      throw new FaultActionError(
        409,
        'fault_not_acknowledged',
        `Sự cố đang ở trạng thái ${fault.status}; chỉ Reset được khi đã acknowledged`,
      );
    }
    const conn = this.registry.get(fault.serial);
    if (!conn) {
      throw new FaultActionError(409, 'station_offline', `Trụ ${fault.serial} đang offline`);
    }
    // Another fault on the same charge point is waiting for its Reset: the charge point is (or is
    // about to be) rebooting — a second Reset mid-reboot only muddles the first one's result.
    const [busy] = await this.db
      .select({ id: faultEvents.id })
      .from(faultEvents)
      .where(
        and(
          eq(faultEvents.chargePointId, fault.chargePointId),
          eq(faultEvents.status, 'resetting'),
          ne(faultEvents.id, id),
        ),
      )
      .limit(1);
    if (busy) {
      throw new FaultActionError(
        409,
        'reset_in_progress',
        `Trụ ${fault.serial} đang chờ kết quả Reset của sự cố #${busy.id}; đợi xong rồi thử lại`,
      );
    }
    const charging = await this.chargingSessionsBesideFault(id);
    if (charging.length > 0 && !force) {
      const list = charging.map((s) => `súng ${s.connectorNo} (phiên ${s.sessionId})`).join(', ');
      throw new FaultActionError(
        409,
        'sessions_active',
        `Trụ ${fault.serial} đang có phiên sạc ở ${list}; Reset sẽ cắt các phiên này. Gửi lại với force=true nếu chắc chắn.`,
        {
          sessions: charging.map((s) => ({
            connector_no: s.connectorNo,
            session_id: String(s.sessionId),
          })),
        },
      );
    }
    const begun = await this.mapFaultErrors(() =>
      faults.beginReset(id, {
        type,
        requestedBy: actor?.userId ?? null,
        force: charging.length > 0,
      }),
    );
    await faults.markSent(begun.commandId);
    let reply: unknown;
    try {
      reply = await conn.client.call('Reset', { type }, { timeoutMs: RESET_CALL_TIMEOUT_MS });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await faults.onResetResult(begun.commandId, { error: detail });
      throw new FaultActionError(
        502,
        'station_error',
        `Trụ ${fault.serial} không trả lời Reset hợp lệ: ${detail}`,
      );
    }
    const status = (reply as { status?: unknown } | null)?.status;
    if (status !== 'Accepted' && status !== 'Rejected') {
      await faults.onResetResult(begun.commandId, { error: 'status lạ trong Reset.conf' });
      throw new FaultActionError(502, 'station_error', `Trụ ${fault.serial} trả status lạ`);
    }
    const result = await faults.onResetResult(begun.commandId, { status, response: reply });
    return {
      fault_id: id,
      command_id: begun.commandId,
      serial: fault.serial,
      reset_status: status,
      fault_status: result.faultStatus,
      forced: charging.length > 0,
    };
  }

  /**
   * Sessions charging on the fault's charge point, except on the fault's own connector. A
   * connector-0 fault (whole charge point, connector_id null) counts every session.
   */
  private async chargingSessionsBesideFault(
    faultId: number,
  ): Promise<{ sessionId: number; connectorNo: number }[]> {
    return this.db
      .select({ sessionId: sessions.id, connectorNo: connectors.connectorNo })
      .from(faultEvents)
      .innerJoin(sessions, eq(sessions.chargePointId, faultEvents.chargePointId))
      .innerJoin(connectors, eq(connectors.id, sessions.connectorId))
      .where(
        and(
          eq(faultEvents.id, faultId),
          inArray(sessions.status, [...CHARGING]),
          or(isNull(faultEvents.connectorId), ne(sessions.connectorId, faultEvents.connectorId)),
        ),
      )
      .orderBy(connectors.connectorNo);
  }

  private requireFaults(): FaultService {
    if (!this.faultService) {
      throw new FaultActionError(503, 'faults_unavailable', 'FaultService chưa được nạp');
    }
    return this.faultService;
  }

  /** FaultService domain errors → HTTP codes. */
  private async mapFaultErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FaultNotFoundError)
        throw new FaultActionError(404, 'not_found', err.message);
      if (err instanceof InvalidFaultTransitionError) {
        throw new FaultActionError(409, 'invalid_transition', err.message);
      }
      throw err;
    }
  }
}
