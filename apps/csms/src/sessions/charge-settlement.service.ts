import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { LedgerPostRejected } from '../billing/billing-errors.js';
import { CreditLedgerService } from '../billing/credit-ledger.service.js';
import { LoyaltyService } from '../billing/loyalty.service.js';
import {
  CONFIG,
  CsmsConfig,
  DEFAULT_REPLAY_SKEW_S,
  DEFAULT_TARIFF_CLOCK_TOLERANCE_S,
} from '../config.js';
import { DB, Db } from '../db/db.module.js';
import {
  meterAt,
  MeterPoint,
  resolveTariffClock,
  resolveActiveTariffClock,
  TARIFF_BOUNDARY_INTERPOLATED_PREFIX,
  TARIFF_CLOCK_FALLBACK_PREFIX,
  TARIFF_CLOCK_OFFSET_PREFIX,
  TARIFF_CLOCK_UNTRUSTED,
} from '../reconciliation/tariff-clock.js';
import { ChargePolicy, validateChargePolicy } from './charge-start-policy.js';
import { chargeTransaction } from './charge-sql.js';
import {
  meteredCostBounds,
  scaledInteger,
  type MeteredCostBounds,
  type MeterPoint as ExactMeterPoint,
  type TariffWindow,
} from './charge-mode-policy.js';

export const CHARGE_POLICY = Symbol('WP3_T31_CHARGE_POLICY');

interface BillableSession {
  id: string;
  charge_point_id: string;
  connector_no: number;
  id_tag: string;
  transaction_no: number;
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
  operator_id: string;
}

type StoppedSession = BillableSession & { received_stopped_at: Date; meter_stop_wh: string };

// T134 (BR-P02): `cp` = giờ trụ dùng nguyên; `cp_offset` = giờ trụ + độ lệch đo được (start / end đã
// cộng); `csms` = không có độ lệch nào dùng được, cả phiên một khung giá lúc CSMS nhận start.
type PricingTimeline = { start: Date; end: Date } & (
  | { clock: 'cp' }
  | { clock: 'cp_offset'; offsetMs: number; epoch: number | null; liveFrames: number }
  | { clock: 'csms'; reason: string }
);

interface PricedSegment {
  tariffId: string;
  start: Date;
  end: Date;
  energy: bigint;
  numerator: bigint;
}

/** Các phần giá của phiên, kèm số biên khung giá phải nội suy số đo (0 = không biên nào). */
interface PricedSession {
  segments: PricedSegment[];
  interpolated: number;
  maxGapMs: number;
}

@Injectable()
export class ChargeSettlementService {
  private readonly logger = new Logger(ChargeSettlementService.name);

