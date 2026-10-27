import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { CHARGE_POLICY, ChargeSettlementService } from './charge-settlement.service.js';
import { ChargePolicy, startCreditPolicy, validateChargePolicy } from './charge-start-policy.js';
import { chargeTransaction } from './charge-sql.js';
import { SessionStateMachine, SessionStatus } from './session-state-machine.js';

import { ChargingError } from './charging-error.js';
import { searchStations, StationSearchInput } from './station-search.js';
export { ChargingError } from './charging-error.js';

export interface EnergyStartInput {
  connectorId: number;
  vehicleId: number;
  energyLimitWh: number;
  mode: 'energy_kwh';
}
export interface ChargeSnapshot {
  intentId: number;
  commandId: number | null;
  sessionId: number | null;
  outcome: string;
  effectConfirmed: boolean;
  version: number;
  maxEnergyWh: number | null;
}
interface Intent {
  id: string;
  command_id: string | null;
  session_id: string | null;
  state: string;
  version: number;
  request_hash: string;
  rejection_reason: string | null;
  max_energy_wh: string | null;
  session_status?: string | null;
}

@Injectable()
export class DriverChargingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ConnectionRegistry,
    private readonly settlement: ChargeSettlementService,
    @Optional() @Inject(CHARGE_POLICY) private readonly policy?: ChargePolicy,
  ) {
    if (policy) validateChargePolicy(policy);
  }

  // WP3/T31: energy-only start; oversized requests require explicit consent to the offered cap.
  async start(driverId: number, key: string, input: EnergyStartInput): Promise<ChargeSnapshot> {
    this.validateKey(key);
    if (!input || typeof input !== 'object') throw new ChargingError('invalid_input');
    if (input.mode !== 'energy_kwh') throw new ChargingError('unsupported_mode');
    if (
      ![driverId, input.connectorId, input.vehicleId, input.energyLimitWh].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      )
    )
      throw new ChargingError('invalid_input');
    const policy = this.requirePolicy();
    const hash = createHash('sha256')
      .update(JSON.stringify([input.connectorId, input.vehicleId, input.mode, input.energyLimitWh]))
      .digest('hex');
    const prepared = await chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      const prior = (
        await c.query<Intent>(
          'SELECT * FROM driver_charge_intents WHERE driver_id=$1 AND idempotency_key=$2',
          [driverId, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new ChargingError('idempotency_conflict');
        return { snapshot: await this.readStart(c, driverId, key), dispatch: null };
      }
      const connector = (
        await c.query<{
          id: string;
          charge_point_id: string;
          connector_no: number;
          serial_number: string;
          operator_id: string;
          lifecycle: string;
          operator_status: string;
          is_online: boolean;
          status: string;
          last_message_at: Date | null;
        }>(
          `SELECT c.*,cp.serial_number,cp.lifecycle,cp.is_online,cp.last_message_at,st.operator_id,o.status AS operator_status FROM connectors c
        JOIN charge_points cp ON cp.id=c.charge_point_id JOIN sites st ON st.id=cp.site_id JOIN operators o ON o.id=st.operator_id
        WHERE c.id=$1 FOR UPDATE OF c`,
          [input.connectorId],
        )
      ).rows[0];
      if (!connector) throw new ChargingError('connector_unavailable');
      // WP3/T72: connector-before-account avoids a cycle with status→session→settlement locks.
      const account = (
        await c.query<{ id: string; balance_vnd: string; status: string }>(
          'SELECT * FROM credit_accounts WHERE driver_id=$1 FOR UPDATE',
          [driverId],
        )
      ).rows[0];
      if (!account) throw new ChargingError('credit_unavailable');
      const raced = (
        await c.query<Intent>(
          'SELECT * FROM driver_charge_intents WHERE driver_id=$1 AND idempotency_key=$2',
          [driverId, key],
        )
      ).rows[0];
      if (raced) {
        if (raced.request_hash !== hash) throw new ChargingError('idempotency_conflict');
        return { snapshot: await this.readStart(c, driverId, key), dispatch: null };
      }
      if (account.status !== 'active') throw new ChargingError('credit_unavailable');

      const vehicle = (
        await c.query(
          `SELECT 1 FROM vehicles v JOIN vehicle_models m ON m.id=v.vehicle_model_id
        JOIN connectors c ON c.connector_type=m.connector_type WHERE v.id=$1 AND v.driver_id=$2 AND c.id=$3`,
          [input.vehicleId, driverId, input.connectorId],
        )
      ).rowCount;
      if (!vehicle) throw new ChargingError('vehicle_not_owned_or_incompatible');
      const connection = this.registry.get(connector.serial_number);
      if (
        connector.lifecycle !== 'in_service' ||
        connector.operator_status !== 'active' ||
        !connection ||
        !(await this.availableInConnection(c, input.connectorId, connection.epoch))
      )
        throw new ChargingError('connector_unavailable');
      if (
        (
          await c.query(
            `SELECT 1 FROM driver_charge_intents WHERE connector_id=$1 AND connector_released_at IS NULL AND state NOT IN ('rejected','settled','released')
        UNION ALL SELECT 1 FROM sessions WHERE connector_id=$1 AND status IN ('pending','active','paused','stopping','orphaned') AND received_stopped_at IS NULL
        UNION ALL SELECT 1 FROM sessions s WHERE s.connector_id=$1 AND s.received_stopped_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM connector_status_events e WHERE e.connector_id=$1
            AND e.status='Available' AND e.received_at>=s.received_stopped_at)`,
            [input.connectorId],
          )
        ).rowCount
      )
        throw new ChargingError('connector_busy_or_unknown');
      const held = (
        await c.query<{ held: string }>(
          `SELECT coalesce(sum(reserved_vnd),0) AS held FROM driver_charge_intents
        WHERE driver_id=$1 AND state NOT IN ('rejected','settled','released')`,
          [driverId],
        )
      ).rows[0]!;
      const price = (
        await c.query<{ price: string | null }>(
          `SELECT max(price_per_kwh_vnd) AS price FROM tariff_periods
        WHERE operator_id=$1 AND effective_from<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AND (effective_to IS NULL OR effective_to >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)`,
          [connector.operator_id],
        )
      ).rows[0]?.price;
      if (price === null || price === undefined) throw new ChargingError('tariff_unavailable');
      const decision = startCreditPolicy(
        Number(account.balance_vnd) - Number(held.held),
        input.energyLimitWh,
        Number(price),
        policy,
      );
      const tag = 'P3' + randomBytes(9).toString('hex');
      let commandId: string | null = null;
      if (decision.outcome === 'eligible') {
        commandId = (
          await c.query<{ id: string }>(
            `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,requested_by,idempotency_key,sent_at)
          VALUES($1,$2,'RemoteStartTransaction',$3,'sent',$4,$5,now()) RETURNING id`,
            [
              connector.charge_point_id,
              connector.connector_no,
              JSON.stringify({ connectorId: connector.connector_no, idTag: tag }),
              driverId,
              `wp3:start:${driverId}:${key}`,
            ],
          )
        ).rows[0]!.id;
      }
      const intent = (
        await c.query<Intent>(
          `INSERT INTO driver_charge_intents(driver_id,connector_id,vehicle_id,idempotency_key,request_hash,id_tag,
        energy_limit_wh,reserved_vnd,command_id,state,rejection_reason,max_energy_wh)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            driverId,
            input.connectorId,
            input.vehicleId,
            key,
            hash,
            tag,
            input.energyLimitWh,
            decision.outcome === 'eligible' ? decision.reserveVnd : 0,
            commandId,
            decision.outcome === 'eligible' ? 'sent' : 'rejected',
            decision.outcome === 'eligible' ? null : decision.outcome,
            decision.outcome === 'requiresconfirmation' ? decision.maxEnergyWh : null,
          ],
        )
      ).rows[0]!;
      return {
        snapshot: this.snapshot(intent),
        dispatch: commandId
          ? {
              commandId: Number(commandId),
              identity: connector.serial_number,
              epoch: connection.epoch,
              payload: { connectorId: connector.connector_no, idTag: tag },
            }
          : null,
      };
    });
    if (!prepared.dispatch) return prepared.snapshot;
    await this.dispatch(
      prepared.dispatch.commandId,
      prepared.dispatch.identity,
      'RemoteStartTransaction',
      prepared.dispatch.payload,
      prepared.dispatch.epoch,
    );
    return this.getStart(driverId, key);
  }

  async getStart(driverId: number, key: string): Promise<ChargeSnapshot> {
    this.validateIds(driverId);
    this.validateKey(key);
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      return this.readStart(c, driverId, key);
    });
  }

  // WP3/T72: only owning operators can fence an uncertain start; elapsed time alone proves nothing.
  async beginStartRecovery(operatorId: number, intentId: number, note: string) {
    if (typeof note !== 'string' || !note.trim() || note.length > 500)
      throw new ChargingError('recovery_evidence_required');
    this.validateIds(operatorId, intentId);
    const prepared = await chargeTransaction(this.db, async (c) => {
      const intent = await this.recoveryIntent(c, operatorId, intentId);
      const old = (
        await c.query('SELECT * FROM driver_start_recoveries WHERE intent_id=$1', [intentId])
      ).rows[0];
      if (old) return { row: old, identity: intent.serial_number, dispatch: false };
      if (intent.session_id || !['sent', 'accepted', 'unknown'].includes(intent.state))
        throw new ChargingError('start_not_recoverable');
      const conn = this.registry.get(intent.serial_number);
      if (!conn) throw new ChargingError('recovery_waiting_for_connection');
      const command = (
        await c.query(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,
        status,requested_by,idempotency_key,sent_at) VALUES($1,$2,'ChangeAvailability',$3,'sent',$4,$5,now()) RETURNING id`,
          [
            intent.charge_point_id,
            intent.connector_no,
            JSON.stringify({ connectorId: intent.connector_no, type: 'Inoperative' }),
            operatorId,
            `wp3:recover:${intentId}`,
          ],
        )
      ).rows[0]!;
      const row = (
        await c.query(
          `INSERT INTO driver_start_recoveries(intent_id,operator_user_id,connection_epoch,
        fence_command_id,evidence_note,released_vnd) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [intentId, operatorId, conn.epoch, command.id, note.trim(), intent.reserved_vnd],
        )
      ).rows[0]!;
      return { row, identity: intent.serial_number, dispatch: true };
    });
    if (prepared.dispatch)
      await this.availabilityCommand(Number(prepared.row.fence_command_id), prepared.identity);
    return this.startRecovery(operatorId, intentId);
  }

  async startRecovery(operatorId: number, intentId: number) {
    return chargeTransaction(this.db, async (c) => {
      await this.recoveryIntent(c, operatorId, intentId);
      const row = (
        await c.query(
          `SELECT x.*,CASE WHEN r.error='scheduled' THEN 'scheduled' ELSE r.status::text END AS fence_status,a.status AS restore_status
        FROM driver_start_recoveries x JOIN remote_commands r ON r.id=x.fence_command_id
        LEFT JOIN remote_commands a ON a.id=x.restore_command_id WHERE x.intent_id=$1`,
          [intentId],
        )
      ).rows[0];
      if (!row) throw new ChargingError('not_found');
      return row;
    });
  }

  async completeStartRecovery(operatorId: number, intentId: number) {
    await chargeTransaction(this.db, async (c) => {
      const intent = await this.recoveryIntent(c, operatorId, intentId);
      const recovery = (
        await c.query(
          `SELECT x.*,CASE WHEN r.error='scheduled' THEN 'scheduled' ELSE r.status::text END AS fence_status,r.sent_at
        FROM driver_start_recoveries x JOIN remote_commands r ON r.id=x.fence_command_id
        WHERE x.intent_id=$1 FOR UPDATE OF x`,
          [intentId],
        )
      ).rows[0];
      if (!recovery) throw new ChargingError('not_found');
      if (recovery.released_at) return;
      if (intent.session_id) throw new ChargingError('start_effect_observed');
      const conn = this.registry.get(intent.serial_number);
      const evidence = (
        await c.query(
          `SELECT 1 FROM connectors c JOIN charge_points cp ON cp.id=c.charge_point_id
        WHERE c.id=$1 AND c.status='Unavailable' AND cp.is_online AND cp.current_epoch=$2
        AND EXISTS(SELECT 1 FROM connector_status_events e WHERE e.connector_id=c.id
          AND e.status='Unavailable' AND e.received_at >= $3)
        AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.connector_id=c.id AND s.received_stopped_at IS NULL
          AND s.status IN ('pending','active','paused','stopping','orphaned'))`,
          [intent.connector_id, recovery.connection_epoch, recovery.sent_at],
        )
      ).rowCount;
      if (
        !['accepted', 'scheduled'].includes(recovery.fence_status) ||
        !conn ||
        conn.epoch !== recovery.connection_epoch ||
        !evidence
      )
        throw new ChargingError('recovery_evidence_incomplete');
      await c.query(
        `UPDATE driver_charge_intents SET state='released',reserved_vnd=0,
        connector_released_at=now(),version=version+1 WHERE id=$1`,
        [intentId],
      );
      await c.query('UPDATE driver_start_recoveries SET released_at=now() WHERE intent_id=$1', [
        intentId,
      ]);
      await c.query(
        `INSERT INTO driver_charge_intent_events(intent_id,actor_id,event,note)
        VALUES($1,$2,'start_released_after_fence',$3)`,
        [intentId, operatorId, recovery.evidence_note],
      );
    });
    return this.startRecovery(operatorId, intentId);
  }

  async restoreRecoveredConnector(operatorId: number, intentId: number) {
    const prepared = await chargeTransaction(this.db, async (c) => {
      const intent = await this.recoveryIntent(c, operatorId, intentId);
      const recovery = (
        await c.query('SELECT * FROM driver_start_recoveries WHERE intent_id=$1 FOR UPDATE', [
          intentId,
        ])
      ).rows[0];
      if (!recovery?.released_at) throw new ChargingError('recovery_not_completed');
      if (recovery.restore_command_id)
        return {
          commandId: Number(recovery.restore_command_id),
          identity: intent.serial_number,
          dispatch: false,
        };
      if (intent.session_id) throw new ChargingError('start_effect_observed');
      const command = (
        await c.query(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,
        requested_by,idempotency_key,sent_at) VALUES($1,$2,'ChangeAvailability',$3,'sent',$4,$5,now()) RETURNING id`,
          [
            intent.charge_point_id,
            intent.connector_no,
            JSON.stringify({ connectorId: intent.connector_no, type: 'Operative' }),
            operatorId,
            `wp3:restore:${intentId}`,
          ],
        )
      ).rows[0]!;
      await c.query(
        'UPDATE driver_start_recoveries SET restore_command_id=$2,restore_attempt=1 WHERE intent_id=$1',
        [intentId, command.id],
      );
      return { commandId: Number(command.id), identity: intent.serial_number, dispatch: true };
    });
    if (prepared.dispatch) await this.availabilityCommand(prepared.commandId, prepared.identity);
    return this.startRecovery(operatorId, intentId);
  }

  // WP3/T72: only ChangeAvailability may get a fresh retry; RemoteStart is never resent here.
  async retryStartRecovery(
    operatorId: number,
    intentId: number,
    kind: 'fence' | 'restore',
    note: string,
  ) {
    if (
      !['fence', 'restore'].includes(kind) ||
      typeof note !== 'string' ||
      !note.trim() ||
      note.length > 500
    )
      throw new ChargingError('invalid_recovery_retry');
    const prepared = await chargeTransaction(this.db, async (c) => {
      const intent = await this.recoveryIntent(c, operatorId, intentId);
      const r = (
        await c.query('SELECT * FROM driver_start_recoveries WHERE intent_id=$1 FOR UPDATE', [
          intentId,
        ])
      ).rows[0];
      if (
        !r ||
        intent.session_id ||
        (kind === 'fence' && r.released_at) ||
        (kind === 'restore' && !r.released_at)
      )
        throw new ChargingError('start_not_recoverable');
      const conn = this.registry.get(intent.serial_number);
      if (!conn) throw new ChargingError('recovery_waiting_for_connection');
      const attempt = Number(kind === 'fence' ? r.fence_attempt : r.restore_attempt) + 1;
      const command = (
        await c.query(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,
        requested_by,idempotency_key,sent_at) VALUES($1,$2,'ChangeAvailability',$3,'sent',$4,$5,now()) RETURNING id`,
          [
            intent.charge_point_id,
            intent.connector_no,
            JSON.stringify({
              connectorId: intent.connector_no,
              type: kind === 'fence' ? 'Inoperative' : 'Operative',
            }),
            operatorId,
            `wp3:recovery:${intentId}:${kind}:${attempt}`,
          ],
        )
      ).rows[0]!;
      if (kind === 'fence')
        await c.query(
          `UPDATE driver_start_recoveries SET fence_command_id=$2,fence_attempt=$3,
        connection_epoch=$4,evidence_note=$5 WHERE intent_id=$1`,
          [intentId, command.id, attempt, conn.epoch, note],
        );
      else
        await c.query(
          'UPDATE driver_start_recoveries SET restore_command_id=$2,restore_attempt=$3 WHERE intent_id=$1',
          [intentId, command.id, attempt],
        );
      await c.query(
        `INSERT INTO driver_charge_intent_events(intent_id,actor_id,event,note)
        VALUES($1,$2,$3,$4)`,
        [intentId, operatorId, `retry_${kind}`, note],
      );
      return { commandId: Number(command.id), identity: intent.serial_number };
    });
    await this.availabilityCommand(prepared.commandId, prepared.identity);
    return this.startRecovery(operatorId, intentId);
  }

  async approveLateStart(operatorId: number, intentId: number, note: string) {
    if (typeof note !== 'string' || !note.trim() || note.length > 500)
      throw new ChargingError('recovery_evidence_required');
    this.validateIds(operatorId, intentId);
    await chargeTransaction(this.db, async (c) => {
      // WP3/T72: match settlement's session-before-intent order when approving a late effect.
      await c.query(
        `SELECT s.id FROM sessions s JOIN driver_charge_intents i ON i.session_id=s.id
        WHERE i.id=$1 FOR UPDATE OF s`,
        [intentId],
      );
      const i = await this.recoveryIntent(c, operatorId, intentId);
      if (!i.billing_review_required) return;
      await c.query(
        'UPDATE driver_charge_intents SET billing_review_required=false,version=version+1 WHERE id=$1',
        [intentId],
      );
      await c.query(
        `INSERT INTO driver_charge_intent_events(intent_id,actor_id,event,note)
        VALUES($1,$2,'late_start_billing_approved',$3)`,
        [intentId, operatorId, note.trim()],
      );
      await c.query(
        "UPDATE charge_settlement_jobs SET next_attempt_at=now() WHERE session_id=$1 AND state='pending'",
        [i.session_id],
      );
    });
  }

  private validateIds(...ids: number[]) {
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0))
      throw new ChargingError('invalid_input');
  }

  private async recoveryIntent(c: PoolClient, operatorId: number, intentId: number) {
    this.validateIds(operatorId, intentId);
    const row = (
      await c.query(
        `SELECT i.*,cp.serial_number,cp.id AS charge_point_id,c.connector_no
      FROM driver_charge_intents i JOIN connectors c ON c.id=i.connector_id
      JOIN charge_points cp ON cp.id=c.charge_point_id JOIN sites st ON st.id=cp.site_id
      JOIN operator_staff staff ON staff.operator_id=st.operator_id
      JOIN users u ON u.id=staff.user_id AND u.role='operator_staff' AND u.account_status='active'
      JOIN operators o ON o.id=st.operator_id AND o.status='active'
      WHERE i.id=$1 AND u.id=$2 FOR UPDATE OF i`,
        [intentId, operatorId],
      )
    ).rows[0];
    if (!row) throw new ChargingError('not_found');
    return row;
  }

  private async availabilityCommand(commandId: number, identity: string) {
    const command = (
      await this.db.$client.query('SELECT payload FROM remote_commands WHERE id=$1', [commandId])
    ).rows[0]!;
    let response: unknown = null;
    let status = 'timeout';
    try {
      response = await this.registry
        .get(identity)
        ?.client.call('ChangeAvailability', command.payload, {
          callTimeoutMs: this.requirePolicy().commandTimeoutMs,
        });
      if ((response as { status?: string })?.status === 'Accepted') status = 'accepted';
      else if ((response as { status?: string })?.status === 'Scheduled') status = 'scheduled';
      else if ((response as { status?: string })?.status === 'Rejected') status = 'rejected';
    } catch {
      /* WP3/T72: an uncertain fence never releases funds. */
    }
    await this.db.$client.query(
      `UPDATE remote_commands SET status=$2::remote_command_status,response=$3,
      responded_at=now(),error=$4 WHERE id=$1 AND status='sent'`,
      [
        commandId,
        status === 'scheduled' ? 'accepted' : status,
        JSON.stringify(response),
        status === 'scheduled' ? 'scheduled' : status === 'timeout' ? 'outcome_unknown' : null,
      ],
    );
  }

  async stop(driverId: number, key: string, sessionId: number) {
    if (typeof key === 'string' && key.startsWith('limit:'))
      throw new ChargingError('reserved_idempotency_key');
    return this.stopCommand(driverId, key, sessionId, false);
  }

  private async stopCommand(driverId: number, key: string, sessionId: number, automatic: boolean) {
    this.validateIds(driverId, sessionId);
    this.validateKey(key);
    this.requirePolicy();
    const prepared = await chargeTransaction(this.db, async (c) => {
      if (!automatic) await this.driver(c, driverId);
      const session = (
        await c.query<{
          id: string;
          status: string;
          transaction_no: number;
          serial_number: string;
          charge_point_id: string;
          connector_no: number;
        }>(
          `
        SELECT s.*,cp.serial_number FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN driver_charge_intents i ON i.session_id=s.id AND i.driver_id=s.driver_id
        WHERE s.id=$1 AND s.driver_id=$2 FOR UPDATE OF s`,
          [sessionId, driverId],
        )
      ).rows[0];
      if (!session) throw new ChargingError('not_found');
      if (automatic && !(await this.cutoffReached(c, sessionId)))
        throw new ChargingError('session_not_stoppable');
      const prior = (
        await c.query<{ id: string; command_id: string; session_id: string; state: string }>(
          `
        SELECT * FROM driver_stop_intents WHERE driver_id=$1 AND
          (($3::boolean AND session_id=$4) OR (NOT $3::boolean AND idempotency_key=$2))
          ORDER BY id DESC LIMIT 1`,
          [driverId, key, automatic, sessionId],
        )
      ).rows[0];
      if (prior) {
        if (Number(prior.session_id) !== sessionId) throw new ChargingError('idempotency_conflict');
        if (!automatic || prior.state !== 'rejected')
          return { commandId: Number(prior.command_id), dispatch: false, session };
        const eligible = (
          await c.query(
            `SELECT 1 FROM remote_commands r
          JOIN driver_stop_attempts a ON a.command_id=r.id
          JOIN sessions s ON s.id=$2 JOIN charge_points cp ON cp.id=s.charge_point_id
          WHERE r.id=$1 AND r.status='rejected' AND cp.is_online
          AND EXISTS(SELECT 1 FROM meter_values m WHERE m.session_id=s.id AND NOT m.replayed
            AND m.epoch=cp.current_epoch AND m.received_at>=cp.online_changed_at
            AND m.cp_timestamp>=cp.online_changed_at AND m.cp_timestamp<=now()
            AND m.measurand='Energy.Active.Import.Register' AND m.phase IS NULL
            AND (m.unit IN ('Wh','kWh') OR m.unit IS NULL)
            AND m.received_at>r.responded_at+least(30,power(2,least(a.attempt_no-1,5))) * interval '1 second'
            AND m.received_at<=now() AND m.received_at>=now()-($3::bigint*interval '1 millisecond'))`,
            [prior.command_id, sessionId, this.requirePolicy().stationStaleAfterMs],
          )
        ).rowCount;
        if (!eligible) return { commandId: Number(prior.command_id), dispatch: false, session };
      }
      if (!['active', 'paused', 'orphaned'].includes(session.status))
        throw new ChargingError('session_not_stoppable');
      if (
        (
          await c.query(
            "SELECT 1 FROM driver_stop_intents WHERE session_id=$1 AND state<>'rejected'",
            [sessionId],
          )
        ).rowCount
      )
        throw new ChargingError('stop_pending_or_unknown');
      const command = (
        await c.query<{ id: string }>(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,requested_by,idempotency_key,sent_at)
        VALUES($1,$2,'RemoteStopTransaction',$3,'sent',$4,$5,now()) RETURNING id`,
          [
            session.charge_point_id,
            session.connector_no,
            JSON.stringify({ transactionId: session.transaction_no }),
            automatic ? null : driverId,
            prior
              ? `wp3:stop-attempt:${prior.id}:${prior.command_id}`
              : `wp3:stop:${driverId}:${key}`,
          ],
        )
      ).rows[0]!;
      const intent =
        prior ??
        (
          await c.query<{ id: string }>(
            `INSERT INTO driver_stop_intents(driver_id,session_id,idempotency_key,command_id,state)
         VALUES($1,$2,$3,$4,'sent') RETURNING id`,
            [driverId, sessionId, key, command.id],
          )
        ).rows[0]!;
      if (prior)
        await c.query("UPDATE driver_stop_intents SET command_id=$2,state='sent' WHERE id=$1", [
          prior.id,
          command.id,
        ]);
      await c.query(
        `INSERT INTO driver_stop_attempts(command_id,intent_id,attempt_no,kind,previous_command_id)
        SELECT $1,$2,coalesce(max(attempt_no),0)+1,$3,$4 FROM driver_stop_attempts WHERE intent_id=$2`,
        [command.id, intent.id, prior ? 'auto_retry' : 'initial', prior?.command_id ?? null],
      );
      if (session.status !== 'orphaned') {
        const next = new SessionStateMachine().apply(
          session.status as SessionStatus,
          'STOP_REQUESTED',
        );
        await c.query('UPDATE sessions SET status=$2,updated_at=now() WHERE id=$1', [
          sessionId,
          next,
        ]);
        await c.query(
          `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor)
          VALUES($1,$2,'stopping','STOP_REQUESTED',$3)`,
          [sessionId, session.status, automatic ? 'system' : String(driverId)],
        );
      }
      return { commandId: Number(command.id), dispatch: true, session };
    });
    if (prepared.dispatch)
      await this.dispatch(
        prepared.commandId,
        prepared.session.serial_number,
        'RemoteStopTransaction',
        { transactionId: prepared.session.transaction_no },
      );
    return this.commandSnapshot(driverId, prepared.commandId);
  }

  // WP3/T72: recovery adds an audited attempt to the same stop intent, never a fresh business key.
  async recoverStop(
    operatorId: number,
    sessionId: number,
    previousCommandId: number,
    note: string,
  ) {
    this.validateIds(operatorId, sessionId, previousCommandId);
    if (typeof note !== 'string' || !note.trim() || note.length > 500)
      throw new ChargingError('recovery_evidence_required');
    const policy = this.requirePolicy();
    const prepared = await chargeTransaction(this.db, async (c) => {
      const session = (
        await c.query(
          `SELECT s.*,cp.serial_number,cp.current_epoch FROM sessions s
        JOIN charge_points cp ON cp.id=s.charge_point_id WHERE s.id=$1 FOR UPDATE OF s`,
          [sessionId],
        )
      ).rows[0];
      if (
        !session ||
        !(
          await c.query(
            `SELECT 1 FROM operator_staff st
        JOIN users u ON u.id=st.user_id AND u.role='operator_staff' AND u.account_status='active'
        JOIN operators o ON o.id=st.operator_id AND o.status='active'
        JOIN sites site ON site.operator_id=o.id JOIN charge_points cp ON cp.site_id=site.id
        WHERE st.user_id=$1 AND cp.id=$2`,
            [operatorId, session.charge_point_id],
          )
        ).rowCount
      )
        throw new ChargingError('forbidden');
      const original = (
        await c.query(
          `SELECT i.*,a.command_id AS original_command_id FROM driver_stop_attempts a
        JOIN driver_stop_intents i ON i.id=a.intent_id WHERE a.command_id=$1 AND i.session_id=$2`,
          [previousCommandId, sessionId],
        )
      ).rows[0];
      if (!original) throw new ChargingError('not_found');
      const duplicate = (
        await c.query(
          `SELECT command_id FROM driver_stop_attempts
        WHERE intent_id=$1 AND previous_command_id=$2`,
          [original.id, previousCommandId],
        )
      ).rows[0];
      if (duplicate)
        return {
          commandId: Number(duplicate.command_id),
          driverId: Number(original.driver_id),
          identity: session.serial_number,
          transactionNo: session.transaction_no,
          epoch: session.current_epoch,
          dispatch: false,
        };
      if (
        session.received_stopped_at ||
        !['active', 'paused', 'stopping', 'orphaned'].includes(session.status)
      )
        throw new ChargingError('stop_effect_observed_or_not_recoverable');
      if (
        Number(original.command_id) !== previousCommandId ||
        !['sent', 'unknown', 'accepted'].includes(original.state)
      )
        throw new ChargingError('stop_attempt_not_current');
      const conn = this.registry.get(session.serial_number);
      if (!conn || conn.epoch !== session.current_epoch)
        throw new ChargingError('recovery_waiting_for_connection');
      const evidence = (
        await c.query(
          `SELECT m.id,m.received_at FROM remote_commands r
        JOIN sessions s ON s.id=$2 JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN connectors cn ON cn.id=s.connector_id JOIN meter_values m ON m.session_id=s.id
        WHERE r.id=$1 AND (r.status IN ('sent','timeout','accepted') OR
          (r.status='rejected' AND EXISTS(SELECT 1 FROM driver_stop_attempts a
            WHERE a.command_id=r.id AND a.kind='operator_recovery')))
        AND cp.is_online AND cp.current_epoch=$3 AND cp.lifecycle='in_service'
        AND cp.last_message_at BETWEEN now()-($4::bigint*interval '1 millisecond') AND now()
        AND cn.status IN ('Charging','SuspendedEV','SuspendedEVSE')
        AND cn.status_changed_at BETWEEN cp.online_changed_at AND now()
        AND cn.status_changed_at>=now()-($4::bigint*interval '1 millisecond')
        AND m.epoch=$3 AND NOT m.replayed AND m.phase IS NULL
        AND m.measurand='Energy.Active.Import.Register' AND (m.unit IN ('Wh','kWh') OR m.unit IS NULL)
        AND (CASE WHEN m.unit='kWh' THEN m.value*1000 ELSE m.value END)>=s.meter_start_wh
        AND m.received_at>greatest(r.sent_at+($5::bigint*interval '1 millisecond'),r.responded_at)
        AND m.received_at BETWEEN cp.online_changed_at AND now()
        AND m.received_at>=now()-($4::bigint*interval '1 millisecond')
        AND m.cp_timestamp BETWEEN cp.online_changed_at AND now() AND m.cp_timestamp>r.sent_at
        AND NOT EXISTS(SELECT 1 FROM sessions other WHERE other.connector_id=s.connector_id
          AND other.id<>s.id AND other.received_stopped_at IS NULL
          AND other.status IN ('pending','active','paused','stopping','orphaned'))
        ORDER BY m.received_at DESC,m.id DESC LIMIT 1`,
          [
            previousCommandId,
            sessionId,
            conn.epoch,
            policy.stationStaleAfterMs,
            policy.commandTimeoutMs,
          ],
        )
      ).rows[0];
      if (!evidence) throw new ChargingError('recovery_evidence_incomplete');
      const command = (
        await c.query(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,
        status,requested_by,idempotency_key,sent_at) VALUES($1,$2,'RemoteStopTransaction',$3,'sent',$4,$5,now()) RETURNING id`,
          [
            session.charge_point_id,
            session.connector_no,
            JSON.stringify({ transactionId: session.transaction_no }),
            operatorId,
            `wp3:stop-recovery:${original.id}:${previousCommandId}`,
          ],
        )
      ).rows[0]!;
      await c.query(
        `INSERT INTO driver_stop_attempts(command_id,intent_id,attempt_no,kind,previous_command_id,
        connection_epoch,evidence_meter_id,evidence_received_at,operator_user_id,note)
        SELECT $1,$2,max(attempt_no)+1,'operator_recovery',$3,$4,$5,$6,$7,$8
        FROM driver_stop_attempts WHERE intent_id=$2`,
        [
          command.id,
          original.id,
          previousCommandId,
          conn.epoch,
          evidence.id,
          evidence.received_at,
          operatorId,
          note.trim(),
        ],
      );
      await c.query("UPDATE driver_stop_intents SET command_id=$2,state='sent' WHERE id=$1", [
        original.id,
        command.id,
      ]);
      if (['active', 'paused'].includes(session.status)) {
        const next = new SessionStateMachine().apply(
          session.status as SessionStatus,
          'STOP_REQUESTED',
        );
        await c.query('UPDATE sessions SET status=$2,updated_at=now() WHERE id=$1', [
          sessionId,
          next,
        ]);
        await c.query(
          `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor)
          VALUES($1,$2,$3,'STOP_REQUESTED',$4)`,
          [sessionId, session.status, next, String(operatorId)],
        );
      }
      return {
        commandId: Number(command.id),
        driverId: Number(original.driver_id),
        identity: session.serial_number,
        transactionNo: session.transaction_no,
        epoch: conn.epoch,
        dispatch: true,
      };
    });
    if (prepared.dispatch)
      await this.dispatch(
        prepared.commandId,
        prepared.identity,
        'RemoteStopTransaction',
        { transactionId: prepared.transactionNo },
        prepared.epoch,
      );
    return this.commandSnapshot(prepared.driverId, prepared.commandId);
  }

  // WP3/T72: only this trusted ingress hook can request an account-independent system cutoff.
  async onMeter(transactionNo: number): Promise<void> {
    if (!this.policy || !Number.isSafeInteger(transactionNo) || transactionNo < 1) return;
    const row = (
      await this.db.$client.query<{ id: string; driver_id: string }>(
        `SELECT id,driver_id FROM sessions WHERE transaction_no=$1 AND driver_id IS NOT NULL
       AND status IN ('active','paused')`,
        [transactionNo],
      )
    ).rows[0];
    if (!row) return;
    try {
      await this.stopCommand(Number(row.driver_id), `limit:${row.id}`, Number(row.id), true);
    } catch (error) {
      if (!(
        error instanceof ChargingError &&
        ['stop_pending_or_unknown', 'session_not_stoppable'].includes(error.code)
      ))
        throw error;
    }
  }

  // WP3/T72: a heartbeat cannot promote an Available snapshot from an older connection.
  private async availableInConnection(
    c: PoolClient,
    connectorId: number,
    epoch: number,
  ): Promise<boolean> {
    return Boolean(
      (
        await c.query(
          `SELECT 1 FROM connectors c
      JOIN charge_points cp ON cp.id=c.charge_point_id
      WHERE c.id=$1 AND cp.current_epoch=$2 AND cp.is_online AND cp.lifecycle='in_service'
        AND cp.online_changed_at IS NOT NULL AND cp.online_changed_at<=now()
        AND cp.last_message_at BETWEEN now()-($3::bigint*interval '1 millisecond') AND now()
        AND c.status='Available' AND c.status_changed_at BETWEEN cp.online_changed_at AND now()
        AND EXISTS(SELECT 1 FROM connector_status_events e JOIN ocpp_message_log l
          ON l.charge_point_id=e.charge_point_id AND l.received_at=e.received_at
          WHERE e.connector_id=c.id AND e.status='Available' AND e.received_at=c.status_changed_at
            AND (e.cp_timestamp IS NULL OR e.cp_timestamp BETWEEN cp.online_changed_at AND e.received_at)
            AND l.epoch=$2 AND l.direction='in' AND l.message_type=2 AND l.action='StatusNotification'
            AND l.replayed IS NOT TRUE AND l.raw->3->>'connectorId'=c.connector_no::text
            AND l.raw->3->>'status'='Available')`,
          [connectorId, epoch, this.requirePolicy().stationStaleAfterMs],
        )
      ).rowCount,
    );
  }

  private async cutoffReached(c: PoolClient, sessionId: number): Promise<boolean> {
    const row = (
      await c.query<{
        consumed: string;
        energy_limit_wh: string;
        available: string;
        price: string | null;
        serial_number: string;
        current_epoch: number;
      }>(
        `
      SELECT i.energy_limit_wh,cp.serial_number,cp.current_epoch,m.wh-s.meter_start_wh AS consumed,
        a.balance_vnd-coalesce((SELECT sum(reserved_vnd) FROM driver_charge_intents other
          WHERE other.driver_id=s.driver_id AND other.id<>i.id
          AND other.state NOT IN ('rejected','settled','released')),0) AS available,
        (SELECT max(price_per_kwh_vnd) FROM tariff_periods t WHERE t.operator_id=st.operator_id
          AND effective_from<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (effective_to IS NULL OR effective_to>=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)) AS price
      FROM sessions s JOIN driver_charge_intents i ON i.session_id=s.id AND i.driver_id=s.driver_id
      JOIN credit_accounts a ON a.driver_id=s.driver_id JOIN charge_points cp ON cp.id=s.charge_point_id
      JOIN sites st ON st.id=cp.site_id JOIN LATERAL (
        SELECT CASE WHEN unit='kWh' THEN value*1000 ELSE value END AS wh
        FROM meter_values WHERE session_id=s.id AND NOT replayed AND epoch=cp.current_epoch
          AND measurand='Energy.Active.Import.Register' AND phase IS NULL
          AND (unit IN ('Wh','kWh') OR unit IS NULL)
          AND received_at BETWEEN cp.online_changed_at AND now()
          AND received_at>=now()-($2::bigint*interval '1 millisecond')
          AND cp_timestamp BETWEEN cp.online_changed_at AND now()
        ORDER BY cp_timestamp DESC,received_at DESC,id DESC LIMIT 1) m ON true
      WHERE s.id=$1 AND s.status IN ('active','paused') AND s.received_stopped_at IS NULL
        AND s.origin='app_qr' AND s.payment_mode='csms_billed' AND s.billing_mode='energy_kwh'
        AND cp.is_online AND cp.last_message_at BETWEEN now()-($2::bigint*interval '1 millisecond') AND now()`,
        [sessionId, this.requirePolicy().stationStaleAfterMs],
      )
    ).rows[0];
    if (!row || this.registry.get(row.serial_number)?.epoch !== row.current_epoch) return false;
    const consumed = Number(row.consumed);
    if (!Number.isSafeInteger(consumed) || consumed < 0) return false;
    return (
      consumed >= Number(row.energy_limit_wh) ||
      (row.price !== null &&
        BigInt(row.available) * 1000n - BigInt(consumed) * BigInt(row.price) <=
          BigInt(this.requirePolicy().cutoffReserveVnd) * 1000n)
    );
  }

  async onStopped(transactionNo: number): Promise<void> {
    await chargeTransaction(this.db, async (c) => {
      const row = (
        await c.query<{ id: string }>(
          'SELECT id FROM sessions WHERE transaction_no=$1 FOR UPDATE',
          [transactionNo],
        )
      ).rows[0];
      if (!row) return;
      await c.query(
        "UPDATE driver_stop_intents SET state='effect' WHERE session_id=$1 AND state NOT IN ('effect','rejected')",
        [row.id],
      );
    });
    const row = (
      await this.db.$client.query<{ id: string }>(
        'SELECT id FROM sessions WHERE transaction_no=$1',
        [transactionNo],
      )
    ).rows[0];
    if (row) await this.settlement.settle(Number(row.id));
  }

  async statement(driverId: number, sessionId: number) {
    this.validateIds(driverId, sessionId);
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      const row = (
        await c.query(
          `SELECT st.* FROM charging_statements st WHERE session_id=$1 AND driver_id=$2`,
          [sessionId, driverId],
        )
      ).rows[0];
      if (!row) throw new ChargingError('not_found');
      return row;
    });
  }

  async findStations(driverId: number, vehicleId: number, input: StationSearchInput = {}) {
    this.validateIds(driverId, vehicleId);
    const policy = this.requirePolicy();
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      return searchStations(
        c,
        driverId,
        vehicleId,
        input,
        policy.stationStaleAfterMs,
        policy.stationOfflineAfterMs ?? 900000,
      );
    });
  }

  // WP3/T72: QR resolves an exact canonical connector independently of search pagination.
  async resolveConnector(
    driverId: number,
    vehicleId: number,
    displayCode: string,
    connectorNo: number,
  ) {
    this.validateIds(driverId, vehicleId);
    if (
      typeof displayCode !== 'string' ||
      !displayCode ||
      displayCode.length > 100 ||
      ![1, 2].includes(connectorNo)
    )
      throw new ChargingError('invalid_connector_reference');
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      const row = (
        await c.query(
          `SELECT c.id AS connector_id,c.connector_no,c.status,cp.display_code,
        cp.serial_number,cp.lifecycle,cp.is_online,cp.online_changed_at,cp.last_message_at,st.site_name,st.vinfast_only
        FROM connectors c JOIN charge_points cp ON cp.id=c.charge_point_id
        JOIN sites st ON st.id=cp.site_id JOIN operators o ON o.id=st.operator_id AND o.status='active'
        JOIN vehicles v ON v.id=$1 AND v.driver_id=$2 JOIN vehicle_models m ON m.id=v.vehicle_model_id
        WHERE m.connector_type=c.connector_type AND cp.lifecycle='in_service' AND cp.display_code=$3 AND c.connector_no=$4`,
          [vehicleId, driverId, displayCode, connectorNo],
        )
      ).rows[0];
      if (!row) throw new ChargingError('not_found');
      return row;
    });
  }

  async progress(driverId: number, sessionId: number) {
    this.validateIds(driverId, sessionId);
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      const row = (
        await c.query(
          `SELECT s.id,s.status,s.updated_at,s.energy_wh,s.meter_start_wh,s.meter_stop_wh,
        s.limit_value,i.billing_review_required,j.state AS settlement_state,j.reason AS settlement_reason,j.next_attempt_at AS settlement_retry_at,i.reserved_vnd,cp.lifecycle,cp.is_online,cp.online_changed_at,cp.last_message_at,
        (SELECT CASE WHEN unit='kWh' THEN value*1000 ELSE value END FROM meter_values m
          WHERE m.session_id=s.id AND measurand='Energy.Active.Import.Register' AND phase IS NULL
          AND (unit IN ('Wh','kWh') OR unit IS NULL) ORDER BY cp_timestamp DESC LIMIT 1) AS latest_wh
        FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN driver_charge_intents i ON i.session_id=s.id AND i.driver_id=s.driver_id
        LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
        WHERE s.id=$1 AND s.driver_id=$2`,
          [sessionId, driverId],
        )
      ).rows[0];
      if (!row) throw new ChargingError('not_found');
      const delta =
        row.latest_wh === null ? null : Number(row.latest_wh) - Number(row.meter_start_wh);
      const valid = delta !== null && Number.isSafeInteger(delta) && delta >= 0;
      return {
        ...row,
        consumed_wh: row.energy_wh ?? (valid ? String(delta) : null),
        telemetry_quality: valid ? 'observed' : 'unknown',
      };
    });
  }

  private async dispatch(
    commandId: number,
    identity: string,
    action: string,
    payload: unknown,
    expectedEpoch?: number,
  ) {
    let status: 'accepted' | 'rejected' | 'timeout' = 'timeout';
    let response: unknown = null;
    try {
      if (
        action === 'RemoteStopTransaction' &&
        !(
          await this.db.$client.query(
            `SELECT 1 FROM driver_stop_intents i JOIN sessions s ON s.id=i.session_id
         WHERE i.command_id=$1 AND i.state='sent' AND s.received_stopped_at IS NULL`,
            [commandId],
          )
        ).rowCount
      )
        return;
      const conn = this.registry.get(identity);
      if (!conn || (expectedEpoch !== undefined && conn.epoch !== expectedEpoch))
        throw new Error('offline_or_epoch_changed');
      response = await conn.client.call(action, payload, {
        callTimeoutMs: this.requirePolicy().commandTimeoutMs,
      });
      const result = response as { status?: string };
      if (result?.status === 'Accepted') status = 'accepted';
      else if (result?.status === 'Rejected') status = 'rejected';
    } catch {
      /* WP3/T31: transport failure cannot prove that the charger did nothing. */
    }
    await this.recordDispatch(commandId, action, status, response);
  }

  private async recordDispatch(
    commandId: number,
    action: string,
    status: 'accepted' | 'rejected' | 'timeout',
    response: unknown,
  ) {
    await chargeTransaction(this.db, async (c) => {
      if (action === 'RemoteStopTransaction') {
        const stop = (
          await c.query<{ session_id: string; kind: string }>(
            `SELECT i.session_id,a.kind FROM driver_stop_attempts a
             JOIN driver_stop_intents i ON i.id=a.intent_id WHERE a.command_id=$1`,
            [commandId],
          )
        ).rows[0]!;
        const session = (
          await c.query<{ status: string }>('SELECT status FROM sessions WHERE id=$1 FOR UPDATE', [
            stop.session_id,
          ])
        ).rows[0]!;
        const current = (
          await c.query(
            `SELECT i.state FROM driver_stop_intents i
          JOIN remote_commands r ON r.id=i.command_id WHERE i.command_id=$1 AND r.status='sent'`,
            [commandId],
          )
        ).rows[0];
        if (
          status === 'rejected' &&
          session.status === 'stopping' &&
          current?.state === 'sent' &&
          stop.kind !== 'operator_recovery'
        ) {
          const from = new SessionStateMachine().apply('stopping', 'REMOTE_STOP_REJECTED');
          await c.query('UPDATE sessions SET status=$2,updated_at=now() WHERE id=$1', [
            stop.session_id,
            from,
          ]);
          await c.query(
            `INSERT INTO session_status_history(session_id,from_status,to_status,event)
            VALUES($1,'stopping',$2,'REMOTE_STOP_REJECTED')`,
            [stop.session_id, from],
          );
        }
        await c.query(
          `UPDATE driver_stop_intents SET state=$2 WHERE command_id=$1 AND state='sent'`,
          [
            commandId,
            status === 'timeout' || (status === 'rejected' && stop.kind === 'operator_recovery')
              ? 'unknown'
              : status,
          ],
        );
      } else {
        await c.query(
          `UPDATE driver_charge_intents SET state=$2,reserved_vnd=CASE WHEN $2='rejected' THEN 0 ELSE reserved_vnd END,
          connector_released_at=CASE WHEN $2='rejected' THEN coalesce(connector_released_at,now()) ELSE connector_released_at END,
          version=version+1 WHERE command_id=$1 AND state='sent' AND session_id IS NULL`,
          [commandId, status === 'timeout' ? 'unknown' : status],
        );
      }
      await c.query(
        `UPDATE remote_commands SET status=$2::text::remote_command_status,response=$3,responded_at=CASE WHEN $2::text='timeout' THEN NULL ELSE now() END,
        error=CASE WHEN $2='timeout' THEN 'outcome_unknown' ELSE NULL END WHERE id=$1 AND status='sent'`,
        [commandId, status, JSON.stringify(response)],
      );
    });
  }

  private async commandSnapshot(driverId: number, commandId: number) {
    const row = (
      await this.db.$client.query(
        `SELECT r.id AS command_id,r.status AS command_status,s.status AS session_status,
      (s.meter_stop_wh IS NOT NULL) AS effect_confirmed FROM driver_stop_attempts a JOIN remote_commands r ON r.id=a.command_id
      JOIN driver_stop_intents i ON i.id=a.intent_id JOIN sessions s ON s.id=i.session_id WHERE a.command_id=$1 AND i.driver_id=$2`,
        [commandId, driverId],
      )
    ).rows[0];
    if (!row) throw new ChargingError('not_found');
    return row;
  }
  private snapshot(i: Intent): ChargeSnapshot {
    return {
      intentId: Number(i.id),
      commandId: i.command_id === null ? null : Number(i.command_id),
      sessionId: i.session_id === null ? null : Number(i.session_id),
      outcome: i.rejection_reason ?? i.session_status ?? i.state,
      effectConfirmed: i.session_id !== null,
      version: i.version,
      maxEnergyWh: i.max_energy_wh === null ? null : Number(i.max_energy_wh),
    };
  }
  private async readStart(c: PoolClient, driverId: number, key: string) {
    const intent = (
      await c.query<Intent>(
        `SELECT i.*,s.status AS session_status FROM driver_charge_intents i
      LEFT JOIN sessions s ON s.id=i.session_id WHERE i.driver_id=$1 AND i.idempotency_key=$2`,
        [driverId, key],
      )
    ).rows[0];
    if (!intent) throw new ChargingError('not_found');
    return this.snapshot(intent);
  }
  private async driver(c: PoolClient, driverId: number) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.id=$1 AND role='driver' AND account_status='active'",
          [driverId],
        )
      ).rowCount
    )
      throw new ChargingError('forbidden');
  }
  private requirePolicy() {
    if (!this.policy) throw new ChargingError('policy_unconfigured');
    return this.policy;
  }
  private validateKey(key: string) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{1,100}$/.test(key))
      throw new ChargingError('invalid_idempotency_key');
  }
}
