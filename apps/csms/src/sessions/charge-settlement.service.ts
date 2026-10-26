import { Inject, Injectable, Optional } from '@nestjs/common';
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
  promotion_id: string | null;
  delivered_offline: boolean;
  operator_id: string;
}

@Injectable()
export class ChargeSettlementService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(CHARGE_POLICY) private readonly policy?: ChargePolicy,
  ) {
    if (policy) validateChargePolicy(policy);
  }

  // WP3/T31: minimal settlement bridge in the WP5 domain, gated by WP2 evidence and an app intent.
  async settle(sessionId: number): Promise<'posted' | 'already_posted' | 'pending' | 'ineligible'> {
    if (!this.policy) return 'pending';
    const expiry = this.policy.pointsExpiryMonths;
    return chargeTransaction(this.db, async (c) => {
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
        session.promotion_id ||
        session.delivered_offline
      )
        return 'pending';
      const energy = BigInt(session.meter_stop_wh) - BigInt(session.meter_start_wh);
      if (energy < 0n || energy !== BigInt(session.energy_wh)) return 'pending';
      const tariff = await this.coveredTariff(c, session);
      if (!tariff) return 'pending';
      const numerator = energy * BigInt(tariff.price_per_kwh_vnd);
      // WP3/T31: unresolved fractional-VND rounding and tariff boundaries remain pending.
      if (numerator % 1000n !== 0n) return 'pending';
      const amount = numerator / 1000n;
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return 'pending';
      const account = (
        await c.query<{ id: string; balance_vnd: string }>(
          'SELECT id,balance_vnd FROM credit_accounts WHERE driver_id=$1 FOR UPDATE',
          [session.driver_id],
        )
      ).rows[0];
      if (!account) return 'pending';
      if (
        (
          await c.query(
            "SELECT 1 FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
            [sessionId],
          )
        ).rowCount
      )
        return 'pending';
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
      await c.query(
        `INSERT INTO session_tariff_segments(session_id,tariff_period_id,segment_start,segment_end,energy_wh,amount_vnd)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          sessionId,
          tariff.id,
          session.received_started_at,
          session.received_stopped_at,
          energy.toString(),
          amount.toString(),
        ],
      );
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

  private async coveredTariff(c: PoolClient, session: BillableSession) {
    const rows = (
      await c.query<{ id: string; price_per_kwh_vnd: string; covers: boolean }>(
        `
      SELECT id,price_per_kwh_vnd,
        (effective_from <= ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         AND (effective_to IS NULL OR effective_to >= ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
         AND time_start <= ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::time
         AND time_end >= ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::time
         AND ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS covers
      FROM tariff_periods WHERE operator_id=$1
        AND effective_from <= ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        AND (effective_to IS NULL OR effective_to >= ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
        AND time_start < ($3::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::time
        AND time_end > ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::time`,
        [session.operator_id, session.received_started_at, session.received_stopped_at],
      )
    ).rows;
    return rows.length === 1 && rows[0]!.covers ? rows[0] : undefined;
  }
}
