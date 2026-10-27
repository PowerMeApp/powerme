import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { ChargePolicy, validateChargePolicy } from './charge-start-policy.js';
import { chargeTransaction } from './charge-sql.js';

export const CHARGE_POLICY = Symbol('WP3_T31_CHARGE_POLICY');

interface BillableSession {
  id: string;
  driver_id: string;
  energy_wh: string | null;
  meter_start_wh: string;
  meter_stop_wh: string | null;
  status: string;
  payment_mode: string;
  received_started_at: Date;
  received_stopped_at: Date | null;
  cp_started_at: Date;
  cp_stopped_at: Date | null;
  promotion_id: string | null;
  delivered_offline: boolean;
  operator_id: string;
}

@Injectable()
export class ChargeSettlementService {
  private readonly logger = new Logger(ChargeSettlementService.name);

  // WP3/T72: stop evidence already owns a durable job; a billing failure must not reject its ACK.
  async settle(sessionId: number): Promise<'posted' | 'already_posted' | 'pending' | 'ineligible'> {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error('invalid_session_id');
    try {
      const result = await this.post(sessionId);
      await this.db.$client.query(
        `UPDATE charge_settlement_jobs SET state=$2,
        reason=CASE WHEN $2='pending' THEN reason ELSE $3 END,
        attempts=attempts+1,last_error_code=NULL,next_attempt_at=now()+interval '30 seconds',updated_at=now()
        WHERE session_id=$1 AND state<>'posted'`,
        [sessionId, result === 'already_posted' ? 'posted' : result, result],
      );
      return result;
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        /^[A-Z0-9]{5}$/.test(String(error.code))
          ? String(error.code)
          : 'billing_error';
      this.logger.error(`WP3/T72 settlement pending: session=${sessionId} code=${code}`);
      try {
        await this.db.$client.query(
          `UPDATE charge_settlement_jobs SET reason='transient_error',
          attempts=attempts+1,last_error_code=$2,next_attempt_at=now()+interval '30 seconds',updated_at=now()
          WHERE session_id=$1 AND state='pending'`,
          [sessionId, code],
        );
      } catch {
        this.logger.error(
          `WP3/T72 job remains durable; retry metadata unavailable: session=${sessionId}`,
        );
      }
      return 'pending';
    }
  }

  async retryPending(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('invalid_retry_limit');
    const { rows } = await this.db.$client.query<{ session_id: string }>(
      `SELECT session_id FROM charge_settlement_jobs WHERE state='pending' AND next_attempt_at<=now()
       ORDER BY next_attempt_at,session_id LIMIT $1`,
      [limit],
    );
    for (const row of rows) await this.settle(Number(row.session_id));
    return rows.length;
  }

