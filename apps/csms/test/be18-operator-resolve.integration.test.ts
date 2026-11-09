/**
 * BE-18 — STM-1 #17 OPERATOR_RESOLVED (SessionReviewService.resolveReview) trên Postgres thật.
 *
 * Phiên `review` được tạo bằng đường thật khi có thể (orphaned → hard cap → review); phiên có
 * StopTransaction dùng INSERT trực tiếp vì chỉ cần xác nhận lời gọi quyết toán.
 */
import { Logger } from '@nestjs/common';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { ChargePolicy } from '../src/sessions/charge-start-policy.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import {
  SessionReviewError,
  SessionReviewService,
} from '../src/sessions/session-review.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionTimersService } from '../src/sessions/session-timers.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const HOUR = 3_600_000;
const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 150,
  stationStaleAfterMs: 600000,
};

describeDb('BE-18 operator resolves a review session (STM-1 #17)', () => {
  let db: Db;
  let cpId: number;
  let connectorId: number;
  let opStaff: number;
  let otherOpStaff: number;
  let driverUser: number;
  let adminUser: number;
  let settlement: ChargeSettlementService;
  let service: SessionReviewService;
  let seq = 0;
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;

  async function user(email: string, role: string) {
    return Number(
      (
        await q('INSERT INTO users(email,full_name,role) VALUES($1,$3,$2) RETURNING id', [
          email,
          role,
          'Test user',
        ])
      )[0]!.id,
    );
  }
  async function staffOf(operatorId: number, email: string) {
    const id = await user(email, 'operator_staff');
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      id,
      operatorId,
    ]);
    return id;
  }
  async function session(status: string, stopped = false) {
    const n = ++seq;
    return Number(
      (
        await q(
          `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,status,
             cp_started_at,meter_start_wh,meter_stop_wh,cp_stopped_at,received_stopped_at,energy_wh)
           VALUES($1,$2,1,$3,'rfid','unattributed',$4,now()-interval '2 hours',$5,
             $6,$7,$8,$9) RETURNING id`,
          [
            connectorId,
            cpId,
            `TAG${n}`,
            status,
            n,
            stopped ? n + 500 : null,
            stopped ? new Date() : null,
            stopped ? new Date() : null,
            stopped ? 500 : null,
          ],
        )
      )[0]!.id,
    );
  }
  const status = async (id: number) =>
    (await q('SELECT status FROM sessions WHERE id=$1', [id]))[0]!.status;
  const history = (id: number) =>
    q(
      'SELECT from_status,to_status,event,actor,note FROM session_status_history WHERE session_id=$1 ORDER BY id',
      [id],
    );
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(SessionReviewError);
      return (e as SessionReviewError).code;
    }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('BE-18 requires powerme_test');
    Logger.overrideLogger(['error']);
    db = createDb(url);
  });
  beforeEach(async () => {
    seq = 0;
    await resetAndMigrate(db.$client);
    const op = Number(
      (await q("INSERT INTO operators(tax_code,legal_name) VALUES('B18A','Op A') RETURNING id"))[0]!
        .id,
    );
    const other = Number(
      (await q("INSERT INTO operators(tax_code,legal_name) VALUES('B18B','Op B') RETURNING id"))[0]!
        .id,
    );
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('B18',$1,'B18') RETURNING id",
        [op],
      )
    )[0]!.id;
    cpId = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle)
           VALUES('B18-CP','PM-D1-HCM-0018',$1,'in_service') RETURNING id`,
          [site],
        )
      )[0]!.id,
    );
    connectorId = Number(
      (
        await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id', [
          cpId,
        ])
      )[0]!.id,
    );
    opStaff = await staffOf(op, 'a@b18.test');
    otherOpStaff = await staffOf(other, 'b@b18.test');
    driverUser = await user('driver@b18.test', 'driver');
    adminUser = await user('admin@b18.test', 'admin');
    settlement = new ChargeSettlementService(db, policy);
    service = new SessionReviewService(db, settlement);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('resolves a hard-capped session end to end: history, record review, no settlement without a stop', async () => {
    // Đường thật: active → STATION_OFFLINE (30 h trước) → HARD_CAP_EXCEEDED → review.
    const config = {
      sessionStartTimeoutS: 120,
      sessionHardCapH: 24,
    } as unknown as CsmsConfig;
    const sid = await session('active');
    const sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
    await sessionsService.onStationOffline(cpId, new Date(Date.now() - 30 * HOUR));
    const timers = new SessionTimersService(
      db,
      config,
      new DriverChargingService(db, new ConnectionRegistry(db), settlement, policy),
      new ReconciliationService(db, config),
    );
    expect(await timers.expireHardCapped()).toBe(1);
    expect(await status(sid)).toBe('review');

    const settle = jest.spyOn(settlement, 'settle');
    const result = await service.resolveReview(
      sid,
      opStaff,
      'accepted_no_charge',
      'Station off-site, no energy billed',
    );
    expect(result).toEqual({
      sessionId: sid,
      status: 'reconciled',
      recordsReviewed: 1,
      settlement: null,
    });
    expect(settle).not.toHaveBeenCalled();
    expect(await status(sid)).toBe('reconciled');
    const h = await history(sid);
    expect(h.at(-1)).toMatchObject({
      from_status: 'review',
      to_status: 'reconciled',
      event: 'OPERATOR_RESOLVED',
      actor: String(opStaff),
      note: 'accepted_no_charge: Station off-site, no energy billed',
    });
    const [rec] = await q(
      'SELECT reviewed_by,reviewed_at,resolution FROM reconciliation_records WHERE session_id=$1',
      [sid],
    );
    expect(Number(rec!.reviewed_by)).toBe(opStaff);
    expect(rec!.reviewed_at).not.toBeNull();
    expect(rec!.resolution).toMatch(
      /^hard_cap_exceeded: .* \| operator_resolved\(accepted_no_charge\): Station off-site/,
    );
  });

  it('calls the existing settlement once when the session already has a StopTransaction', async () => {
    const sid = await session('review', true);
    const settle = jest.spyOn(settlement, 'settle');
    const result = await service.resolveReview(
      sid,
      opStaff,
      'meter_confirmed',
      'Meter photo checked',
    );
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(sid);
    // payment_mode unattributed → settle() trả 'ineligible' (không có tài xế để trừ tiền).
    expect(result.settlement).toBe('ineligible');
    expect(await status(sid)).toBe('reconciled');
  });

  it('closes only the verdict records of that session, leaving informational ones and other sessions alone', async () => {
    const sid = await session('review', true);
    const other = await session('review', true);
    await q(
      `INSERT INTO reconciliation_records(session_id,record_no,record_type,resolution) VALUES
       ($1,1,'conflict','conflict: diff=801'),($1,2,'replay','replay: x'),($1,3,'meter_gap','gap_detected: y'),
       ($2,1,'conflict','conflict: diff=5')`,
      [sid, other],
    );
    const result = await service.resolveReview(sid, opStaff, 'meter_confirmed', 'ok');
    expect(result.recordsReviewed).toBe(2);
    const rows = await q(
      'SELECT session_id,record_type,reviewed_by FROM reconciliation_records ORDER BY session_id,record_no',
    );
    expect(
      rows.map((r) => `${r.session_id}:${r.record_type}:${r.reviewed_by === null ? '-' : 'R'}`),
    ).toEqual([
      `${sid}:conflict:R`,
      `${sid}:replay:-`,
      `${sid}:meter_gap:R`,
      `${other}:conflict:-`,
    ]);
    expect(await status(other)).toBe('review');
  });

  it('refuses callers that are not active operator_staff of the owning operator', async () => {
    const sid = await session('review');
    expect(await code(service.resolveReview(sid, driverUser, 'x', 'n'))).toBe('forbidden');
    expect(await code(service.resolveReview(sid, adminUser, 'x', 'n'))).toBe('forbidden');
    expect(await code(service.resolveReview(sid, 999999, 'x', 'n'))).toBe('forbidden');
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [opStaff]);
    expect(await code(service.resolveReview(sid, opStaff, 'x', 'n'))).toBe('forbidden');
    await q("UPDATE users SET account_status='active' WHERE id=$1", [opStaff]);
    // Nhân viên của operator KHÁC: không lộ phiên.
    expect(await code(service.resolveReview(sid, otherOpStaff, 'x', 'n'))).toBe('not_found');
    expect(await status(sid)).toBe('review');
    expect(await history(sid)).toHaveLength(0);
  });

  it.each([
    'pending',
    'active',
    'paused',
    'stopping',
    'closed',
    'orphaned',
    'reconciled',
    'failed',
  ])('refuses a %s session and leaves it untouched', async (st) => {
    const sid = await session(st);
    expect(await code(service.resolveReview(sid, opStaff, 'x', 'n'))).toBe('not_in_review');
    expect(await status(sid)).toBe(st);
    expect(await history(sid)).toHaveLength(0);
  });

  it('unknown session id is not_found', async () => {
    expect(await code(service.resolveReview(424242, opStaff, 'x', 'n'))).toBe('not_found');
  });

  it('is single-shot: a second or concurrent resolve is refused and leaves one trace', async () => {
    const sid = await session('review');
    const results = await Promise.allSettled([
      service.resolveReview(sid, opStaff, 'a', 'first'),
      service.resolveReview(sid, opStaff, 'b', 'second'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as SessionReviewError).code).toBe('not_in_review');
    expect((await history(sid)).filter((r) => r.event === 'OPERATOR_RESOLVED')).toHaveLength(1);
    expect(await code(service.resolveReview(sid, opStaff, 'c', 'third'))).toBe('not_in_review');
  });

  it.each([
    ['session id', 0, 'ok', 'note'],
    ['uppercase resolution', 1, 'Bad', 'note'],
    ['empty resolution', 1, '', 'note'],
    ['spaces in resolution', 1, 'a b', 'note'],
    ['blank note', 1, 'ok', '   '],
    ['too long note', 1, 'ok', 'x'.repeat(501)],
  ])('rejects invalid input: %s', async (_name, sid, resolution, note) => {
    expect(await code(service.resolveReview(sid, opStaff, resolution, note))).toBe('invalid_input');
  });
});
