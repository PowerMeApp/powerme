/**
 * BE-24 (F-12, FR-13, UC-OPS-05) — operator gán / đóng phiên `unattributed`, và route console giải
 * quyết phiên `review`, trên Postgres thật. Mã TC-F12-01..03 trong tên test để truy vết với BM04.
 *
 * Phiên unattributed tạo bằng đường OCPP thật (SessionsService.onStartTransaction/onStopTransaction
 * với InboundContext dựng tay, như card-authorize): thẻ lạ, tag free vend của trụ, thẻ ví bị khoá.
 * Phiên `review` có StopTransaction dùng INSERT trực tiếp (như be18-operator-resolve).
 */
import { Logger } from '@nestjs/common';
import type { CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleError } from '../src/console/console.http.js';
import { createDb, Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import type { ChargePolicy } from '../src/sessions/charge-start-policy.js';
import { SessionReviewService } from '../src/sessions/session-review.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import {
  UnattributedSessionError,
  UnattributedSessionService,
} from '../src/sessions/unattributed-session.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;

const CP = 'BE24-CP-0001';
const FREE_VEND_TAG = 'BE24-FREEVEND';
const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 150,
  stationStaleAfterMs: 600000,
};
const CONFIG: CsmsConfig = {
  databaseUrl: url ?? '',
  ocppPort: 0,
  heartbeatIntervalS: 60,
  sessionStartTimeoutS: 120,
  sessionHardCapH: 24,
  replaySkewThresholdS: 5,
  meterValueSampleIntervalS: 10,
  reconcileGapFactor: 3,
  reconcileEnergyToleranceWh: 1,
  consoleEnabled: false,
  consoleHost: '127.0.0.1',
  consolePort: 0,
};
/** 10:xx giờ Việt Nam ngày 07/11/2026 — nằm trọn trong một khung giá, không qua nửa đêm. */
const T = (mm: number) => new Date(Date.UTC(2026, 10, 7, 3, mm));
/** Giá khung `normal` cả ngày: 5.000 VND/kWh → 2.000 Wh = 10.000 VND, 10 điểm. */
const PRICE = 5000;

