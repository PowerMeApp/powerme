import { Logger } from '@nestjs/common';
import type { Db } from '../db/db.module.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import type { ChargePolicy } from './charge-start-policy.js';
import { ChargeSettlementService } from './charge-settlement.service.js';
import { availableCreditSql, unresolvedRfidSql } from './credit-availability.js';
import { chargeTransaction } from './charge-sql.js';

// WP3: one durable decision and cumulative attempt budget per RFID session, independent of driver Stop.
export class RfidCreditProtection {
  private cursor = 0;
  private readonly running = new Set<number>();
  private readonly dirty = new Set<number>();
  private readonly logger = new Logger(RfidCreditProtection.name);
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectionRegistry,
    private readonly settlement: ChargeSettlementService,
    private readonly policy: ChargePolicy,
  ) {}

  async onSession(transactionNo: number): Promise<void> {
    if (this.running.has(transactionNo)) {
      this.dirty.add(transactionNo);
      return;
    }
    if (this.running.size >= 4) return;
    this.running.add(transactionNo);
    try {
      await this.protect(transactionNo);
    } finally {
      this.running.delete(transactionNo);
      if (this.dirty.delete(transactionNo))
        setImmediate(() => {
          void this.onSession(transactionNo).catch(() =>
            this.logger.error('WP3 deferred RFID check failed; recovery retained'),
          );
        });
    }
  }

  private async protect(transactionNo: number): Promise<void> {
    const prepared = await chargeTransaction(this.db, async (c) => {
      const s = (
        await c.query(
          `SELECT s.*,cp.serial_number,cp.current_epoch,cp.is_online FROM sessions s
        JOIN charge_points cp ON cp.id=s.charge_point_id WHERE s.transaction_no=$1
        AND s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL FOR UPDATE OF s`,
          [transactionNo],
        )
      ).rows[0];
      if (!s) return null;
      let job = (
        await c.query('SELECT * FROM rfid_stop_jobs WHERE session_id=$1 FOR UPDATE', [s.id])
      ).rows[0];
      if (s.received_stopped_at) {
        if (job && job.state !== 'completed')
          await c.query(
            "UPDATE rfid_stop_jobs SET state='completed',updated_at=now() WHERE session_id=$1",
            [s.id],
          );
        return null;
      }
      if (job && ['completed', 'exhausted'].includes(job.state)) return null;
      if (!['active', 'paused', 'stopping', 'orphaned', 'review'].includes(s.status)) return null;
      if (!job) {
        const account = (
          await c.query('SELECT * FROM credit_accounts WHERE driver_id=$1 FOR UPDATE', [
            s.driver_id,
          ])
        ).rows[0];
        let hold = (
          await c.query("SELECT * FROM rfid_credit_holds WHERE session_id=$1 AND state='held'", [
            s.id,
          ])
        ).rows[0];
        const coverage = account
          ? (
              await c.query(
                `SELECT ${availableCreditSql('a.driver_id', 'a.balance_vnd', '$2')} AS available,
          ${unresolvedRfidSql('a.driver_id', '$2')} AS blocked FROM credit_accounts a WHERE a.id=$1`,
                [account.id, s.id],
              )
            ).rows[0]
          : null;
        let meter: Awaited<ReturnType<ChargeSettlementService['meteredProgress']>> = null;
        let meterError = false;
        try {
          meter = await this.settlement.meteredProgress(
            c,
            Number(s.id),
            this.policy.stationStaleAfterMs,
          );
        } catch {
          meterError = true;
        }
        const price = (
          await c.query(
            `SELECT max(t.price_per_kwh_vnd) AS price FROM tariff_periods t
          JOIN sites st ON st.operator_id=t.operator_id JOIN charge_points cp ON cp.site_id=st.id
          WHERE cp.id=$1 AND t.effective_from<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (t.effective_to IS NULL OR t.effective_to>=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)`,
            [s.charge_point_id],
          )
        ).rows[0]?.price;
        // WP3: replay creates debt only; one validated live meter may establish its initial budget once.
        if (hold?.reason === 'offline_obligation' && BigInt(hold.amount_vnd) === 0n) {
          if (!meter?.fresh) return null;
          if (
            account?.status === 'active' &&
            Number(coverage?.blocked) === 0 &&
            BigInt(coverage.available) >= BigInt(this.policy.minimumStartVnd)
          ) {
            hold =
              (
                await c.query(
                  `UPDATE rfid_credit_holds SET amount_vnd=$2,reason='live_recovered',updated_at=now()
              WHERE session_id=$1 AND state='held' AND amount_vnd=0 AND reason='offline_obligation' RETURNING *`,
                  [s.id, coverage.available],
                )
              ).rows[0] ?? hold;
          }
        }
        let reason: string | null = null;
        const reserve = BigInt(this.policy.cutoffReserveVnd);
        if (
          !account ||
          account.status !== 'active' ||
          !hold ||
          BigInt(hold.amount_vnd) === 0n ||
          Number(coverage?.blocked) > 0
        )
          reason = 'unfunded_obligation';
        else if (BigInt(coverage.available) <= reserve || BigInt(hold.amount_vnd) <= reserve)
          reason = 'credit_cutoff';
        else if (price === null || price === undefined || !/^\d+$/.test(String(price)))
          reason = 'tariff_unavailable';
        else if (meter) {
          const budget =
            BigInt(hold.amount_vnd) < BigInt(coverage.available)
              ? BigInt(hold.amount_vnd)
              : BigInt(coverage.available);
          if ((budget - reserve) * 1000000n <= meter.consumedMilliWh * BigInt(price))
            reason = 'credit_cutoff';
        } else {
          const connection = this.registry.get(s.serial_number);
          if (s.is_online && connection && connection.epoch === s.current_epoch) {
            // WP3: offline/replay is not unsafe meter evidence; each live epoch gets its own window.
            const safety = (
              await c.query<{ unavailable: boolean }>(
                `SELECT ($6::boolean OR coalesce(live.fresh,false)
                OR now()-greatest($4::timestamptz,e.opened_at,live.last_received_at)
                  >=($3::bigint*interval '1 millisecond')) AS unavailable
              FROM charge_points cp JOIN charge_point_connections e
                ON e.charge_point_id=cp.id AND e.epoch=cp.current_epoch
              LEFT JOIN LATERAL (
                SELECT max(m.received_at) AS last_received_at,
                  bool_or(m.received_at>=now()-($3::bigint*interval '1 millisecond')) AS fresh
                FROM meter_values m WHERE m.session_id=$7 AND m.epoch=e.epoch AND NOT m.replayed
                  AND m.phase IS NULL AND m.measurand='Energy.Active.Import.Register'
                  AND m.received_at BETWEEN e.opened_at AND now()
              ) live ON true
              WHERE cp.id=$1 AND cp.is_online AND cp.current_epoch=$2
                AND e.closed_at IS NULL AND e.opened_at=$5`,
                [
                  s.charge_point_id,
                  s.current_epoch,
                  this.policy.stationStaleAfterMs,
                  s.received_started_at,
                  connection.epochOpenedAt,
                  meterError,
                  s.id,
                ],
              )
            ).rows[0];
            if (safety?.unavailable) reason = 'meter_evidence_unavailable';
          }
        }
        if (!reason) return null;
        job = (
          await c.query(
            `INSERT INTO rfid_stop_jobs(session_id,reason,attempt_limit) VALUES($1,$2,$3)
          ON CONFLICT(session_id) DO NOTHING RETURNING *`,
            [s.id, reason, 1 + (this.policy.remoteStopRetryMax ?? 3)],
          )
        ).rows[0];
      }
      if (!job || job.next_attempt_at.getTime() > Date.now()) return null;
      if (job.attempts >= job.attempt_limit) {
        await c.query(
          `UPDATE rfid_stop_jobs SET state='exhausted',exhausted_at=coalesce(exhausted_at,now()),
          last_error='stop_retry_exhausted',updated_at=now() WHERE session_id=$1`,
          [s.id],
        );
        if (job.current_command_id)
          await c.query(
            "UPDATE remote_commands SET error='stop_retry_exhausted',updated_at=now() WHERE id=$1",
            [job.current_command_id],
          );
        return null;
      }
      const conn = this.registry.get(s.serial_number);
      if (!s.is_online || !conn || conn.epoch !== s.current_epoch) return null;
      const overlap = (
        await c.query(
          `SELECT 1 FROM sessions other WHERE other.connector_id=$1 AND other.id<>$2
        AND other.received_stopped_at IS NULL AND other.status IN ('pending','active','paused','stopping','orphaned','review')`,
          [s.connector_id, s.id],
        )
      ).rowCount;
      if (overlap) {
        await c.query(
          "UPDATE rfid_stop_jobs SET last_error='conflicting_connector_sessions',next_attempt_at=now()+($2::bigint*interval '1 millisecond'),updated_at=now() WHERE session_id=$1",
          [s.id, this.policy.remoteStopRetryIntervalMs ?? 30000],
        );
        return null;
      }
      const freshStart = !s.delivered_offline && s.received_started_at >= conn.epochOpenedAt;
      let validLive = false;
      try {
        validLive = Boolean(
          (await this.settlement.meteredProgress(c, Number(s.id), this.policy.stationStaleAfterMs))
            ?.fresh,
        );
      } catch {
        /* WP3: invalid meter cannot fund a session. */
      }
      const liveEvidence =
        validLive ||
        (
          await c.query(
            `SELECT 1 FROM meter_values m WHERE m.session_id=$1 AND m.epoch=$2
        AND m.phase IS NULL AND m.measurand='Energy.Active.Import.Register' AND NOT m.replayed
        AND m.received_at BETWEEN $3 AND now() AND m.cp_timestamp BETWEEN $3 AND now()
        AND m.received_at>=now()-($4::bigint*interval '1 millisecond')`,
            [s.id, conn.epoch, conn.epochOpenedAt, this.policy.stationStaleAfterMs],
          )
        ).rowCount;
      if (!freshStart && !liveEvidence) {
        await c.query(
          "UPDATE rfid_stop_jobs SET last_error='awaiting_live_evidence',next_attempt_at=now()+($2::bigint*interval '1 millisecond'),updated_at=now() WHERE session_id=$1",
          [s.id, this.policy.remoteStopRetryIntervalMs ?? 30000],
        );
        return null;
      }
      const command = (
        await c.query(
          `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,idempotency_key,sent_at)
        VALUES($1,$2,'RemoteStopTransaction',$3,'sent',$4,now()) RETURNING id`,
          [
            s.charge_point_id,
            s.connector_no,
            JSON.stringify({ transactionId: s.transaction_no }),
            `wp3:rfid-stop:${s.id}:${job.attempts + 1}`,
          ],
        )
      ).rows[0];
      // WP3: commit the lease/attempt before RPC; a crash consumes this same finite budget.
      await c.query(
        `UPDATE rfid_stop_jobs SET state='inflight',attempts=attempts+1,current_command_id=$2,
        next_attempt_at=now()+($3::bigint*interval '1 millisecond'),last_error=NULL,updated_at=now() WHERE session_id=$1`,
        [
          s.id,
          command.id,
          this.policy.commandTimeoutMs + (this.policy.remoteStopRetryIntervalMs ?? 30000),
        ],
      );
      if (['active', 'paused'].includes(s.status)) {
        await c.query("UPDATE sessions SET status='stopping',updated_at=now() WHERE id=$1", [s.id]);
        await c.query(
          `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor,note)
          VALUES($1,$2,'stopping','STOP_REQUESTED','system',$3)`,
          [s.id, s.status, job.reason],
        );
      }
      return {
        sessionId: s.id,
        commandId: command.id,
        transactionNo: s.transaction_no,
        identity: s.serial_number,
        epoch: conn.epoch,
      };
    });
    if (!prepared) return;
    let status = 'timeout',
      response: unknown = null;
    const live = this.registry.get(prepared.identity);
    const stopped = (
      await this.db.$client.query('SELECT received_stopped_at FROM sessions WHERE id=$1', [
        prepared.sessionId,
      ])
    ).rows[0]?.received_stopped_at;
    if (!stopped && live?.epoch === prepared.epoch) {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          response = await Promise.race([
            live.client.call(
              'RemoteStopTransaction',
              { transactionId: prepared.transactionNo },
              { callTimeoutMs: this.policy.commandTimeoutMs },
            ),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('command_timeout')),
                this.policy.commandTimeoutMs,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        const result = (response as { status?: string })?.status;
        if (result === 'Accepted') status = 'accepted';
        else if (result === 'Rejected') status = 'rejected';
      } catch {
        /* WP3: timeout is unknown; the same job retains the attempt. */
      }
    }
    await chargeTransaction(this.db, async (c) => {
      const session = (
        await c.query('SELECT received_stopped_at FROM sessions WHERE id=$1 FOR UPDATE', [
          prepared.sessionId,
        ])
      ).rows[0];
      await c.query(
        `UPDATE remote_commands SET status=$2,response=$3,responded_at=now(),error=$4,updated_at=now() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=$5 AND received_stopped_at IS NOT NULL)`,
        [
          prepared.commandId,
          status,
          JSON.stringify(response),
          status === 'timeout' ? 'outcome_unknown' : null,
          prepared.sessionId,
        ],
      );
      await c.query(
        `UPDATE rfid_stop_jobs SET state=$3,last_error=$4,updated_at=now()
        WHERE session_id=$1 AND current_command_id=$2 AND state NOT IN ('completed','exhausted')`,
        [
          prepared.sessionId,
          prepared.commandId,
          session?.received_stopped_at
            ? 'completed'
            : status === 'accepted'
              ? 'awaiting_stop'
              : 'retry',
          session?.received_stopped_at
            ? null
            : status === 'accepted'
              ? 'awaiting_stop'
              : status === 'rejected'
                ? 'remote_stop_rejected'
                : 'outcome_unknown',
        ],
      );
    });
  }

  async sweep(): Promise<number> {
    const rows = (
      await this.db.$client.query(
        `SELECT s.id,s.transaction_no FROM sessions s
      LEFT JOIN rfid_stop_jobs j ON j.session_id=s.id WHERE s.origin='rfid' AND s.payment_mode='csms_billed'
      AND s.driver_id IS NOT NULL AND (
        (s.received_stopped_at IS NULL AND s.status IN ('active','paused','stopping','orphaned','review')
          AND (j.session_id IS NULL OR (j.state NOT IN ('completed','exhausted') AND j.next_attempt_at<=now())))
        OR (s.received_stopped_at IS NOT NULL AND j.session_id IS NOT NULL AND j.state<>'completed'))
      ORDER BY (s.id>$1) DESC,s.id LIMIT 50`,
        [this.cursor],
      )
    ).rows;
    for (const row of rows) {
      if (this.running.size >= 4) break;
      this.cursor = Number(row.id);
      void this.onSession(row.transaction_no).catch(() =>
        this.logger.error('WP3 RFID protection failed; durable exposure retained'),
      );
    }
    return rows.length;
  }
}