  // WP3/T72: operator-supplied boundary evidence is audited separately, never fabricated as telemetry.
  async recordTariffBoundary(
    operatorId: number,
    sessionId: number,
    boundaryAt: Date,
    meterWh: number,
    note: string,
  ) {
    if (
      ![operatorId, sessionId].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(meterWh) ||
      meterWh < 0 ||
      !(boundaryAt instanceof Date) ||
      !Number.isFinite(boundaryAt.getTime()) ||
      typeof note !== 'string' ||
      !note.trim() ||
      note.length > 500
    )
      throw new Error('invalid_boundary_evidence');
    await chargeTransaction(this.db, async (c) => {
      const row = (
        await c.query(
          `SELECT s.* FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN sites st ON st.id=cp.site_id JOIN operator_staff staff ON staff.operator_id=st.operator_id
        JOIN users u ON u.id=staff.user_id AND u.role='operator_staff' AND u.account_status='active'
        JOIN operators o ON o.id=st.operator_id AND o.status='active'
        WHERE s.id=$1 AND u.id=$2 FOR UPDATE OF s`,
          [sessionId, operatorId],
        )
      ).rows[0];
      if (!row) throw new Error('not_found');
      // Mốc giá đo theo đồng hồ trụ, cùng trục với pricedSegments (xem chú thích ở đó).
      if (
        !row.received_stopped_at ||
        !row.cp_stopped_at ||
        boundaryAt <= row.cp_started_at ||
        boundaryAt >= row.cp_stopped_at ||
        meterWh < Number(row.meter_start_wh) ||
        row.meter_stop_wh === null ||
        meterWh > Number(row.meter_stop_wh)
      )
        throw new Error('boundary_outside_session');
      if (
        (await c.query('SELECT 1 FROM charging_statements WHERE session_id=$1', [sessionId]))
          .rowCount
      )
        throw new Error('settlement_already_posted');
      const old = (
        await c.query(
          'SELECT meter_wh FROM charge_tariff_boundary_evidence WHERE session_id=$1 AND boundary_at=$2',
          [sessionId, boundaryAt],
        )
      ).rows[0];
      if (old && old.meter_wh !== String(meterWh)) throw new Error('boundary_evidence_conflict');
      await c.query(
        `INSERT INTO charge_tariff_boundary_evidence(session_id,boundary_at,meter_wh,recorded_by,evidence_note)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [sessionId, boundaryAt, meterWh, operatorId, note.trim()],
      );
      await c.query(
        "UPDATE charge_settlement_jobs SET next_attempt_at=now() WHERE session_id=$1 AND state='pending'",
        [sessionId],
      );
    });
  }

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(CHARGE_POLICY) private readonly policy?: ChargePolicy,
  ) {
    if (policy) validateChargePolicy(policy);
  }

  // WP3/T31: minimal settlement bridge in the WP5 domain, gated by WP2 evidence and an app intent.
  private async post(
    sessionId: number,
  ): Promise<'posted' | 'already_posted' | 'pending' | 'ineligible'> {
    if (!this.policy) {
      await this.db.$client.query(
        "UPDATE charge_settlement_jobs SET reason='policy_unconfigured' WHERE session_id=$1 AND state='pending'",
        [sessionId],
      );
      return 'pending';
    }
    const expiry = this.policy.pointsExpiryMonths;
    return chargeTransaction(this.db, async (c) => {
      const pending = async (reason: string): Promise<'pending'> => {
        await c.query(
          "UPDATE charge_settlement_jobs SET reason=$2 WHERE session_id=$1 AND state='pending'",
          [sessionId, reason],
        );
        return 'pending';
      };
      const session = (
        await c.query<BillableSession>(
          `
        SELECT s.*, st.operator_id FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN sites st ON st.id=cp.site_id WHERE s.id=$1 AND s.origin='app_qr'
        AND EXISTS(SELECT 1 FROM driver_charge_intents i WHERE i.session_id=s.id AND i.driver_id=s.driver_id)
        FOR UPDATE OF s`,
          [sessionId],
        )
      ).rows[0];
      if (!session || session.payment_mode !== 'csms_billed' || !session.driver_id)
        return 'ineligible';
      if (
        (await c.query('SELECT 1 FROM charging_statements WHERE session_id=$1', [sessionId]))
          .rowCount
      )
        return 'already_posted';
      if (
        session.status !== 'reconciled' ||
        session.meter_stop_wh === null ||
        session.energy_wh === null ||
        !session.received_stopped_at ||
        !session.cp_stopped_at ||
        session.promotion_id
      )
        // Phiên delivered_offline KHÔNG bị giữ lại: SRS §3.4.2 / BR-P20 — trụ offline hay dữ liệu tới
        // muộn thì vẫn trừ một lần, số dư được âm. Giá tính theo đồng hồ trụ nên không lệch khung.
        return pending(
          session.status !== 'reconciled'
            ? 'awaiting_reconciliation'
            : session.promotion_id
              ? 'promotion_unsupported'
              : 'missing_meter',
        );
      if (
        (
          await c.query(
            'SELECT 1 FROM driver_charge_intents WHERE session_id=$1 AND billing_review_required',
            [sessionId],
          )
        ).rowCount
      )
        return pending('late_start_operator_review');
      const energy = BigInt(session.meter_stop_wh) - BigInt(session.meter_start_wh);
      if (energy < 0n || energy !== BigInt(session.energy_wh)) return pending('invalid_energy');
      const segments = await this.pricedSegments(c, session);
      if (!segments) return pending('tariff_coverage_or_boundary_meter_required');
      const numerator = segments.reduce((sum, segment) => sum + segment.numerator, 0n);
      // WP3/T72: BR-P45 rounds the exact total once, never each tariff portion independently.
      const amount = (numerator + 500n) / 1000n;
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return pending('amount_out_of_range');
      const account = (
        await c.query<{ id: string; balance_vnd: string }>(
          'SELECT id,balance_vnd FROM credit_accounts WHERE driver_id=$1 FOR UPDATE',
          [session.driver_id],
        )
      ).rows[0];
      if (!account) return pending('credit_account_missing');
      if (
        (
          await c.query(
            "SELECT 1 FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
            [sessionId],
          )
        ).rowCount
      )
        return pending('ledger_inconsistent');
      await c.query(
        'INSERT INTO loyalty_accounts(driver_id) VALUES($1) ON CONFLICT(driver_id) DO NOTHING',
        [session.driver_id],
      );
      const loyalty = (
        await c.query<{ id: string }>(
          'SELECT id FROM loyalty_accounts WHERE driver_id=$1 FOR UPDATE',
          [session.driver_id],
        )
      ).rows[0]!;
      const balance = BigInt(account.balance_vnd) - amount;
      const points = amount / 1000n;
      const debit = (
        await c.query<{ id: string }>(
          `
        INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd,session_id)
        SELECT $1,coalesce(max(entry_no),0)+1,'session_debit',$2,$3,$4 FROM credit_transactions
        WHERE credit_account_id=$1 RETURNING id`,
          [account.id, (-amount).toString(), balance.toString(), sessionId],
        )
      ).rows[0]!;
      const earn = (
        await c.query<{ id: string }>(
          `
        INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at,session_id)
        SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,now()+make_interval(months => $3),$4
        FROM loyalty_transactions WHERE loyalty_account_id=$1 RETURNING id`,
          [loyalty.id, points.toString(), expiry, sessionId],
        )
      ).rows[0]!;
      await c.query(
        `UPDATE credit_accounts SET balance_vnd=$2,status=CASE WHEN $2::bigint<0 THEN 'in_shortfall'::credit_account_status ELSE status END,
        updated_at=now() WHERE id=$1`,
        [account.id, balance.toString()],
      );
      await c.query(
        'UPDATE loyalty_accounts SET points_balance=points_balance+$2,updated_at=now() WHERE id=$1',
        [loyalty.id, points.toString()],
      );
      let cumulative = 0n;
      let allocated = 0n;
      for (const segment of segments) {
        cumulative += segment.numerator;
        const rounded = (cumulative + 500n) / 1000n;
        await c.query(
          `INSERT INTO session_tariff_segments(session_id,tariff_period_id,segment_start,
          segment_end,energy_wh,amount_vnd,exact_amount_milli_vnd) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            sessionId,
            segment.tariffId,
            segment.start,
            segment.end,
            segment.energy.toString(),
            (rounded - allocated).toString(),
            segment.numerator.toString(),
          ],
        );
        allocated = rounded;
      }
      await c.query('UPDATE sessions SET total_cost_vnd=$2,updated_at=now() WHERE id=$1', [
        sessionId,
        amount.toString(),
      ]);
      await c.query(
        `INSERT INTO charging_statements(session_id,driver_id,energy_wh,amount_vnd,earned_points,debit_id,loyalty_entry_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          sessionId,
          session.driver_id,
          energy.toString(),
          amount.toString(),
          points.toString(),
          debit.id,
          earn.id,
        ],
      );
      await c.query(
        "UPDATE driver_charge_intents SET state='settled',reserved_vnd=0,version=version+1 WHERE session_id=$1 AND state<>'settled'",
        [sessionId],
      );
      return 'posted';
    });
  }

  private async pricedSegments(c: PoolClient, session: BillableSession) {
    // Trục thời gian là đồng hồ TRỤ (cp_*), không phải lúc CSMS nhận: phiên sạc lúc trụ offline có
    // StopTransaction tới khi nối lại, received_stopped_at lệch hàng giờ và rơi sang khung giá khác.
    // Đối soát (status = reconciled) đã kiểm chuỗi công tơ trên cùng trục cp_timestamp.
    const start = session.cp_started_at;
    const end = session.cp_stopped_at!;
    if (end < start || end.getTime() - start.getTime() > 366 * 86400000) return undefined;
    const { rows } = await c.query<{ id: string; price: string; starts: Date; ends: Date }>(
      `
      SELECT t.id,t.price_per_kwh_vnd AS price,
        ((d.day::date+t.time_start) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS starts,
        ((d.day::date+t.time_end) AT TIME ZONE 'Asia/Ho_Chi_Minh') AS ends
      FROM tariff_periods t CROSS JOIN generate_series(
        ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::timestamp,
        ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::timestamp,interval '1 day') d(day)
      WHERE t.operator_id=$1 AND t.effective_from<=d.day::date
        AND (t.effective_to IS NULL OR t.effective_to>=d.day::date)
        AND ((d.day::date+t.time_start) AT TIME ZONE 'Asia/Ho_Chi_Minh') <= $3
        AND ((d.day::date+t.time_end) AT TIME ZONE 'Asia/Ho_Chi_Minh') > $2
      ORDER BY starts,t.id`,
      [session.operator_id, start, end],
    );
    let cursor = start.getTime();
    let previous = BigInt(session.meter_start_wh);
    const result: {
      tariffId: string;
      start: Date;
      end: Date;
      energy: bigint;
      numerator: bigint;
    }[] = [];
    for (const tariff of rows) {
      const left = Math.max(start.getTime(), tariff.starts.getTime());
      const right = Math.min(end.getTime(), tariff.ends.getTime());
      if (right < left || (right === left && start.getTime() !== end.getTime())) continue;
      if (left !== cursor) return undefined;
      let meter: bigint;
      if (right === end.getTime()) meter = BigInt(session.meter_stop_wh!);
      else {
        // WP3/T72: tariff boundaries need observed aggregate meters, never an invented split.
        const sample = (
          await c.query<{ wh: string }>(
            `SELECT CASE WHEN unit='kWh' THEN value*1000 ELSE value END AS wh
          FROM meter_values WHERE session_id=$1 AND cp_timestamp=$2 AND measurand='Energy.Active.Import.Register'
          AND phase IS NULL AND (unit IN ('Wh','kWh') OR unit IS NULL)`,
            [session.id, new Date(right)],
          )
        ).rows;
        const evidence = (
          await c.query<{ meter_wh: string }>(
            `SELECT meter_wh FROM charge_tariff_boundary_evidence
          WHERE session_id=$1 AND boundary_at=$2`,
            [session.id, new Date(right)],
          )
        ).rows[0];
        if (sample.length > 1 || (sample.length === 1 && !/^\d+(?:\.0+)?$/.test(sample[0]!.wh)))
          return undefined;
        if (!sample.length && !evidence) return undefined;
        meter = sample.length ? BigInt(sample[0]!.wh.split('.')[0]!) : BigInt(evidence!.meter_wh);
        if (evidence && meter !== BigInt(evidence.meter_wh)) return undefined;
      }
      const energy = meter - previous;
      if (energy < 0n) return undefined;
      result.push({
        tariffId: tariff.id,
        start: new Date(left),
        end: new Date(right),
        energy,
        numerator: energy * BigInt(tariff.price),
      });
      previous = meter;
      cursor = right;
    }
    if (
      !result.length ||
      cursor !== end.getTime() ||
      result.reduce((sum, portion) => sum + portion.energy, 0n) !== BigInt(session.energy_wh!)
    )
      return undefined;
    return result;
  }
}