  // WP3: active pricing shares T134 clock/interpolation policy; it never writes billing evidence.
  async meteredProgress(
    c: PoolClient,
    sessionId: number,
    staleMs: number,
    lastKnown = false,
  ): Promise<{
    consumedMilliWh: bigint;
    bounds: MeteredCostBounds | null;
    fresh: boolean;
    estimateVnd: number | null;
    costQuality: 'exact' | 'interpolated' | 'unknown';
    pricingClock: 'cp' | 'cp_offset' | 'csms';
  } | null> {
    const session = (
      await c.query<BillableSession>(
        `SELECT s.*,st.operator_id FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
       JOIN sites st ON st.id=cp.site_id WHERE s.id=$1`,
        [sessionId],
      )
    ).rows[0];
    if (!session) return null;
    const issues = (
      await c.query<{ event: string }>(
        `SELECT event FROM session_status_history WHERE session_id=$1
       AND event IN ('METER_EVIDENCE_CONFLICT','TARIFF_CLOCK_UNTRUSTED')`,
        [sessionId],
      )
    ).rows;
    if (issues.some((r) => r.event === 'METER_EVIDENCE_CONFLICT')) return null;
    const samples = (
      await c.query<{
        wh: string;
        at: Date;
        receivedAt: Date;
        epoch: number;
        replayed: boolean;
        current: boolean;
        fresh: boolean;
      }>(
        `SELECT CASE WHEN m.unit='kWh' THEN m.value*1000 ELSE m.value END AS wh,
         m.cp_timestamp AS at,m.received_at AS "receivedAt",m.epoch,m.replayed,
         m.epoch=cp.current_epoch AS current,
         (cp.is_online AND m.epoch=cp.current_epoch AND m.received_at>=cp.online_changed_at
          AND extract(epoch FROM (now()-m.received_at))*1000<=$2::numeric) AS fresh
       FROM meter_values m JOIN sessions s ON s.id=m.session_id
       JOIN charge_points cp ON cp.id=s.charge_point_id
       JOIN charge_point_connections e ON e.charge_point_id=s.charge_point_id AND e.epoch=m.epoch
       WHERE m.session_id=$1 AND m.measurand='Energy.Active.Import.Register'
         AND m.phase IS NULL AND (m.unit IN ('Wh','kWh') OR m.unit IS NULL)
         AND m.received_at BETWEEN s.received_started_at AND now()
         AND m.received_at>=e.opened_at AND (e.closed_at IS NULL OR m.received_at<=e.closed_at)
       ORDER BY m.cp_timestamp,m.received_at,m.id`,
        [sessionId, staleMs],
      )
    ).rows;
    const latest = samples.at(-1);
    if (!latest || !latest.current || (!lastKnown && !latest.fresh)) return null;
    const tolerance =
      (this.config?.tariffClockToleranceS ?? DEFAULT_TARIFF_CLOCK_TOLERANCE_S) * 1000;
    const liveWindow = (this.config?.replaySkewThresholdS ?? DEFAULT_REPLAY_SKEW_S) * 1000;
    const clock = await resolveActiveTariffClock(c, session, latest, tolerance, liveWindow);
    const fallback = issues.length > 0 || 'issue' in clock;
    const offsetMs = 'issue' in clock ? 0 : clock.offsetMs;
    const lag = latest.receivedAt.getTime() - latest.at.getTime() - offsetMs;
    // WP3: T134 can identify live offset frames even when the raw replay flag says otherwise.
    if (latest.replayed && (fallback || Math.abs(lag) > liveWindow)) return null;
    const baseline = scaledInteger(session.meter_start_wh);
    const finalMeter = scaledInteger(latest.wh);
    if (baseline === null || finalMeter === null || finalMeter < baseline) return null;
    let prior = baseline;
    for (const sample of samples) {
      if (sample.replayed && sample.at < session.cp_started_at) continue;
      const value = scaledInteger(sample.wh);
      if (value === null || value < prior) return null;
      prior = value;
    }
    const consumedMilliWh = finalMeter - baseline;
    const pricingClock: 'cp' | 'cp_offset' | 'csms' = fallback
      ? 'csms'
      : offsetMs
        ? 'cp_offset'
        : 'cp';
    const start = fallback
      ? session.received_started_at
      : new Date(session.cp_started_at.getTime() + offsetMs);
    const end = fallback ? latest.receivedAt : new Date(latest.at.getTime() + offsetMs);
    const unknown = {
      consumedMilliWh,
      bounds: null,
      fresh: latest.fresh,
      estimateVnd: null,
      costQuality: 'unknown' as const,
      pricingClock,
    };
    if (end < start || end.getTime() - start.getTime() > 366 * 86400000) return unknown;
    const tariffs = await this.tariffWindows(c, session.operator_id, start, fallback ? start : end);
    if (fallback) {
      if (tariffs.length !== 1 || !/^\d+$/.test(tariffs[0]!.price)) return unknown;
      const amount = (consumedMilliWh * BigInt(tariffs[0]!.price) + 500000n) / 1000000n;
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return unknown;
      const estimateVnd = Number(amount);
      return {
        consumedMilliWh,
        bounds: { minVnd: estimateVnd, maxVnd: estimateVnd, quality: 'exact' },
        fresh: latest.fresh,
        estimateVnd,
        costQuality: 'exact',
        pricingClock,
      };
    }
    const points: ExactMeterPoint[] = [{ at: start, milliWh: baseline }];
    for (const sample of samples) {
      const at = new Date(sample.at.getTime() + offsetMs);
      const value = scaledInteger(sample.wh);
      const before = points.at(-1)!;
      if (value === null || value < before.milliWh || at < before.at) return null;
      if (at.getTime() === before.at.getTime()) {
        if (value !== before.milliWh) return null;
      } else points.push({ at, milliWh: value });
    }
    const bounds = meteredCostBounds(points, tariffs);
    if (!bounds) return unknown;
    if (bounds.quality === 'exact')
      return { ...unknown, bounds, estimateVnd: bounds.minVnd, costQuality: 'exact' };
    const meterPoints = points.map((p) => ({ at: p.at.getTime(), wh: Number(p.milliWh) / 1000 }));
    let previous = baseline;
    let numerator = 0n;
    let cursor = start.getTime();
    for (const tariff of tariffs) {
      const left = Math.max(start.getTime(), tariff.starts.getTime());
      const right = Math.min(end.getTime(), tariff.ends.getTime());
      if (right <= left) continue;
      if (left !== cursor) return unknown;
      const reading = meterAt(meterPoints, right);
      if (!reading) return unknown;
      let value = right === end.getTime() ? finalMeter : BigInt(Math.round(reading.wh)) * 1000n;
      if (value < previous) value = previous;
      if (value > finalMeter) value = finalMeter;
      numerator += (value - previous) * BigInt(tariff.price);
      previous = value;
      cursor = right;
    }
    const amount = (numerator + 500000n) / 1000000n;
    if (cursor !== end.getTime() || amount > BigInt(Number.MAX_SAFE_INTEGER)) return unknown;
    return { ...unknown, bounds, estimateVnd: Number(amount), costQuality: 'interpolated' };
  }

