/**
 * BE-19 (G8): Authorize / StartTransaction với thẻ RFID phải kiểm thẻ gắn tài xế (BR-P23) và số
 * dư tối thiểu (BR-P18) — cùng quy tắc với tag của app (`authorizeAppTag`, #58).
 *
 * Gọi thẳng SessionsService với InboundContext dựng tay (như session-history), Postgres thật.
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  chargePoints,
  connectors,
  reconciliationRecords,
  rfidCards,
  sessions,
} from '../src/db/schema/index.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'CARD19-00001';
const FREE_VEND_TAG = 'HMI-FREEVEND';
const MIN = loadChargePolicy({}).minimumStartVnd; // mặc định 50.000 VND
const CONFIG: CsmsConfig = {
  databaseUrl: DATABASE_URL ?? '',
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

const T = (mmss: string) => new Date(`2026-11-07T10:${mmss}Z`);

describeDb('BE-19 — thẻ RFID: liên kết tài xế (BR-P23) + số dư tối thiểu (BR-P18)', () => {
  let db: Db;
  let svc: SessionsService;
  let chargePointId: number;
  let logId = 0;
  let meter = 0;

  function ctx(receivedAt: Date, replayed = false): InboundContext {
    return {
      identity: CP,
      chargePointId,
      epoch: 1,
      epochOpenedAt: T('00:00'),
      receivedAt,
      cpTimestamp: receivedAt,
      messageId: `m${++logId}`,
      messageLogId: logId,
      replay: { replayed, reason: replayed ? 'before_epoch' : null, skewS: replayed ? 120 : 0 },
    };
  }

  /** Tạo tài xế + ví; trả driverId. */
  async function driver(
    key: string,
    opts: {
      balance: number;
      credit?: 'active' | 'in_shortfall' | 'closed' | 'none';
      user?: string;
    },
  ): Promise<number> {
    const u = await db.$client.query<{ id: string }>(
      `INSERT INTO users (email, full_name, phone_number, role, account_status)
       VALUES ($1, $2, $3, 'driver', $4) RETURNING id`,
      [`${key}@powerme.test`, key, `09${String(++meter).padStart(8, '0')}`, opts.user ?? 'active'],
    );
    const id = Number(u.rows[0]?.id);
    await db.$client.query(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, '2026-09', now())`,
      [id],
    );
    const credit = opts.credit ?? 'active';
    if (credit !== 'none') {
      await db.$client.query(
        `INSERT INTO credit_accounts (driver_id, status, balance_vnd, closed_at)
         VALUES ($1, $2::credit_account_status, $3, CASE WHEN $4::boolean THEN now() END)`,
        [id, credit, opts.balance, credit === 'closed'],
      );
    }
    return id;
  }

  async function card(
    identifier: string,
    kind: 'online' | 'free_vend',
    status: 'active' | 'blocked' | 'unlinked',
    driverId: number | null,
  ) {
    await db
      .insert(rfidCards)
      .values({ cardIdentifier: identifier, cardKind: kind, status, driverId });
  }

  async function start(idTag: string, at: Date) {
    meter += 1000;
    const r = await svc.onStartTransaction(
      { connectorId: 1, idTag, meterStart: meter, timestamp: at.toISOString() },
      ctx(at),
    );
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.transactionNo, r.transactionId));
    if (!row) throw new Error('không có phiên');
    const recs = await db
      .select()
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.sessionId, row.id))
      .orderBy(asc(reconciliationRecords.recordNo));
    return { session: row, records: recs };
  }

  let okDriver: number;
  let lowDriver: number;
  let shortfallDriver: number;
  let closedDriver: number;
  let noWalletDriver: number;
  let suspendedDriver: number;

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: CP, lifecycle: 'in_service', freeVendTag: FREE_VEND_TAG })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    chargePointId = cp.id;
    await db.insert(connectors).values([{ chargePointId, connectorNo: 1 }]);

    okDriver = await driver('ok', { balance: MIN });
    lowDriver = await driver('low', { balance: MIN - 1 });
    shortfallDriver = await driver('shortfall', { balance: -2000, credit: 'in_shortfall' });
    closedDriver = await driver('closed', { balance: 0, credit: 'closed' });
    noWalletDriver = await driver('nowallet', { balance: 0, credit: 'none' });
    suspendedDriver = await driver('suspended', { balance: 10 * MIN, user: 'suspended' });

    await card('C-OK', 'online', 'active', okDriver);
    await card('C-NODRIVER', 'online', 'active', null);
    await card('C-LOW', 'online', 'active', lowDriver);
    await card('C-SHORTFALL', 'online', 'active', shortfallDriver);
    await card('C-CLOSED', 'online', 'active', closedDriver);
    await card('C-NOWALLET', 'online', 'active', noWalletDriver);
    await card('C-SUSPENDED', 'online', 'active', suspendedDriver);
    await card('C-BLOCKED', 'online', 'blocked', okDriver);
    await card('C-UNLINKED', 'online', 'unlinked', null);
    // T110: thẻ ví cũ sau migration 0016 — card_kind wallet → online, giữ status/driver_id (null).
    await card('C-EXWALLET', 'online', 'active', null);
    await card('C-FREEVEND', 'free_vend', 'active', null);

    svc = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  describe('Authorize', () => {
    it.each([
      ['thẻ online active, tài xế đủ mức tối thiểu (đúng bằng ngưỡng)', 'C-OK', 'Accepted'],
      [
        'thẻ active nhưng chưa gắn tài xế (BR-P23; trước BE-19 vẫn Accepted)',
        'C-NODRIVER',
        'Invalid',
      ],
      ['số dư dưới mức tối thiểu 1 VND (BR-P18; trước BE-19 vẫn Accepted)', 'C-LOW', 'Blocked'],
      ['ví đang âm (in_shortfall) chặn phiên mới', 'C-SHORTFALL', 'Blocked'],
      ['ví Charging Credit đã đóng', 'C-CLOSED', 'Blocked'],
      ['tài xế chưa có ví', 'C-NOWALLET', 'Invalid'],
      ['tài khoản tài xế bị khoá', 'C-SUSPENDED', 'Blocked'],
      ['thẻ bị khoá (blocked) dù tài xế đủ tiền', 'C-BLOCKED', 'Blocked'],
      ['thẻ unlinked', 'C-UNLINKED', 'Invalid'],
      ['thẻ lạ', 'KHONG-CO-TRONG-SO', 'Invalid'],
      // T110: trước 0016 thẻ ví không cần tài xế và Accepted; nay là thẻ online chưa gắn tài xế.
      ['thẻ ví cũ (0016 đổi thành online), chưa gắn tài xế (BR-P23)', 'C-EXWALLET', 'Invalid'],
      ['thẻ free_vend không cần tài xế', 'C-FREEVEND', 'Accepted'],
    ] as const)('%s -> %s', async (_label, idTag, expected) => {
      expect(await svc.authorize(idTag)).toBe(expected);
    });

    it('nạp thêm tiền đưa thẻ từ Blocked về Accepted; giữ chỗ của intent app đang mở được trừ khỏi số dư khả dụng', async () => {
      expect(await svc.authorize('C-LOW')).toBe('Blocked');
      await db.$client.query('UPDATE credit_accounts SET balance_vnd = $1 WHERE driver_id = $2', [
        MIN + 5000,
        lowDriver,
      ]);
      expect(await svc.authorize('C-LOW')).toBe('Accepted');
      // intent app đang giữ MIN -> khả dụng còn 5000 < MIN
      const cmd = await db.$client.query<{ id: string }>(
        `INSERT INTO remote_commands (charge_point_id, connector_no, action, payload, status)
         VALUES ($1, 1, 'RemoteStartTransaction', '{}'::jsonb, 'sent') RETURNING id`,
        [chargePointId],
      );
      const conn = await db.$client.query<{ id: string }>(
        'SELECT id FROM connectors WHERE charge_point_id = $1 AND connector_no = 1',
        [chargePointId],
      );
      const vm = await db.$client.query<{ id: string }>(
        `INSERT INTO vehicle_models (brand, model_name) VALUES ('B', 'M') RETURNING id`,
      );
      const veh = await db.$client.query<{ id: string }>(
        `INSERT INTO vehicles (driver_id, vehicle_model_id, plate_number) VALUES ($1, $2, '51A-00001') RETURNING id`,
        [lowDriver, vm.rows[0]?.id],
      );
      await db.$client.query(
        `INSERT INTO driver_charge_intents (driver_id, vehicle_id, connector_id, command_id, id_tag,
           idempotency_key, request_hash, energy_limit_wh, reserved_vnd, state)
         VALUES ($1, $2, $3, $4, 'APP-TAG-HOLD', 'k-hold', 'h', 1000, $5, 'sent')`,
        [lowDriver, veh.rows[0]?.id, conn.rows[0]?.id, cmd.rows[0]?.id, MIN],
      );
      expect(await svc.authorize('C-LOW')).toBe('Blocked');
      await db.$client.query('DELETE FROM driver_charge_intents WHERE id_tag = $1', [
        'APP-TAG-HOLD',
      ]);
      expect(await svc.authorize('C-LOW')).toBe('Accepted');
    });
  });

  describe('StartTransaction — không bao giờ từ chối phiên đã diễn ra (BR-P06), nhưng phân loại đúng', () => {
    it('thẻ đủ điều kiện -> csms_billed gắn tài xế, không bản ghi đối soát', async () => {
      const { session, records } = await start('C-OK', T('01:00'));
      expect(session).toMatchObject({
        paymentMode: 'csms_billed',
        origin: 'rfid',
        driverId: okDriver,
      });
      expect(records).toHaveLength(0);
    });

    it('thẻ active chưa gắn tài xế -> phiên vẫn ghi, unattributed, không driver, record card_denied=no_driver', async () => {
      const { session, records } = await start('C-NODRIVER', T('01:10'));
      expect(session).toMatchObject({
        paymentMode: 'unattributed',
        origin: 'rfid',
        driverId: null,
      });
      expect(session.rfidCardId).not.toBeNull();
      expect(records).toHaveLength(1);
      expect(records[0]?.recordType).toBe('unknown_id_tag');
      expect(records[0]?.resolution).toMatch(/id_tag=C-NODRIVER card_denied=no_driver/);
    });

    it('tài xế dưới mức tối thiểu -> vẫn csms_billed (nợ thu được, BR-P18..P23) + record below_start_minimum', async () => {
      await db.$client.query('UPDATE credit_accounts SET balance_vnd = 1 WHERE driver_id = $1', [
        lowDriver,
      ]);
      const { session, records } = await start('C-LOW', T('01:20'));
      expect(session).toMatchObject({
        paymentMode: 'csms_billed',
        driverId: lowDriver,
      });
      expect(records[0]?.resolution).toMatch(/card_denied=below_start_minimum/);
    });

    it('ví đang âm -> csms_billed + record credit_in_shortfall', async () => {
      const { session, records } = await start('C-SHORTFALL', T('01:30'));
      expect(session).toMatchObject({ paymentMode: 'csms_billed', driverId: shortfallDriver });
      expect(records[0]?.resolution).toMatch(/card_denied=credit_in_shortfall/);
    });

    it.each([
      ['C-CLOSED', 'credit_closed'],
      ['C-NOWALLET', 'no_credit_account'],
      ['C-SUSPENDED', 'driver_inactive'],
    ] as const)('%s -> unattributed, không driver, record %s', async (idTag, reason) => {
      const { session, records } = await start(idTag, T('01:40'));
      expect(session).toMatchObject({ paymentMode: 'unattributed', driverId: null });
      expect(records[0]?.resolution).toContain(`card_denied=${reason}`);
    });

    it('thẻ blocked vẫn theo đường cũ: unattributed + card_status=blocked (không đổi)', async () => {
      const { session, records } = await start('C-BLOCKED', T('01:50'));
      expect(session).toMatchObject({ paymentMode: 'unattributed', driverId: null });
      expect(records[0]?.resolution).toMatch(/card_status=blocked/);
    });

    it('T110: thẻ ví cũ (online, chưa gắn tài xế) -> unattributed, không driver, record card_denied=no_driver (trước 0016: station_wallet, không record)', async () => {
      const exWallet = await start('C-EXWALLET', T('02:00'));
      expect(exWallet.session).toMatchObject({
        paymentMode: 'unattributed',
        origin: 'rfid',
        driverId: null,
      });
      expect(exWallet.records).toHaveLength(1);
      expect(exWallet.records[0]).toMatchObject({ recordType: 'unknown_id_tag' });
      expect(exWallet.records[0]?.resolution).toContain('card_denied=no_driver');
    });

    it('T110: DB không còn nhận thẻ wallet hay phiên station_wallet', async () => {
      await expect(
        db.$client.query(
          `INSERT INTO rfid_cards (card_identifier, card_kind, status) VALUES ('C-WALLET-MOI', 'wallet', 'active')`,
        ),
      ).rejects.toThrow(/invalid input value for enum rfid_card_kind: "wallet"/);
      await expect(db.$client.query(`SELECT 'station_wallet'::payment_mode`)).rejects.toThrow(
        /invalid input value for enum payment_mode: "station_wallet"/,
      );
    });

    it('giữ nguyên: thẻ free_vend và free_vend_tag của trụ -> free_vend/unattributed, không record', async () => {
      const fv = await start('C-FREEVEND', T('02:10'));
      expect(fv.session).toMatchObject({ paymentMode: 'unattributed', origin: 'free_vend' });
      expect(fv.records).toHaveLength(0);
      const tag = await start(FREE_VEND_TAG, T('02:20'));
      expect(tag.session).toMatchObject({ paymentMode: 'unattributed', origin: 'free_vend' });
      expect(tag.records).toHaveLength(0);
    });

    it('StartTransaction phát lại sau khi trụ chấp nhận offline (thẻ không đạt điều kiện) vẫn được ghi, delivered_offline, không mất phiên', async () => {
      meter += 1000;
      const r = await svc.onStartTransaction(
        {
          connectorId: 1,
          idTag: 'C-NODRIVER',
          meterStart: meter,
          timestamp: T('03:00').toISOString(),
        },
        ctx(T('09:00'), true),
      );
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.transactionNo, r.transactionId));
      expect(row).toMatchObject({
        deliveredOffline: true,
        paymentMode: 'unattributed',
        driverId: null,
      });
    });
  });
});