describeDb('BE-24 — phiên unattributed (F-12) và route review', () => {
  let db: Db;
  let sessionsService: SessionsService;
  let settlement: ChargeSettlementService;
  let review: SessionReviewService;
  let service: UnattributedSessionService;
  let commands: ConsoleCommands;
  let cpId: number;
  let connectorId: number;
  let opStaff: number;
  let otherOpStaff: number;
  let adminUser: number;
  let driver: number;
  let otherDriver: number;
  let logId = 0;
  let meter = 0;
  let minute = 0;

  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;

  function ctx(at: Date): InboundContext {
    return {
      identity: CP,
      chargePointId: cpId,
      epoch: 1,
      epochOpenedAt: T(0),
      receivedAt: at,
      cpTimestamp: at,
      messageId: `m${++logId}`,
      messageLogId: logId,
      replay: { replayed: false, reason: null, skewS: 0 },
    };
  }

  async function user(email: string, role: string, status = 'active') {
    return Number(
      (
        await q(
          'INSERT INTO users(email,full_name,role,account_status) VALUES($1,$4,$2,$3) RETURNING id',
          [email, role, status, email],
        )
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
  async function driverWith(email: string, opts: { status?: string; credit?: string } = {}) {
    const id = await user(email, 'driver', opts.status ?? 'active');
    await q("INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t',now())", [
      id,
    ]);
    if (opts.credit !== 'none')
      await q(
        `INSERT INTO credit_accounts(driver_id,status,balance_vnd,closed_at)
         VALUES($1,$2::credit_account_status,200000,CASE WHEN $3::boolean THEN now() END)`,
        [id, opts.credit ?? 'active', opts.credit === 'closed'],
      );
    return id;
  }

  /** Đường OCPP thật: StartTransaction (+ StopTransaction nếu `stop`) với 2.000 Wh. */
  async function chargeWith(idTag: string, stop = true): Promise<number> {
    meter += 10000;
    const startAt = T(++minute);
    const r = await sessionsService.onStartTransaction(
      { connectorId: 1, idTag, meterStart: meter, timestamp: startAt.toISOString() },
      ctx(startAt),
    );
    if (stop) {
      const stopAt = T(++minute);
      await sessionsService.onStopTransaction(
        {
          transactionId: r.transactionId,
          meterStop: meter + 2000,
          timestamp: stopAt.toISOString(),
          reason: 'Local',
        },
        ctx(stopAt),
      );
    }
    return Number(
      (await q('SELECT id FROM sessions WHERE transaction_no=$1', [r.transactionId]))[0]!.id,
    );
  }

  /** Phiên unattributed `review` đã có StopTransaction (INSERT trực tiếp, như BE-18). */
  async function reviewSession(): Promise<number> {
    meter += 10000;
    const start = T(++minute);
    const stop = T(++minute);
    return Number(
      (
        await q(
          `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,status,
             cp_started_at,received_started_at,meter_start_wh,meter_stop_wh,cp_stopped_at,received_stopped_at,energy_wh)
           VALUES($1,$2,1,$3,'rfid','unattributed','review',$4,$4,$5,$6,$7,$7,2000) RETURNING id`,
          [connectorId, cpId, `REVIEW-${minute}`, start, meter, meter + 2000, stop],
        )
      )[0]!.id,
    );
  }

  const session = async (id: number) =>
    (
      await q(
        'SELECT status,payment_mode,origin,driver_id,total_cost_vnd FROM sessions WHERE id=$1',
        [id],
      )
    )[0]!;
  const history = (id: number) =>
    q(
      `SELECT from_status,to_status,event,actor,note,occurred_at FROM session_status_history
       WHERE session_id=$1 AND event LIKE 'UNATTRIBUTED_%' ORDER BY id`,
      [id],
    );
  const records = (id: number) =>
    q(
      `SELECT record_type,reviewed_by,reviewed_at,resolution FROM reconciliation_records
       WHERE session_id=$1 ORDER BY record_no`,
      [id],
    );
  const debits = (id: number) =>
    q(
      "SELECT amount_vnd FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
      [id],
    );
  const balance = async (driverId: number) =>
    Number(
      (await q('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [driverId]))[0]!
        .balance_vnd,
    );
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(UnattributedSessionError);
      return (e as UnattributedSessionError).code;
    }
    throw new Error('expected rejection');
  };

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('BE-24 requires powerme_test');
    Logger.overrideLogger(['error']);
    db = createDb(url);
  });
  beforeEach(async () => {
    logId = 0;
    meter = 0;
    minute = 0;
    await resetAndMigrate(db.$client);
    const op = Number(
      (await q("INSERT INTO operators(tax_code,legal_name) VALUES('B24A','Op A') RETURNING id"))[0]!
        .id,
    );
    const other = Number(
      (await q("INSERT INTO operators(tax_code,legal_name) VALUES('B24B','Op B') RETURNING id"))[0]!
        .id,
    );
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('B24',$1,'B24') RETURNING id",
        [op],
      )
    )[0]!.id;
    cpId = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,free_vend_tag)
           VALUES($1,'PM-D1-HCM-0024',$2,'in_service',$3) RETURNING id`,
          [CP, site, FREE_VEND_TAG],
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
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
       VALUES($1,'normal','00:00','24:00',$2,'2026-01-01')`,
      [op, PRICE],
    );
    opStaff = await staffOf(op, 'a@b24.test');
    otherOpStaff = await staffOf(other, 'b@b24.test');
    adminUser = await user('admin@b24.test', 'admin');
    driver = await driverWith('driver@b24.test');
    otherDriver = await driverWith('driver2@b24.test');
    sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    settlement = new ChargeSettlementService(db, policy);
    review = new SessionReviewService(db, settlement);
    service = new UnattributedSessionService(db, settlement);
    commands = new ConsoleCommands(db, new ConnectionRegistry(db), undefined, review, service);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // -------------------------------------------------------------------------------------------
  // TC-F12-01 — luồng chính: gán → csms_billed + quyết toán đúng tiền
  // -------------------------------------------------------------------------------------------

  it('TC-F12-01 gán phiên thẻ lạ đã đóng cho tài xế → csms_billed, trừ đúng 10.000 VND, dấu vết đủ', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    expect(await session(sid)).toMatchObject({
      status: 'reconciled',
      payment_mode: 'unattributed',
      origin: 'rfid',
      driver_id: null,
    });
    // Trước khi gán: settle() không đụng phiên unattributed.
    expect(await settlement.settle(sid)).toBe('ineligible');

    const before = Date.now();
    const result = await service.assign(sid, opStaff, driver, 'Tài xế gọi tổng đài, xác nhận thẻ');
    expect(result).toEqual({
      sessionId: sid,
      decision: 'assigned',
      driverId: driver,
      paymentMode: 'csms_billed',
      alreadyResolved: false,
      recordsReviewed: 1,
      settlement: 'posted',
    });
    expect(await session(sid)).toMatchObject({
      status: 'reconciled',
      payment_mode: 'csms_billed',
      driver_id: String(driver),
      total_cost_vnd: '10000',
    });
    expect(await debits(sid)).toEqual([{ amount_vnd: '-10000' }]);
    expect(await balance(driver)).toBe(190000);
    expect(
      await q('SELECT amount_vnd,earned_points FROM charging_statements WHERE session_id=$1', [
        sid,
      ]),
    ).toEqual([{ amount_vnd: '10000', earned_points: '10' }]);
    expect(
      (await q('SELECT state FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0],
    ).toEqual({ state: 'posted' });
    // Dấu vết: ai (actor), lúc nào (occurred_at), quyết định (event), ghi chú (note).
    const [h] = await history(sid);
    expect(h).toMatchObject({
      from_status: 'reconciled',
      to_status: 'reconciled',
      event: 'UNATTRIBUTED_ASSIGNED',
      actor: String(opStaff),
      note: `driver=${driver}: Tài xế gọi tổng đài, xác nhận thẻ`,
    });
    expect((h!.occurred_at as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const [rec] = await records(sid);
    expect(rec).toMatchObject({ record_type: 'unknown_id_tag', reviewed_by: String(opStaff) });
    expect(rec!.reviewed_at).not.toBeNull();
    expect(rec!.resolution).toBe(
      `unknown_id_tag: id_tag=UNKNOWN-TAG-24 | operator_assigned(driver=${driver}): Tài xế gọi tổng đài, xác nhận thẻ`,
    );
    expect(await service.listPending(50)).toEqual([]);
  });

  it('TC-F12-01 phiên còn review: gán trước thì quyết toán chờ, giải quyết review qua route console mới trừ tiền', async () => {
    const sid = await reviewSession();
    const assigned = await service.assign(sid, opStaff, driver, 'Chủ xe nhận phiên');
    expect(assigned.settlement).toBe('pending');
    expect(await debits(sid)).toEqual([]);
    expect(
      (await q('SELECT state,reason FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0],
    ).toEqual({ state: 'pending', reason: 'awaiting_reconciliation' });
    expect((await review.listInReview(50)).map((r) => r.session_id)).toEqual([sid]);

    const resolved = await commands.resolveReview(sid, {
      operatorUserId: opStaff,
      resolution: 'meter_confirmed',
      note: 'Đã xem ảnh công tơ',
    });
    expect(resolved).toEqual({
      session_id: sid,
      status: 'reconciled',
      records_reviewed: 0,
      settlement: 'posted',
    });
    expect(await debits(sid)).toEqual([{ amount_vnd: '-10000' }]);
    expect(await balance(driver)).toBe(190000);
    expect(await review.listInReview(50)).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // TC-F12-02 — quy tắc: phiên không unattributed / chưa đóng / free vend / thẻ ví / tài xế
  // -------------------------------------------------------------------------------------------

  it('TC-F12-02 free vend: không gán được (never debits), chỉ đóng được, không có dòng tiền nào', async () => {
    const sid = await chargeWith(FREE_VEND_TAG);
    expect(await session(sid)).toMatchObject({ origin: 'free_vend', payment_mode: 'unattributed' });
    expect(await code(service.assign(sid, opStaff, driver, 'thử gán'))).toBe(
      'free_vend_not_billable',
    );
    expect(await session(sid)).toMatchObject({ payment_mode: 'unattributed', driver_id: null });
    expect(await history(sid)).toEqual([]);

    const settle = jest.spyOn(settlement, 'settle');
    const closed = await service.close(sid, opStaff, 'free_vend_ok', 'Khuyến mãi khai trương');
    expect(closed).toEqual({
      sessionId: sid,
      decision: 'closed',
      reason: 'free_vend_ok',
      paymentMode: 'unattributed',
      alreadyResolved: false,
      recordsReviewed: 0,
    });
    expect(settle).not.toHaveBeenCalled();
    expect(await debits(sid)).toEqual([]);
    expect(await history(sid)).toMatchObject([
      {
        event: 'UNATTRIBUTED_CLOSED',
        actor: String(opStaff),
        note: 'free_vend_ok: Khuyến mãi khai trương',
      },
    ]);
  });

  it('TC-F12-02 settle() không bao giờ trừ tiền phiên free vend, kể cả khi dữ liệu bị sửa tay', async () => {
    const sid = await chargeWith(FREE_VEND_TAG);
    // Giả lập dữ liệu hỏng: ai đó sửa thẳng DB thành csms_billed + dấu vết gán.
    await q("UPDATE sessions SET payment_mode='csms_billed',driver_id=$2 WHERE id=$1", [
      sid,
      driver,
    ]);
    await q(
      `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor,note)
       VALUES($1,'reconciled','reconciled','UNATTRIBUTED_ASSIGNED','x','x')`,
      [sid],
    );
    expect(await settlement.settle(sid)).toBe('ineligible');
    expect(await debits(sid)).toEqual([]);
  });

  it('TC-F12-02 thẻ ví bị khoá: phiên unattributed nhưng tiền thuộc trụ → không gán được', async () => {
    await q(
      "INSERT INTO rfid_cards(card_identifier,card_kind,status) VALUES('BE24-WALLET','wallet','blocked')",
    );
    const sid = await chargeWith('BE24-WALLET');
    expect(await session(sid)).toMatchObject({ payment_mode: 'unattributed', origin: 'rfid' });
    expect(await code(service.assign(sid, opStaff, driver, 'x'))).toBe('wallet_card_not_billable');
    const [item] = await service.listPending(50);
    expect(item).toMatchObject({
      session_id: sid,
      not_assignable_reason: 'wallet_card_not_billable',
    });
  });

  it('TC-F12-02 phiên không unattributed và phiên chưa đóng bị từ chối, không ghi gì', async () => {
    await q(
      "INSERT INTO rfid_cards(card_identifier,card_kind,status,driver_id) VALUES('BE24-ONLINE','online','active',$1)",
      [driver],
    );
    const billed = await chargeWith('BE24-ONLINE');
    expect(await session(billed)).toMatchObject({ payment_mode: 'csms_billed' });
    expect(await code(service.assign(billed, opStaff, otherDriver, 'x'))).toBe('not_unattributed');
    expect(await code(service.close(billed, opStaff, 'x', 'n'))).toBe('not_unattributed');

    const running = await chargeWith('UNKNOWN-RUNNING', false);
    expect(await session(running)).toMatchObject({
      status: 'active',
      payment_mode: 'unattributed',
    });
    expect(await code(service.assign(running, opStaff, driver, 'x'))).toBe('session_not_stopped');
    expect(await code(service.close(running, opStaff, 'x', 'n'))).toBe('session_not_stopped');
    expect(await history(billed)).toEqual([]);
    expect(await history(running)).toEqual([]);
    expect((await service.listPending(50)).map((r) => r.session_id)).toEqual([]);
  });

  it('TC-F12-02 tài xế không nhận được phiên: bị khoá, ví đóng, không có ví, không phải tài xế', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    const suspended = await driverWith('s@b24.test', { status: 'suspended' });
    const closedWallet = await driverWith('c@b24.test', { credit: 'closed' });
    const noWallet = await driverWith('n@b24.test', { credit: 'none' });
    for (const d of [suspended, closedWallet, noWallet, opStaff, 999999])
      expect(await code(service.assign(sid, opStaff, d, 'x'))).toBe('driver_not_eligible');
    expect(await session(sid)).toMatchObject({ payment_mode: 'unattributed', driver_id: null });
    expect(await history(sid)).toEqual([]);
  });

  it.each([
    ['session id 0', () => [0, 1, 1, 'n']],
    ['note rỗng', () => [1, 1, 1, '  ']],
    ['note quá 500', () => [1, 1, 1, 'x'.repeat(501)]],
  ])('TC-F12-02 assign tham số sai: %s → invalid_input', async (_n, args) => {
    const [s, o, d, n] = args() as [number, number, number, string];
    expect(await code(service.assign(s, o, d, n))).toBe('invalid_input');
  });

  it.each([['Bad'], [''], ['a b'], ['x'.repeat(41)]])(
    'TC-F12-02 close mã lý do sai "%s" → invalid_input',
    async (reason) => {
      expect(await code(service.close(1, opStaff, reason, 'n'))).toBe('invalid_input');
    },
  );

  // -------------------------------------------------------------------------------------------
  // TC-F12-03 — phân quyền
  // -------------------------------------------------------------------------------------------

  it('TC-F12-03 nhân viên operator khác → not_found; không phải operator_staff active → forbidden', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    expect(await code(service.assign(sid, otherOpStaff, driver, 'x'))).toBe('not_found');
    expect(await code(service.close(sid, otherOpStaff, 'x', 'n'))).toBe('not_found');
    for (const caller of [driver, adminUser, 999999]) {
      expect(await code(service.assign(sid, caller, driver, 'x'))).toBe('forbidden');
      expect(await code(service.close(sid, caller, 'x', 'n'))).toBe('forbidden');
    }
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [opStaff]);
    expect(await code(service.close(sid, opStaff, 'x', 'n'))).toBe('forbidden');
    await q("UPDATE users SET account_status='active' WHERE id=$1", [opStaff]);
    expect(await code(service.assign(424242, opStaff, driver, 'x'))).toBe('not_found');
    expect(await session(sid)).toMatchObject({ payment_mode: 'unattributed', driver_id: null });
    expect(await history(sid)).toEqual([]);
    expect((await records(sid))[0]).toMatchObject({ reviewed_by: null, reviewed_at: null });
  });

  it('TC-F12-03 qua console: mã lỗi miền → HTTP 404 / 403 / 409 / 422', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    const status = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(ConsoleError);
        return `${(e as ConsoleError).status}:${(e as ConsoleError).code}`;
      }
      throw new Error('expected rejection');
    };
    const input = { operatorUserId: otherOpStaff, driverId: driver, note: 'x' };
    expect(await status(commands.assignUnattributed(sid, input))).toBe('404:not_found');
    expect(
      await status(commands.assignUnattributed(sid, { ...input, operatorUserId: driver })),
    ).toBe('403:forbidden');
    expect(
      await status(
        commands.assignUnattributed(sid, {
          ...input,
          operatorUserId: opStaff,
          driverId: adminUser,
        }),
      ),
    ).toBe('422:driver_not_eligible');
    expect(
      await status(
        commands.resolveReview(sid, { operatorUserId: opStaff, resolution: 'x', note: 'n' }),
      ),
    ).toBe('409:not_in_review');
  });

  // -------------------------------------------------------------------------------------------
  // Đóng, idempotent, hàng đợi
  // -------------------------------------------------------------------------------------------

  it('đóng phiên thẻ lạ: giữ unattributed, không tính tiền, record được duyệt, ra khỏi hàng đợi', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    expect((await service.listPending(50)).map((r) => r.session_id)).toEqual([sid]);
    const r = await commands.closeUnattributed(sid, {
      operatorUserId: opStaff,
      reason: 'owner_unknown',
      note: 'Không liên hệ được chủ thẻ',
    });
    expect(r).toEqual({
      session_id: sid,
      decision: 'closed',
      reason: 'owner_unknown',
      payment_mode: 'unattributed',
      already_resolved: false,
      records_reviewed: 1,
    });
    expect(await session(sid)).toMatchObject({ payment_mode: 'unattributed', driver_id: null });
    expect(await debits(sid)).toEqual([]);
    expect((await records(sid))[0]!.resolution).toBe(
      'unknown_id_tag: id_tag=UNKNOWN-TAG-24 | operator_closed(owner_unknown): Không liên hệ được chủ thẻ',
    );
    expect(await service.listPending(50)).toEqual([]);
  });

  it('idempotent: gán lại cùng tài xế không trừ thêm; quyết định khác → already_resolved', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    await service.assign(sid, opStaff, driver, 'lần 1');
    const again = await service.assign(sid, opStaff, driver, 'lần 2');
    expect(again).toMatchObject({
      alreadyResolved: true,
      recordsReviewed: 0,
      settlement: 'already_posted',
    });
    expect(await code(service.assign(sid, opStaff, otherDriver, 'x'))).toBe('already_resolved');
    expect(await code(service.close(sid, opStaff, 'x', 'n'))).toBe('already_resolved');
    expect(await history(sid)).toHaveLength(1);
    expect(await debits(sid)).toHaveLength(1);
    expect(await balance(driver)).toBe(190000);
    expect(await balance(otherDriver)).toBe(200000);
  });

  it('idempotent: đóng hai lần trả lý do cũ; đã đóng thì không gán được', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    await service.close(sid, opStaff, 'test_session', 'phiên thử');
    const again = await service.close(sid, opStaff, 'other_reason', 'khác');
    expect(again).toMatchObject({ alreadyResolved: true, reason: 'test_session' });
    expect(await code(service.assign(sid, opStaff, driver, 'x'))).toBe('already_resolved');
    expect(await history(sid)).toHaveLength(1);
  });

  it('đồng thời: gán và đóng cùng lúc → đúng một quyết định, một dấu vết', async () => {
    const sid = await chargeWith('UNKNOWN-TAG-24');
    const results = await Promise.allSettled([
      service.assign(sid, opStaff, driver, 'gán'),
      service.close(sid, opStaff, 'owner_unknown', 'đóng'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as UnattributedSessionError).code).toBe('already_resolved');
    expect(await history(sid)).toHaveLength(1);
  });

  it('hàng đợi liệt kê phiên chờ, đánh dấu phiên chỉ đóng được, bỏ phiên chưa dừng', async () => {
    const unknown = await chargeWith('UNKNOWN-TAG-24');
    const free = await chargeWith(FREE_VEND_TAG);
    await chargeWith('UNKNOWN-RUNNING', false);
    const items = await service.listPending(50);
    expect(items.map((i) => [i.session_id, i.origin, i.not_assignable_reason])).toEqual([
      [free, 'free_vend', 'free_vend_not_billable'],
      [unknown, 'rfid', null],
    ]);
    expect(items[1]).toMatchObject({
      station: CP,
      status: 'reconciled',
      energy_wh: 2000,
      open_records: ['unknown_id_tag: id_tag=UNKNOWN-TAG-24'],
    });
    expect(await service.listPending(1)).toHaveLength(1);
  });
});
