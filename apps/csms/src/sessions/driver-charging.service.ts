import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { CHARGE_POLICY, ChargeSettlementService } from './charge-settlement.service.js';
import { ChargePolicy, startCreditPolicy, validateChargePolicy } from './charge-start-policy.js';
import { chargeTransaction } from './charge-sql.js';
import { SessionStateMachine, SessionStatus } from './session-state-machine.js';

export class ChargingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChargingError';
  }
}
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
      const account = (
        await c.query<{ id: string; balance_vnd: string; status: string }>(
          'SELECT * FROM credit_accounts WHERE driver_id=$1 FOR UPDATE',
          [driverId],
        )
      ).rows[0];
      if (!account || account.status !== 'active') throw new ChargingError('credit_unavailable');
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
          is_online: boolean;
          status: string;
          last_message_at: Date | null;
        }>(
          `SELECT c.*,cp.serial_number,cp.lifecycle,cp.is_online,cp.last_message_at,st.operator_id FROM connectors c
        JOIN charge_points cp ON cp.id=c.charge_point_id JOIN sites st ON st.id=cp.site_id
        WHERE c.id=$1 FOR UPDATE OF c`,
          [input.connectorId],
        )
      ).rows[0];
      if (!connector) throw new ChargingError('connector_unavailable');
      const vehicle = (
        await c.query(
          `SELECT 1 FROM vehicles v JOIN vehicle_models m ON m.id=v.vehicle_model_id
        JOIN connectors c ON c.connector_type=m.connector_type WHERE v.id=$1 AND v.driver_id=$2 AND c.id=$3`,
          [input.vehicleId, driverId, input.connectorId],
        )
      ).rowCount;
      if (!vehicle) throw new ChargingError('vehicle_not_owned_or_incompatible');
      if (
        connector.lifecycle !== 'in_service' ||
        !connector.is_online ||
        !this.registry.get(connector.serial_number) ||
        !connector.last_message_at ||
        Date.now() - connector.last_message_at.getTime() > policy.stationStaleAfterMs ||
        !['Available', 'Preparing'].includes(connector.status)
      )
        throw new ChargingError('connector_unavailable');
      if (
        (
          await c.query(
            `SELECT 1 FROM driver_charge_intents WHERE connector_id=$1 AND state NOT IN ('rejected','settled')
        UNION ALL SELECT 1 FROM sessions WHERE connector_id=$1 AND status IN ('pending','active','paused','stopping','orphaned','closed','review')`,
            [input.connectorId],
          )
        ).rowCount
      )
        throw new ChargingError('connector_busy_or_unknown');
      const held = (
        await c.query<{ held: string }>(
          `SELECT coalesce(sum(reserved_vnd),0) AS held FROM driver_charge_intents
        WHERE driver_id=$1 AND state NOT IN ('rejected','settled')`,
          [driverId],
        )
      ).rows[0]!;
      const price = (
        await c.query<{ price: string | null }>(
          `SELECT max(price_per_kwh_vnd) AS price FROM tariff_periods
        WHERE operator_id=$1 AND (effective_to IS NULL OR effective_to >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)`,
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
    );
    return this.getStart(driverId, key);
  }

  async getStart(driverId: number, key: string): Promise<ChargeSnapshot> {
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      return this.readStart(c, driverId, key);
    });
  }

  async stop(driverId: number, key: string, sessionId: number) {
    this.validateKey(key);
    this.requirePolicy();
    const prepared = await chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
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
      const prior = (
        await c.query<{ command_id: string; session_id: string; state: string }>(
          `
        SELECT * FROM driver_stop_intents WHERE driver_id=$1 AND idempotency_key=$2`,
          [driverId, key],
        )
      ).rows[0];
      if (prior) {
        if (Number(prior.session_id) !== sessionId) throw new ChargingError('idempotency_conflict');
        return { commandId: Number(prior.command_id), dispatch: false, session };
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
            driverId,
            `wp3:stop:${driverId}:${key}`,
          ],
        )
      ).rows[0]!;
      await c.query(
        `INSERT INTO driver_stop_intents(driver_id,session_id,idempotency_key,command_id,state) VALUES($1,$2,$3,$4,'sent')`,
        [driverId, sessionId, key, command.id],
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
          [sessionId, session.status, String(driverId)],
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

  async onMeter(transactionNo: number): Promise<void> {
    if (!this.policy) return;
    const row = (
      await this.db.$client.query<{
        id: string;
        driver_id: string;
        energy_limit_wh: string;
        meter_start_wh: string;
        latest_wh: string | null;
        available: string;
        price: string | null;
      }>(
        `
      SELECT s.id,s.driver_id,s.meter_start_wh,i.energy_limit_wh,i.id_tag,
        a.balance_vnd - coalesce((SELECT sum(reserved_vnd) FROM driver_charge_intents other
          WHERE other.driver_id=s.driver_id AND other.id<>i.id AND other.state NOT IN ('rejected','settled')),0) AS available,
        (SELECT max(price_per_kwh_vnd) FROM tariff_periods t WHERE t.operator_id=st.operator_id
          AND (effective_to IS NULL OR effective_to >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)) AS price,
        (SELECT CASE WHEN unit='kWh' THEN value*1000 ELSE value END FROM meter_values m
          WHERE m.session_id=s.id AND measurand='Energy.Active.Import.Register'
          AND (unit IN ('Wh','kWh') OR unit IS NULL) AND phase IS NULL ORDER BY cp_timestamp DESC LIMIT 1) AS latest_wh
      FROM sessions s JOIN driver_charge_intents i ON i.session_id=s.id
      JOIN credit_accounts a ON a.driver_id=s.driver_id JOIN charge_points cp ON cp.id=s.charge_point_id
      JOIN sites st ON st.id=cp.site_id
      WHERE s.transaction_no=$1 AND s.status IN ('active','paused')`,
        [transactionNo],
      )
    ).rows[0];
    if (!row || row.latest_wh === null) return;
    const consumed = Number(row.latest_wh) - Number(row.meter_start_wh);
    if (!Number.isSafeInteger(consumed) || consumed < 0) return;
    const cutoff =
      row.price !== null &&
      BigInt(row.available) * 1000n - BigInt(consumed) * BigInt(row.price) <=
        BigInt(this.policy.cutoffReserveVnd) * 1000n;
    if (consumed < Number(row.energy_limit_wh) && !cutoff) return;
    try {
      await this.stop(Number(row.driver_id), `limit:${row.id}`, Number(row.id));
    } catch (error) {
      if (!(
        error instanceof ChargingError &&
        ['stop_pending_or_unknown', 'session_not_stoppable'].includes(error.code)
      ))
        throw error;
    }
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

  // WP3/T31: app-facing reads resolve canonical connector IDs; ranking remains WP4-owned.
  async findStations(driverId: number, vehicleId: number) {
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      if (
        !(
          await c.query('SELECT 1 FROM vehicles WHERE id=$1 AND driver_id=$2', [
            vehicleId,
            driverId,
          ])
        ).rowCount
      )
        throw new ChargingError('not_found');
      return (
        await c.query(
          `SELECT c.id AS connector_id,c.connector_no,c.status,cp.display_code,
        cp.serial_number,cp.lifecycle,cp.is_online,cp.online_changed_at,cp.last_message_at,st.site_name FROM connectors c
        JOIN charge_points cp ON cp.id=c.charge_point_id JOIN sites st ON st.id=cp.site_id
        JOIN vehicles v ON v.id=$1 AND v.driver_id=$2 JOIN vehicle_models m ON m.id=v.vehicle_model_id
        WHERE m.connector_type=c.connector_type AND cp.lifecycle='in_service' ORDER BY st.id,cp.id,c.connector_no`,
          [vehicleId, driverId],
        )
      ).rows;
    });
  }

  async resolveConnector(
    driverId: number,
    vehicleId: number,
    displayCode: string,
    connectorNo: number,
  ) {
    const rows = await this.findStations(driverId, vehicleId);
    const row = rows.find((r) => r.display_code === displayCode && r.connector_no === connectorNo);
    if (!row) throw new ChargingError('not_found');
    return row;
  }

  async progress(driverId: number, sessionId: number) {
    return chargeTransaction(this.db, async (c) => {
      await this.driver(c, driverId);
      const row = (
        await c.query(
          `SELECT s.id,s.status,s.updated_at,s.energy_wh,s.meter_start_wh,s.meter_stop_wh,
        s.limit_value,cp.lifecycle,cp.is_online,cp.online_changed_at,cp.last_message_at,
        (SELECT CASE WHEN unit='kWh' THEN value*1000 ELSE value END FROM meter_values m
          WHERE m.session_id=s.id AND measurand='Energy.Active.Import.Register' AND phase IS NULL
          AND (unit IN ('Wh','kWh') OR unit IS NULL) ORDER BY cp_timestamp DESC LIMIT 1) AS latest_wh
        FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN driver_charge_intents i ON i.session_id=s.id AND i.driver_id=s.driver_id
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

  private async dispatch(commandId: number, identity: string, action: string, payload: unknown) {
    let status: 'accepted' | 'rejected' | 'timeout' = 'timeout';
    let response: unknown = null;
    try {
      const conn = this.registry.get(identity);
      if (!conn) throw new Error('offline');
      response = await conn.client.call(action, payload, {
        callTimeoutMs: this.requirePolicy().commandTimeoutMs,
      });
      const result = response as { status?: string };
      if (result?.status === 'Accepted') status = 'accepted';
      else if (result?.status === 'Rejected') status = 'rejected';
    } catch {
      /* WP3/T31: transport failure cannot prove that the charger did nothing. */
    }
    await chargeTransaction(this.db, async (c) => {
      if (action === 'RemoteStopTransaction') {
        const stop = (
          await c.query<{ session_id: string }>(
            'SELECT session_id FROM driver_stop_intents WHERE command_id=$1',
            [commandId],
          )
        ).rows[0]!;
        const session = (
          await c.query<{ status: string }>('SELECT status FROM sessions WHERE id=$1 FOR UPDATE', [
            stop.session_id,
          ])
        ).rows[0]!;
        if (status === 'rejected' && session.status === 'stopping') {
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
          [commandId, status === 'timeout' ? 'unknown' : status],
        );
      } else {
        await c.query(
          `UPDATE driver_charge_intents SET state=$2,reserved_vnd=CASE WHEN $2='rejected' THEN 0 ELSE reserved_vnd END,
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
      (s.meter_stop_wh IS NOT NULL) AS effect_confirmed FROM driver_stop_intents i JOIN remote_commands r ON r.id=i.command_id
      JOIN sessions s ON s.id=i.session_id WHERE i.command_id=$1 AND i.driver_id=$2`,
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
    if (!/^[A-Za-z0-9:._-]{1,100}$/.test(key)) throw new ChargingError('invalid_idempotency_key');
  }
}