  // WP3/T72: stop evidence already owns a durable job; a billing failure must not reject its ACK.
  async settle(sessionId: number): Promise<'posted' | 'already_posted' | 'pending' | 'ineligible'> {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error('invalid_session_id');
    try {
      const result = await this.post(sessionId);
      await this.db.$client.query(
        `UPDATE charge_settlement_jobs SET state=$2,
        reason=CASE WHEN $2::varchar='pending' THEN reason ELSE $3 END,
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
        await c.query<BillableSession>(
          `SELECT s.*,st.operator_id FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN sites st ON st.id=cp.site_id JOIN operator_staff staff ON staff.operator_id=st.operator_id
        JOIN users u ON u.id=staff.user_id AND u.role='operator_staff' AND u.account_status='active'
        JOIN operators o ON o.id=st.operator_id AND o.status='active'
        WHERE s.id=$1 AND u.id=$2 FOR UPDATE OF s`,
          [sessionId, operatorId],
        )
      ).rows[0];
      if (!row) throw new Error('not_found');
      if (
        row.status !== 'reconciled' ||
        !row.received_stopped_at ||
        !row.received_started_at ||
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
      const timeline = await this.pricingTimeline(c, {
        ...row,
        received_stopped_at: row.received_stopped_at,
        meter_stop_wh: row.meter_stop_wh,
      });
      // Giờ CSMS tính cả phiên một khung giá (T134): không có biên nào cần số đo.
      if (timeline.clock === 'csms') throw new Error('boundary_not_applicable');
      if (boundaryAt <= timeline.start || boundaryAt >= timeline.end)
        throw new Error('boundary_outside_session');
      const old = (
        await c.query(
          `SELECT meter_wh FROM charge_tariff_boundary_evidence
           WHERE session_id=$1 AND boundary_at=$2 AND pricing_clock=$3`,
          [sessionId, boundaryAt, timeline.clock],
        )
      ).rows[0];
      if (old && old.meter_wh !== String(meterWh)) throw new Error('boundary_evidence_conflict');
      await c.query(
        `INSERT INTO charge_tariff_boundary_evidence(
           session_id,boundary_at,meter_wh,recorded_by,evidence_note,pricing_clock
         ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [sessionId, boundaryAt, meterWh, operatorId, note.trim(), timeline.clock],
      );
      await c.query(
        "UPDATE charge_settlement_jobs SET next_attempt_at=now(),updated_at=now() WHERE session_id=$1 AND state='pending'",
        [sessionId],
      );
    });
  }

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: CreditLedgerService,
    private readonly loyalty: LoyaltyService,
    @Optional() @Inject(CHARGE_POLICY) private readonly policy?: ChargePolicy,
    @Optional() @Inject(CONFIG) private readonly config?: CsmsConfig,
  ) {
    if (policy) validateChargePolicy(policy);
  }

  // WP3/T148: all eligible sessions share one atomic ledger/loyalty path after reconciliation.
  private async post(
    sessionId: number,
  ): Promise<'posted' | 'already_posted' | 'pending' | 'ineligible'> {
    if (!this.policy) {
      await this.db.$client.query(
        "UPDATE charge_settlement_jobs SET reason='policy_unconfigured',updated_at=now() WHERE session_id=$1 AND state='pending'",
        [sessionId],
      );
      return 'pending';
    }
    return chargeTransaction(this.db, async (c) => {
      const pending = async (reason: string): Promise<'pending'> => {
        await c.query(
          "UPDATE charge_settlement_jobs SET reason=$2,updated_at=now() WHERE session_id=$1 AND state='pending'",
          [sessionId, reason],
        );
        return 'pending';
      };
      const session = (
        await c.query<BillableSession>(
          `
        SELECT s.*, st.operator_id FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
        JOIN sites st ON st.id=cp.site_id WHERE s.id=$1 AND (
          (s.origin='app_qr'
            AND EXISTS(SELECT 1 FROM driver_charge_intents i WHERE i.session_id=s.id AND i.driver_id=s.driver_id))
          -- WP3/T148: use captured session ownership, never the current card registry.
          OR (s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL)
          OR (s.origin<>'free_vend' AND EXISTS(SELECT 1 FROM session_status_history h
            WHERE h.session_id=s.id AND h.event='UNATTRIBUTED_ASSIGNED')))
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
        session.promotion_id
      )
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
      const timeline = await this.pricingTimeline(c, {
        ...session,
        received_stopped_at: session.received_stopped_at,
        meter_stop_wh: session.meter_stop_wh,
      });
      // Từ T134 lý do này chỉ còn cho lỗi cấu hình biểu giá (không có, hoặc có hai khung phủ một thời
      // điểm): thiếu mẫu công tơ ở biên không còn giữ phiên, số đo tại biên được nội suy.
      const priced = await this.pricedSegments(c, session, timeline);
      if (!priced) return pending('tariff_coverage_or_boundary_meter_required');
      const { segments } = priced;
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
      const points = amount / 1000n;
      let debit;
      try {
        // WP3/T148: the caller's transaction locks session, then credit, then loyalty (D9).
        debit = await this.ledger.post(c, Number(account.id), 'session_debit', -Number(amount), {
          sessionId,
        });
      } catch (error) {
        if (error instanceof LedgerPostRejected && error.reason === 'account_closed')
          return pending('account_closed');
        throw error;
      }
      const earn = await this.loyalty.earnForSession(
        c,
        Number(session.driver_id),
        sessionId,
        Number(points),
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
      await c.query(
        `UPDATE sessions SET total_cost_vnd=$2,priced_clock=$3,priced_ended_at=$4,updated_at=now()
         WHERE id=$1`,
        [sessionId, amount.toString(), timeline.clock, timeline.end],
      );
      // Mỗi lần chỉnh đồng hồ để lại đúng một bản ghi cho operator (BR-P02), kể cả khi tắt đối soát.
      if (timeline.clock !== 'cp') {
        await c.query(
          `INSERT INTO reconciliation_records(session_id,record_no,record_type,resolution)
           SELECT $1,coalesce(max(record_no),0)+1,$2,$3
           FROM reconciliation_records WHERE session_id=$1`,
          timeline.clock === 'csms'
            ? [sessionId, 'tariff_clock_fallback', TARIFF_CLOCK_FALLBACK_PREFIX + timeline.reason]
            : [
                sessionId,
                'tariff_clock_offset',
                `${TARIFF_CLOCK_OFFSET_PREFIX}${timeline.offsetMs / 1000} epoch=${timeline.epoch} live_frames=${timeline.liveFrames}`,
              ],
        );
      }
      if (priced.interpolated) {
        await c.query(
          `INSERT INTO reconciliation_records(session_id,record_no,record_type,resolution)
           SELECT $1,coalesce(max(record_no),0)+1,'tariff_boundary_interpolated',$2
           FROM reconciliation_records WHERE session_id=$1`,
          [
            sessionId,
            `${TARIFF_BOUNDARY_INTERPOLATED_PREFIX}${priced.interpolated} max_gap_s=${Math.round(priced.maxGapMs / 1000)}`,
          ],
        );
      }
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
        "UPDATE driver_charge_intents SET state='settled',reserved_vnd=0,version=version+1,updated_at=now() WHERE session_id=$1 AND state<>'settled'",
        [sessionId],
      );
      return 'posted';
    });
  }

  private async pricingTimeline(c: PoolClient, session: StoppedSession): Promise<PricingTimeline> {
    const csms = (reason: string): PricingTimeline => ({
      clock: 'csms',
      start: session.received_started_at,
      end: session.received_stopped_at,
      reason,
    });
    // Bản tin mang timestamp không dùng được hoặc StopTransaction lặp đổi giờ: không tin đồng hồ trụ.
    const { rows } = await c.query<{ reason: string }>(
      `SELECT split_part(note,' ',1) AS reason FROM session_status_history
       WHERE session_id=$1 AND event=$2 ORDER BY id LIMIT 1`,
      [session.id, TARIFF_CLOCK_UNTRUSTED],
    );
    if (rows[0]) return csms(rows[0].reason);
    const clock = await resolveTariffClock(
      c,
      session,
      (this.config?.tariffClockToleranceS ?? DEFAULT_TARIFF_CLOCK_TOLERANCE_S) * 1000,
      (this.config?.replaySkewThresholdS ?? DEFAULT_REPLAY_SKEW_S) * 1000,
    );
    if ('issue' in clock || !session.cp_stopped_at)
      return csms('issue' in clock ? clock.issue : 'tariff_clock_invalid_timestamp');
    const start = new Date(session.cp_started_at.getTime() + clock.offsetMs);
    const end = new Date(session.cp_stopped_at.getTime() + clock.offsetMs);
    return clock.offsetMs
      ? { clock: 'cp_offset', start, end, ...clock }
      : { clock: 'cp', start, end };
  }

  /** Giờ CSMS (T134): cả phiên theo MỘT khung giá, khung có hiệu lực lúc CSMS nhận StartTransaction. */
  private async receiptSegment(
    c: PoolClient,
    session: BillableSession,
    timeline: PricingTimeline,
  ): Promise<PricedSession | undefined> {
    const { rows } = await c.query<{ id: string; price: string }>(
      `SELECT t.id,t.price_per_kwh_vnd AS price
       FROM tariff_periods t
       CROSS JOIN (SELECT ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day) d
       WHERE t.operator_id=$1 AND t.effective_from<=d.day
         AND (t.effective_to IS NULL OR t.effective_to>=d.day)
         AND ((d.day+t.time_start) AT TIME ZONE 'Asia/Ho_Chi_Minh') <= $2
         AND ((d.day+t.time_end) AT TIME ZONE 'Asia/Ho_Chi_Minh') > $2
       LIMIT 2`,
      [session.operator_id, timeline.start],
    );
    // Không có hoặc có hai khung giá cùng lúc là lỗi cấu hình giá, không phải lỗi đồng hồ.
    if (rows.length !== 1) return undefined;
    const energy = BigInt(session.energy_wh!);
    return {
      segments: [
        {
          tariffId: rows[0]!.id,
          start: timeline.start,
          end: timeline.end,
          energy,
          numerator: energy * BigInt(rows[0]!.price),
        },
      ],
      interpolated: 0,
      maxGapMs: 0,
    };
  }

  /** Chuỗi số đo tích luỹ của phiên trên trục giờ tính giá: bắt đầu, từng mẫu công tơ, dừng. */
  private async meterPoints(
    c: PoolClient,
    session: BillableSession,
    start: Date,
    end: Date,
    offsetMs: number,
  ): Promise<MeterPoint[]> {
    const { rows } = await c.query<{ at: Date; wh: string }>(
      `SELECT cp_timestamp AS at,CASE WHEN unit='kWh' THEN value*1000 ELSE value END AS wh
       FROM meter_values WHERE session_id=$1 AND measurand='Energy.Active.Import.Register'
         AND phase IS NULL AND (unit IN ('Wh','kWh') OR unit IS NULL)
       ORDER BY cp_timestamp,received_at`,
      [session.id],
    );
    return [
      { at: start.getTime(), wh: Number(session.meter_start_wh) },
      ...rows
        .map((row) => ({ at: row.at.getTime() + offsetMs, wh: Number(row.wh) }))
        .filter((point) => point.at > start.getTime() && point.at < end.getTime()),
      { at: end.getTime(), wh: Number(session.meter_stop_wh) },
    ];
  }

  private async pricedSegments(
    c: PoolClient,
    session: BillableSession,
    timeline: PricingTimeline,
  ): Promise<PricedSession | undefined> {
    const { start, end, clock } = timeline;
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end < start ||
      end.getTime() - start.getTime() > 366 * 86400000
    )
      return undefined;
    if (timeline.clock === 'csms') return this.receiptSegment(c, session, timeline);
    const offsetMs = timeline.clock === 'cp_offset' ? timeline.offsetMs : 0;
    const rows = await this.tariffWindows(c, session.operator_id, start, end);
    let cursor = start.getTime();
    let previous = BigInt(session.meter_start_wh);
    const stop = BigInt(session.meter_stop_wh!);
    const result: PricedSegment[] = [];
    let points: MeterPoint[] | undefined;
    let interpolated = 0;
    let maxGapMs = 0;
    for (const tariff of rows) {
      const left = Math.max(start.getTime(), tariff.starts.getTime());
      const right = Math.min(end.getTime(), tariff.ends.getTime());
      if (right < left || (right === left && start.getTime() !== end.getTime())) continue;
      if (left !== cursor) return undefined;
      let meter: bigint;
      if (right === end.getTime()) meter = stop;
      else {
        // Số đo tại biên, theo thứ tự ưu tiên: bằng chứng của operator → mẫu công tơ đúng biên →
        // nội suy tuyến tính giữa hai số đo kề biên (quyết định 17/11: không giữ phiên vì thiếu mẫu).
        const evidence = (
          await c.query<{ meter_wh: string }>(
            `SELECT meter_wh FROM charge_tariff_boundary_evidence
          WHERE session_id=$1 AND boundary_at=$2 AND pricing_clock=$3`,
            [session.id, new Date(right), clock],
          )
        ).rows[0];
        if (evidence) meter = BigInt(evidence.meter_wh);
        else {
          points ??= await this.meterPoints(c, session, start, end, offsetMs);
          const reading = meterAt(points, right);
          if (!reading || !Number.isFinite(reading.wh)) return undefined;
          meter = BigInt(Math.round(reading.wh));
          if (reading.gapMs) {
            interpolated++;
            maxGapMs = Math.max(maxGapMs, reading.gapMs);
          }
        }
        // Làm tròn Wh tại biên và chuỗi đo không đơn điệu không được làm một phần âm hay vượt
        // meterStop: tổng các phần luôn đúng bằng điện năng của phiên (BR-P45 làm tròn tiền một lần).
        if (meter < previous) meter = previous;
        if (meter > stop) meter = stop;
      }
      const energy = meter - previous;
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
    return { segments: result, interpolated, maxGapMs };
  }
  private async tariffWindows(
    c: PoolClient,
    operatorId: string,
    start: Date,
    end: Date,
  ): Promise<TariffWindow[]> {
    const { rows } = await c.query<TariffWindow>(
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
      [operatorId, start, end],
    );
    return rows;
  }
}
