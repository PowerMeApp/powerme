import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OfflineAuthCheckService } from '../src/ocpp-gateway/offline-auth-check.service.js';
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { createDb, type Db } from '../src/db/db.module.js';
import { loadConfig } from '../src/config.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { RefundService } from '../src/billing/refund.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { creditSummary } from '../src/driver/driver-credit.js';
import { migrate } from './helpers/apply-migrations.js';

import { runAdminSummary } from '../src/operator-api/admin-platform.js';
import { runMonitoringRoute } from '../src/operator-api/operator-monitoring.js';
const url = process.env.MB03_TEST_DATABASE_URL;
async function until(read: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (!(await read())) {
    if (Date.now() > end) throw Error('Timed out awaiting effect');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const policy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 50,
  stationStaleAfterMs: 600000,
  remoteStopRetryMax: 2,
  remoteStopRetryIntervalMs: 10,
};
(url ? describe : describe.skip)('WP3 RFID credit protection', () => {
  let db: Db,
    sessions: SessionsService,
    registry: ConnectionRegistry,
    charging: DriverChargingService;
  let settlement: ChargeSettlementService,
    driver: number,
    cp: number,
    tag: string,
    identity: string,
    ctx: InboundContext;
  let rpc: jest.Mock;
  const q = async (s: string, p: unknown[] = []) => (await db.$client.query(s, p)).rows;
  const id = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0]!.id);
  const start = async (connectorId = 1, timestamp = new Date().toISOString(), context = ctx) => {
    const req = { connectorId, idTag: tag, meterStart: 1000, timestamp };
    const receivedAt = new Date();
    const messageLogId = await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: context.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag,
      action: 'StartTransaction',
      cpTimestamp: new Date(timestamp),
      receivedAt,
      replayed: context.replay.replayed,
      raw: [2, tag, 'StartTransaction', req],
    });
    return sessions.onStartTransaction(req, {
      ...context,
      messageLogId,
      receivedAt,
      cpTimestamp: new Date(timestamp),
    });
  };
  const sid = async (tx: number) =>
    Number((await q('SELECT id FROM sessions WHERE transaction_no=$1', [tx]))[0]!.id);
  const hold = async (s: number) =>
    (await q('SELECT * FROM rfid_credit_holds WHERE session_id=$1', [s]))[0];
  const job = async (s: number) =>
    (await q('SELECT * FROM rfid_stop_jobs WHERE session_id=$1', [s]))[0];
  async function meter(tx: number, value: string, at = new Date()) {
    const req = {
      connectorId: 1,
      transactionId: tx,
      meterValue: [
        {
          timestamp: at.toISOString(),
          sampledValue: [{ value, unit: 'Wh', measurand: 'Energy.Active.Import.Register' }],
        },
      ],
    };
    const receivedAt = new Date();
    const messageLogId = await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: ctx.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag,
      action: 'MeterValues',
      cpTimestamp: at,
      receivedAt,
      replayed: ctx.replay.replayed,
      raw: [2, tag, 'MeterValues', req],
    });
    await sessions.onMeterValues(req, { ...ctx, messageLogId, receivedAt, cpTimestamp: at });
  }
  async function stop(tx: number, wh = 2000) {
    await sessions.onStopTransaction(
      { transactionId: tx, meterStop: wh, timestamp: new Date().toISOString(), reason: 'Local' },
      { ...ctx, receivedAt: new Date() },
    );
    await charging.onStopped(tx);
  }
  async function qrFixture() {
    const connector = await id(
      'SELECT id FROM connectors WHERE charge_point_id=$1 AND connector_no=2',
      [cp],
    );
    const model = await id(
      "INSERT INTO vehicle_models(brand,model_name) VALUES('Test',$1) RETURNING id",
      [tag],
    );
    const vehicle = await id(
      'INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,$3) RETURNING id',
      [driver, model, tag.slice(0, 12)],
    );
    const at = new Date();
    await q(
      "UPDATE connectors SET status='Available',status_changed_at=$2,updated_at=now() WHERE id=$1",
      [connector, at],
    );
    await q(
      "INSERT INTO connector_status_events(connector_id,charge_point_id,connector_no,status,error_code,cp_timestamp,received_at) VALUES($1,$2,2,'Available','NoError',NULL,$3)",
      [connector, cp, at],
    );
    await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: ctx.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag,
      action: 'StatusNotification',
      cpTimestamp: null,
      receivedAt: at,
      replayed: false,
      raw: [2, tag, 'StatusNotification', { connectorId: 2, status: 'Available' }],
    });
    return { connectorId: connector, vehicleId: vehicle, mode: 'full' as const };
  }
  async function refundFixture() {
    const account = await id('SELECT id FROM credit_accounts WHERE driver_id=$1', [driver]);
    const admin = await id(
      "INSERT INTO users(email,full_name,role) VALUES($1,'Admin','admin') RETURNING id",
      ['admin-' + tag + '@test.invalid'],
    );
    await q('INSERT INTO admins(user_id) VALUES($1)', [admin]);
    const top = await id(
      `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,points_redeemed,points_discount_vnd,
      amount_paid_vnd,status,gateway_transaction_no,idempotency_key,expires_at,completed_at)
      VALUES($1,$2,200000,0,0,200000,'credited',$1,$1,now()+interval '15 minutes',now()) RETURNING id`,
      [tag, account],
    );
    const adapter = new VnpayAdapter(
      {
        configured: true,
        tmnCode: 'FIXTURE',
        hashSecret: 'not-a-real-secret',
        payUrl: 'https://invalid.test',
        returnUrl: 'https://invalid.test',
      },
      { apiUrl: 'https://invalid.test', serverIp: '127.0.0.1' },
      async () => {
        throw Error('No network allowed');
      },
    );
    return {
      admin,
      top,
      service: new TopUpService(
        db,
        new CreditLedgerService(db),
        new LoyaltyService(policy),
        adapter,
        undefined,
        undefined,
        undefined,
        new RefundService(db, adapter),
      ),
    };
  }

  async function networkFixture(ageMs = 120000) {
    const startedAt = new Date(Date.now() - ageMs),
      openedAt = new Date(startedAt.getTime() - 1000);
    registry.get(identity)!.epochOpenedAt = openedAt;
    ctx = { ...ctx, epochOpenedAt: openedAt };
    await q(
      'UPDATE charge_point_connections SET opened_at=$3 WHERE charge_point_id=$1 AND epoch=$2',
      [cp, ctx.epoch, openedAt],
    );
    await q('UPDATE charge_points SET online_changed_at=$2 WHERE id=$1', [cp, openedAt]);
    await q('UPDATE credit_accounts SET balance_vnd=50000 WHERE driver_id=$1', [driver]);
    const request = {
      connectorId: 1,
      idTag: tag,
      meterStart: 1000,
      timestamp: startedAt.toISOString(),
    };
    const messageLogId = await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: ctx.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag,
      action: 'StartTransaction',
      cpTimestamp: startedAt,
      receivedAt: startedAt,
      replayed: false,
      raw: [2, tag, 'StartTransaction', request],
    });
    const tx = (
      await sessions.onStartTransaction(request, {
        ...ctx,
        receivedAt: startedAt,
        cpTimestamp: startedAt,
        messageLogId,
      })
    ).transactionId;
    const at = new Date(Date.now() - 60000),
      value = {
        connectorId: 1,
        transactionId: tx,
        meterValue: [
          {
            timestamp: at.toISOString(),
            sampledValue: [
              { value: '6000', unit: 'Wh', measurand: 'Energy.Active.Import.Register' },
            ],
          },
        ],
      };
    const meterLog = await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: ctx.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag,
      action: 'MeterValues',
      cpTimestamp: at,
      receivedAt: at,
      replayed: false,
      raw: [2, tag, 'MeterValues', value],
    });
    await sessions.onMeterValues(value, {
      ...ctx,
      receivedAt: at,
      cpTimestamp: at,
      messageLogId: meterLog,
    });
    return { tx, session: await sid(tx) };
  }
  async function reconnectNetworkFixture() {
    const conn = await registry.open(
      identity,
      { identity, call: rpc, close: async () => undefined },
      { openedAt: new Date() },
    );
    ctx = {
      ...ctx,
      epoch: conn.epoch,
      epochOpenedAt: conn.epochOpenedAt,
      replay: { replayed: false, reason: null, skewS: 0 },
    };
  }

  beforeAll(async () => {
    if (
      !url ||
      process.env.MB03_TEST_ALLOW_EMPTY_DATABASE !== 'true' ||
      new URL(url).hostname !== '127.0.0.1' ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw Error('Fresh isolated test DB required');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    await migrate(db.$client);
  });
  beforeEach(async () => {
    tag = 'WP3-' + randomBytes(5).toString('hex');
    identity = tag;
    driver = await id(
      "INSERT INTO users(email,full_name,role) VALUES($1,'Fixture','driver') RETURNING id",
      [tag + '@invalid.test'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'fixture',now())",
      [driver],
    );
    await q('INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,200000)', [driver]);
    const op = await id(
      "INSERT INTO operators(tax_code,legal_name) VALUES($1,'Fixture') RETURNING id",
      [tag],
    );
    const site = await id(
      "INSERT INTO sites(site_code,site_name,operator_id) VALUES($1,'Fixture',$2) RETURNING id",
      [tag, op],
    );
    cp = await id(
      "INSERT INTO charge_points(serial_number,site_id,lifecycle) VALUES($1,$2,'in_service') RETURNING id",
      [identity, site],
    );
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1),($1,2)', [cp]);
    await q(
      "INSERT INTO rfid_cards(card_identifier,card_kind,status,driver_id) VALUES($1,'online','active',$2)",
      [tag, driver],
    );
    await q(
      "INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from) VALUES($1,'normal','00:00','24:00',5000,current_date-2)",
      [op],
    );
    registry = new ConnectionRegistry(db);
    rpc = jest.fn(async () => ({ status: 'Accepted' }));
    const conn = await registry.open(
      identity,
      { identity, call: rpc, close: async () => undefined },
      { openedAt: new Date(Date.now() - 1000) },
    );
    ctx = {
      identity,
      chargePointId: cp,
      epoch: conn.epoch,
      epochOpenedAt: conn.epochOpenedAt,
      receivedAt: new Date(),
      cpTimestamp: new Date(),
      messageId: tag,
      messageLogId: 1,
      replay: { replayed: false, reason: null, skewS: 0 },
    };
    const config = loadConfig({ DATABASE_URL: url });
    sessions = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
      policy,
    );
    settlement = new ChargeSettlementService(
      db,
      new CreditLedgerService(db),
      new LoyaltyService(policy),
      policy,
      config,
    );
    charging = new DriverChargingService(db, registry, settlement, policy, config);
  });
  afterAll(async () => {
    await until(async () => db.$client.idleCount === db.$client.totalCount);
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });
  it('holds full available budget, blocks a second card, and exposes shared credit', async () => {
    expect(await sessions.authorize(tag)).toBe('Accepted');
    const s = await sid((await start()).transactionId);
    expect(await hold(s)).toMatchObject({
      amount_vnd: '200000',
      state: 'held',
      reason: 'live_start',
    });
    expect(await sessions.authorize(tag)).toBe('Blocked');
    expect(await creditSummary(db, String(driver))).toMatchObject({
      held_vnd: 200000,
      available_vnd: 0,
    });
  });
  it('serializes two physical Starts; preserves attribution and queues the unfunded one', async () => {
    const results = await Promise.all([start(1), start(2)]);
    const hs = await q(
      'SELECT h.* FROM rfid_credit_holds h JOIN sessions s ON s.id=h.session_id WHERE s.driver_id=$1 ORDER BY amount_vnd DESC',
      [driver],
    );
    expect(hs.map((h) => h.amount_vnd)).toEqual(['200000', '0']);
    expect(
      (await q('SELECT payment_mode FROM sessions WHERE driver_id=$1', [driver])).every(
        (s) => s.payment_mode === 'csms_billed',
      ),
    ).toBe(true);
    expect(
      await q('SELECT * FROM rfid_stop_jobs WHERE session_id=ANY($1::bigint[])', [
        await Promise.all(results.map((r) => sid(r.transactionId))),
      ]),
    ).toHaveLength(1);
  });
  it('keeps duplicate identity and initial hold immutable after transfer and topup', async () => {
    const timestamp = new Date().toISOString();
    const first = await start(1, timestamp);
    const s = await sid(first.transactionId);
    await q("UPDATE rfid_cards SET status='blocked',driver_id=NULL WHERE card_identifier=$1", [
      tag,
    ]);
    await q('UPDATE credit_accounts SET balance_vnd=300000 WHERE driver_id=$1', [driver]);
    expect(await start(1, timestamp)).toEqual({ ...first, duplicate: true });
    expect((await hold(s)).amount_vnd).toBe('200000');
    expect((await q('SELECT driver_id FROM sessions WHERE id=$1', [s]))[0].driver_id).toBe(
      String(driver),
    );
  });
  it('does not reserve replayed Start, retains unresolved exposure after stopped review', async () => {
    const s = await sid(
      (
        await start(1, new Date(Date.now() - 3600000).toISOString(), {
          ...ctx,
          replay: { replayed: true, reason: 'before_epoch', skewS: 3600 },
        })
      ).transactionId,
    );
    expect(await hold(s)).toMatchObject({ amount_vnd: '0', reason: 'offline_obligation' });
    expect(await sessions.authorize(tag)).toBe('Blocked');
    await q(
      "UPDATE sessions SET status='review',received_stopped_at=now(),updated_at=now() WHERE id=$1",
      [s],
    );
    expect(await sessions.authorize(tag)).toBe('Blocked');
  });
  it('cuts at initial budget minus reserve despite a later topup, Accepted retains hold', async () => {
    const tx = (await start()).transactionId;
    const s = await sid(tx);
    await q('UPDATE credit_accounts SET balance_vnd=400000 WHERE driver_id=$1', [driver]);
    await meter(tx, '39000');
    await charging.onMeter(tx);
    expect(rpc).toHaveBeenCalledWith(
      'RemoteStopTransaction',
      { transactionId: tx },
      expect.anything(),
    );
    expect(await job(s)).toMatchObject({ state: 'awaiting_stop', attempts: 1 });
    expect((await hold(s)).state).toBe('held');
  });
  it('retries Accepted without Stop cumulatively across restarts; exhausted stays terminal', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '39000');
    await charging.onMeter(tx);
    for (let n = 0; n < 4; n++) {
      await q(
        "UPDATE rfid_stop_jobs SET next_attempt_at=now()-interval '1 second',updated_at=now() WHERE session_id=$1",
        [s],
      );
      const restarted = new DriverChargingService(db, registry, settlement, policy);
      await restarted.sweepRfidStops();
      await until(async () => !['pending', 'inflight'].includes((await job(s)).state));
      await charging.onMeter(tx);
    }
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(await job(s)).toMatchObject({
      state: 'exhausted',
      attempts: 3,
      reason: 'credit_cutoff',
    });
  });
  it('settlement releases only after posted and duplicate settlement stays exactly once', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '1500');
    await stop(tx);
    expect((await hold(s)).state).toBe('released');
    await charging.onStopped(tx);
    expect(
      await q(
        "SELECT id FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
        [s],
      ),
    ).toHaveLength(1);
  });

  it('uses inclusive minimum and serializes same-natural-key duplicate Starts', async () => {
    await q('UPDATE credit_accounts SET balance_vnd=50000 WHERE driver_id=$1', [driver]);
    const timestamp = new Date().toISOString();
    const results = await Promise.all([start(1, timestamp), start(1, timestamp)]);
    expect(results[0].transactionId).toBe(results[1].transactionId);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect((await hold(await sid(results[0].transactionId))).amount_vnd).toBe('50000');
  });
  it('RFID and QR contend on one shared account and cannot double-reserve', async () => {
    const input = await qrFixture();
    await Promise.allSettled([start(), charging.start(driver, 'qr-race-key', input)]);
    const summary = await creditSummary(db, String(driver));
    expect(summary.held_vnd).toBe(200000);
    expect(summary.available_vnd).toBe(0);
    expect(
      await q("SELECT * FROM sessions WHERE driver_id=$1 AND payment_mode='csms_billed'", [driver]),
    ).toHaveLength(1);
  });
  it('refund and RFID Start serialize; full hold or full refund wins, physical debt stays attributed', async () => {
    const f = await refundFixture();
    const result = await Promise.allSettled([start(), f.service.refund(f.top, f.admin)]);
    const summary = await creditSummary(db, String(driver));
    if (result[1].status === 'fulfilled')
      expect(summary).toMatchObject({ balance_vnd: 0, held_vnd: 0, blocking_rfid_sessions: 1 });
    else expect(summary).toMatchObject({ balance_vnd: 200000, held_vnd: 200000 });
    expect(
      await q("SELECT * FROM sessions WHERE driver_id=$1 AND payment_mode='csms_billed'", [driver]),
    ).toHaveLength(1);
  });
  it('rejects refund for unheld historical closed debt and reports blocking exposure without fake money', async () => {
    const f = await refundFixture();
    await q(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,driver_id,origin,payment_mode,status,
      cp_started_at,received_started_at,received_stopped_at,meter_start_wh) SELECT id,$1,1,$2,$3,'rfid','csms_billed','review',
      now()-interval '1 day',now()-interval '1 day',now(),1000 FROM connectors WHERE charge_point_id=$1 AND connector_no=1`,
      [cp, tag, driver],
    );
    expect(await creditSummary(db, String(driver))).toMatchObject({
      held_vnd: 0,
      available_vnd: 200000,
      blocking_rfid_sessions: 1,
    });
    await expect(f.service.refund(f.top, f.admin)).rejects.toMatchObject({
      reason: 'insufficient_available_balance',
    });
    expect(await sessions.authorize(tag)).toBe('Blocked');
  });
  it('retains reservation through tariff pending, then releases atomically when settlement posts', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await q(
      'DELETE FROM tariff_periods WHERE operator_id=(SELECT operator_id FROM sites WHERE id=(SELECT site_id FROM charge_points WHERE id=$1))',
      [cp],
    );
    await stop(tx);
    expect((await hold(s)).state).toBe('held');
    expect(
      (await q('SELECT state FROM charge_settlement_jobs WHERE session_id=$1', [s]))[0].state,
    ).toBe('pending');
    expect(await sessions.authorize(tag)).toBe('Blocked');
  });
  it('T158 keeps closed-account holds and terminal reason stable across retries', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await q(
      "UPDATE credit_accounts SET status='closed',closed_at=now(),updated_at=now() WHERE driver_id=$1",
      [driver],
    );
    await stop(tx);
    const before = (await q('SELECT * FROM charge_settlement_jobs WHERE session_id=$1', [s]))[0];
    await Promise.all([settlement.settle(s), settlement.settle(s)]);
    expect((await q('SELECT * FROM charge_settlement_jobs WHERE session_id=$1', [s]))[0]).toEqual(
      before,
    );
    expect(before).toMatchObject({ state: 'ineligible', reason: 'account_closed' });
    expect((await hold(s)).state).toBe('held');
  });
  it.each(['Rejected', 'timeout'])(
    'finite cumulative retry budget for %s never resets on fresh meters',
    async (outcome) => {
      rpc.mockImplementation(async () => {
        if (outcome === 'timeout') throw Error('transport');
        return { status: outcome };
      });
      const tx = (await start()).transactionId,
        s = await sid(tx);
      await meter(tx, '39000');
      for (let n = 0; n < 5; n++) {
        await q(
          "UPDATE rfid_stop_jobs SET next_attempt_at=now()-interval '1 second',updated_at=now() WHERE session_id=$1",
          [s],
        );
        await charging.onMeter(tx);
      }
      expect(rpc).toHaveBeenCalledTimes(3);
      expect(await job(s)).toMatchObject({ state: 'exhausted', attempts: 3 });
    },
  );
  it('Stop evidence wins a late Accepted callback without releasing pending settlement hold', async () => {
    let resolve!: (value: { status: string }) => void;
    rpc.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '39000');
    const pending = charging.onMeter(tx);
    await until(async () => rpc.mock.calls.length === 1);
    await q(
      "UPDATE sessions SET status='review',received_stopped_at=now(),updated_at=now() WHERE id=$1",
      [s],
    );
    await charging.onStopped(tx);
    const command = (await job(s)).current_command_id;
    const snapshot = (await q('SELECT * FROM remote_commands WHERE id=$1', [command]))[0];
    resolve({ status: 'Accepted' });
    await pending;
    expect(await job(s)).toMatchObject({ state: 'completed', attempts: 1 });
    expect((await q('SELECT * FROM remote_commands WHERE id=$1', [command]))[0]).toEqual(snapshot);
    expect((await hold(s)).state).toBe('held');
  });
  it('offline buffered Start/Stop causes no allocation or RemoteStop and closed duplicate cannot reserve', async () => {
    const timestamp = new Date(Date.now() - 3600000).toISOString();
    const context = {
      ...ctx,
      replay: { replayed: true, reason: 'before_epoch' as const, skewS: 3600 },
    };
    const tx = (await start(1, timestamp, context)).transactionId,
      s = await sid(tx);
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    await stop(tx);
    await charging.onMeter(tx);
    await start(1, timestamp, context);
    expect(rpc).not.toHaveBeenCalled();
    expect((await hold(s)).amount_vnd).toBe('0');
  });
  it('free vend never creates hold, debit, or system stop', async () => {
    await q("UPDATE rfid_cards SET card_kind='free_vend',driver_id=NULL WHERE card_identifier=$1", [
      tag,
    ]);
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '90000');
    await charging.onMeter(tx);
    await stop(tx, 90000);
    expect(await hold(s)).toBeUndefined();
    expect(await job(s)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(await q('SELECT id FROM credit_transactions WHERE session_id=$1', [s])).toHaveLength(0);
  });
  it('exhausted jobs stay visible after more than twenty commands and are operator-scoped', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '39000');
    await charging.onMeter(tx);
    await q(
      "UPDATE rfid_stop_jobs SET state='exhausted',attempts=attempt_limit,exhausted_at=now(),updated_at=now() WHERE session_id=$1",
      [s],
    );
    await q(
      "INSERT INTO remote_commands(charge_point_id,action,status) SELECT $1,'TriggerMessage','accepted' FROM generate_series(1,25)",
      [cp],
    );
    const op = (
      await q(
        'SELECT st.operator_id FROM charge_points cp JOIN sites st ON st.id=cp.site_id WHERE cp.id=$1',
        [cp],
      )
    )[0].operator_id;
    const thresholds = { staleAfterMs: 600000, offlineAfterMs: 900000 };
    const detail = (await runMonitoringRoute(
      { kind: 'detail', id: String(cp) } as any,
      { userId: '1', role: 'operator_staff', operatorId: op },
      db,
      thresholds,
      registry,
      { list: async () => [] } as any,
    )) as any;
    expect(detail.recent_commands).toHaveLength(20);
    expect(detail.rfid_credit_protection).toMatchObject({ exhausted_stops: 1, total: 1 });
    expect(detail.rfid_credit_protection.items[0]).toMatchObject({
      session_id: String(s),
      stop_state: 'exhausted',
      attempts: 3,
      held_vnd: '200000',
    });
    await expect(
      runMonitoringRoute(
        { kind: 'detail', id: String(cp) } as any,
        { userId: '1', role: 'operator_staff', operatorId: '999999' },
        db,
        thresholds,
        registry,
        { list: async () => [] } as any,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await runAdminSummary(db, thresholds)).rfid_credit_protection.exhausted_stops,
    ).toBeGreaterThanOrEqual(1);
  });
  it('background sweep returns while RPC is pending so settlement and timers can run', async () => {
    rpc.mockImplementation(() => new Promise(() => {}));
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '39000');
    const startMs = Date.now();
    await charging.sweepRfidStops();
    expect(Date.now() - startMs).toBeLessThan(100);
    await until(async () => {
      await charging.sweepRfidStops();
      return rpc.mock.calls.length > 0;
    });
    await q(
      "UPDATE sessions SET status='review',received_stopped_at=now(),updated_at=now() WHERE id=$1",
      [s],
    );
    await charging.onStopped(tx);
    expect((await job(s)).state).toBe('completed');
    await new Promise((r) => setTimeout(r, 70));
  });

  it('replay debt obtains its budget once after verified live current-epoch meter, then topup cannot enlarge it', async () => {
    const tx = (
        await start(1, new Date(Date.now() - 10000).toISOString(), {
          ...ctx,
          replay: { replayed: true, reason: 'before_epoch', skewS: 10 },
        })
      ).transactionId,
      s = await sid(tx);
    expect((await hold(s)).amount_vnd).toBe('0');
    await meter(tx, '1500');
    await charging.onMeter(tx);
    expect(await hold(s)).toMatchObject({ amount_vnd: '200000', reason: 'live_recovered' });
    await q('UPDATE credit_accounts SET balance_vnd=400000 WHERE driver_id=$1', [driver]);
    await meter(tx, '1600');
    await charging.onMeter(tx);
    expect((await hold(s)).amount_vnd).toBe('200000');
    await stop(tx);
    expect((await hold(s)).state).toBe('released');
  });
  it('Stop winning the live-proof race prevents any deferred reservation', async () => {
    const tx = (
        await start(1, new Date(Date.now() - 10000).toISOString(), {
          ...ctx,
          replay: { replayed: true, reason: 'before_epoch', skewS: 10 },
        })
      ).transactionId,
      s = await sid(tx);
    await meter(tx, '1500');
    await stop(tx);
    await charging.onMeter(tx);
    expect((await hold(s)).amount_vnd).toBe('0');
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([39000, 500])(
    'hard-cap review without Stop persists the first physical Stop (%i) after reconnect while retaining financial review',
    async (stopWh) => {
      const tx = (await start()).transactionId,
        s = await sid(tx);
      await q("UPDATE sessions SET status='review',updated_at=now() WHERE id=$1", [s]);
      const conn = await registry.open(
        identity,
        { identity, call: rpc, close: async () => undefined },
        { openedAt: new Date(Date.now() - 10) },
      );
      ctx = { ...ctx, epoch: conn.epoch, epochOpenedAt: conn.epochOpenedAt };
      await meter(tx, '39000');
      await charging.onMeter(tx);
      expect(rpc).toHaveBeenCalledWith(
        'RemoteStopTransaction',
        { transactionId: tx },
        expect.anything(),
      );
      expect((await q('SELECT status FROM sessions WHERE id=$1', [s]))[0].status).toBe('review');
      expect((await hold(s)).state).toBe('held');
      await charging.onStopped(tx);
      expect((await job(s)).state).toBe('awaiting_stop');
      await stop(tx, stopWh);
      const stopped = (
        await q('SELECT status,received_stopped_at,meter_stop_wh FROM sessions WHERE id=$1', [s])
      )[0];
      expect(stopped.status).toBe('review');
      expect(stopped.received_stopped_at).toBeInstanceOf(Date);
      expect(stopped.meter_stop_wh).toBe(stopWh >= 1000 ? String(stopWh) : null);
      expect((await job(s)).state).toBe('completed');
      expect((await hold(s)).state).toBe('held');
      await stop(tx, stopWh);
      expect(
        (await q('SELECT received_stopped_at FROM sessions WHERE id=$1', [s]))[0]
          .received_stopped_at,
      ).toEqual(stopped.received_stopped_at);
      expect(
        (await q('SELECT state FROM charge_settlement_jobs WHERE session_id=$1', [s]))[0].state,
      ).toBe('pending');
    },
  );
  it('fractional aggregate meter uses exact scaled arithmetic at cutoff boundary', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '38999.999');
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    await meter(tx, '39000');
    await charging.onMeter(tx);
    expect((await job(s)).reason).toBe('credit_cutoff');
  });
  it('invalid/decreasing meter evidence produces a durable safety stop instead of zero cost', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '1500');
    await meter(tx, '1400');
    await charging.onMeter(tx);
    expect(await job(s)).toMatchObject({ reason: 'meter_evidence_unavailable', attempts: 1 });
  });
  it('missing tariff and stale/missing meter trigger bounded safety jobs', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await q(
      'DELETE FROM tariff_periods WHERE operator_id=(SELECT operator_id FROM sites WHERE id=(SELECT site_id FROM charge_points WHERE id=$1))',
      [cp],
    );
    await charging.onMeter(tx);
    expect(await job(s)).toMatchObject({ reason: 'tariff_unavailable' });
  });
  it('unfunded late QR Start after refund is recorded for review and stopped even above the cutoff reserve', async () => {
    const input = await qrFixture(),
      f = await refundFixture();
    const snap = await charging.start(driver, 'late-qr-key', input);
    const intent = (await q('SELECT * FROM driver_charge_intents WHERE id=$1', [snap.intentId]))[0];
    await q(
      "UPDATE remote_commands SET requested_at=now()-interval '3 minutes',sent_at=now()-interval '2 minutes',responded_at=now()-interval '1 minute' WHERE id=$1",
      [snap.commandId],
    );
    expect(await charging.expireStaleStarts(1)).toBeGreaterThanOrEqual(1);
    expect(
      (await q('SELECT state FROM driver_charge_intents WHERE id=$1', [snap.intentId]))[0].state,
    ).toBe('released');
    await f.service.refund(f.top, f.admin);
    await q('UPDATE credit_accounts SET balance_vnd=40000 WHERE driver_id=$1', [driver]);
    const timestamp = new Date().toISOString();
    const result = await sessions.onStartTransaction(
      { connectorId: 2, idTag: intent.id_tag, meterStart: 1000, timestamp },
      { ...ctx, receivedAt: new Date(), cpTimestamp: new Date(timestamp) },
    );
    const session = await sid(result.transactionId);
    expect(
      await q(
        "SELECT * FROM session_status_history WHERE session_id=$1 AND event='UNDERFUNDED_LATE_START'",
        [session],
      ),
    ).toHaveLength(1);
    await charging.onMeter(result.transactionId);
    expect(rpc).toHaveBeenCalledWith(
      'RemoteStopTransaction',
      { transactionId: result.transactionId },
      expect.anything(),
    );
    expect(
      (
        await q('SELECT billing_review_required FROM driver_charge_intents WHERE id=$1', [
          snap.intentId,
        ])
      )[0].billing_review_required,
    ).toBe(true);
  });

  it('T134 offset-corrected live evidence funds and stops replay-flagged RFID without a raw-clock gate', async () => {
    ctx = { ...ctx, replay: { replayed: true, reason: 'before_epoch', skewS: 600 } };
    const tx = (await start(1, new Date(Date.now() - 600000).toISOString())).transactionId,
      s = await sid(tx);
    await new Promise((r) => setTimeout(r, 5500));
    await meter(tx, '1100', new Date(Date.now() - 600000));
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5500));
    await meter(tx, '1200', new Date(Date.now() - 600000));
    await charging.onMeter(tx);
    expect(await hold(s)).toMatchObject({ amount_vnd: '200000', reason: 'live_recovered' });
    const conn = await registry.open(
      identity,
      { identity, call: rpc, close: async () => undefined },
      { openedAt: new Date() },
    );
    ctx = { ...ctx, epoch: conn.epoch, epochOpenedAt: conn.epochOpenedAt };
    await meter(tx, '1300', new Date(Date.now() - 600000));
    await new Promise((r) => setTimeout(r, 5500));
    await meter(tx, '1400', new Date(Date.now() - 600000));
    await new Promise((r) => setTimeout(r, 5500));
    await meter(tx, '39000', new Date(Date.now() - 600000));
    await charging.onMeter(tx);
    expect(await job(s)).toMatchObject({ reason: 'credit_cutoff', state: 'awaiting_stop' });
  });
  it('current coverage can reduce the protected budget but never subtracts the session own hold twice', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await q('UPDATE credit_accounts SET balance_vnd=150000 WHERE driver_id=$1', [driver]);
    await meter(tx, '28000');
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    await meter(tx, '29000');
    await charging.onMeter(tx);
    expect((await job(s)).reason).toBe('credit_cutoff');
  });
  it('deferred live proof races a refund under the same account lock and never over-reserves', async () => {
    const f = await refundFixture();
    const tx = (
        await start(1, new Date(Date.now() - 10000).toISOString(), {
          ...ctx,
          replay: { replayed: true, reason: 'before_epoch', skewS: 10 },
        })
      ).transactionId,
      s = await sid(tx);
    await meter(tx, '1500');
    await Promise.allSettled([charging.onMeter(tx), f.service.refund(f.top, f.admin)]);
    const summary = await creditSummary(db, String(driver));
    expect(summary.available_vnd).toBeGreaterThanOrEqual(0);
    expect(['0', '200000']).toContain((await hold(s)).amount_vnd);
  });
  it('missing energy evidence after stale window persists an actionable reason with held money', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await q(
      "UPDATE sessions SET received_started_at=now()-interval '1 day',updated_at=now() WHERE id=$1",
      [s],
    );
    const openedAt = new Date(Date.now() - 2 * 86400000);
    registry.get(identity)!.epochOpenedAt = openedAt;
    await q(
      'UPDATE charge_point_connections SET opened_at=$3 WHERE charge_point_id=$1 AND epoch=$2',
      [cp, ctx.epoch, openedAt],
    );
    await q('UPDATE charge_points SET online_changed_at=$2 WHERE id=$1', [cp, openedAt]);
    await charging.onMeter(tx);
    expect((await job(s)).reason).toBe('meter_evidence_unavailable');
    expect((await hold(s)).state).toBe('held');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('conflicting multisample energy cannot be interpreted as zero cost', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    const at = new Date();
    await sessions.onMeterValues(
      {
        connectorId: 1,
        transactionId: tx,
        meterValue: [
          {
            timestamp: at.toISOString(),
            sampledValue: [
              { value: '1500', unit: 'Wh', measurand: 'Energy.Active.Import.Register' },
              { value: '1600', unit: 'Wh', measurand: 'Energy.Active.Import.Register' },
            ],
          },
        ],
      },
      { ...ctx, receivedAt: new Date(), cpTimestamp: at },
    );
    await charging.onMeter(tx);
    expect((await job(s)).reason).toBe('meter_evidence_unavailable');
  });

  it('restart recovers a persisted Stop even if the gateway completion callback was lost', async () => {
    const tx = (await start()).transactionId,
      s = await sid(tx);
    await meter(tx, '39000');
    await charging.onMeter(tx);
    await q(
      "UPDATE sessions SET status='review',received_stopped_at=now(),updated_at=now() WHERE id=$1",
      [s],
    );
    const restarted = new DriverChargingService(db, registry, settlement, policy);
    await until(async () => {
      await restarted.sweepRfidStops();
      return (await job(s)).state === 'completed';
    });
    expect((await hold(s)).state).toBe('held');
    expect((await job(s)).attempts).toBe(1);
  });

  it('network loss waits through replay and healthy reconnect meters, then stops only at the 40000 credit threshold', async () => {
    const { tx, session } = await networkFixture();
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    await registry.close(registry.get(identity)!.client, {
      closedAt: new Date(Date.now() - 30000),
    });
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    await charging.sweepRfidStops();
    await until(async () => db.$client.idleCount === db.$client.totalCount);
    expect(await job(session)).toBeUndefined();
    expect((await hold(session)).amount_vnd).toBe('50000');
    await reconnectNetworkFixture();
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    ctx = { ...ctx, replay: { replayed: true, reason: 'before_epoch', skewS: 20 } };
    await meter(tx, '7000', new Date(Date.now() - 20000));
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    ctx = { ...ctx, replay: { replayed: false, reason: null, skewS: 0 } };
    await meter(tx, '7200', new Date(ctx.epochOpenedAt.getTime() - 3660));
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    await meter(tx, '7500');
    await charging.onMeter(tx);
    expect(rpc).not.toHaveBeenCalled();
    expect(await job(session)).toBeUndefined();
    await meter(tx, '9000');
    await charging.onMeter(tx);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await job(session)).toMatchObject({
      reason: 'credit_cutoff',
      state: 'awaiting_stop',
      attempts: 1,
    });
    expect(
      await q(
        "SELECT id FROM session_status_history WHERE session_id=$1 AND event='METER_EVIDENCE_CONFLICT'",
        [session],
      ),
    ).toHaveLength(0);
  });
  it('long-running reconnect gives the current connection its live-meter window instead of using session age', async () => {
    const { tx, session } = await networkFixture(policy.stationStaleAfterMs * 2);
    await registry.close(registry.get(identity)!.client, {
      closedAt: new Date(Date.now() - 30000),
    });
    await reconnectNetworkFixture();
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    await meter(tx, '7500');
    await charging.onMeter(tx);
    expect(await job(session)).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
    expect((await hold(session)).state).toBe('held');
  });

  it('T150 offline-auth protection and RFID credit cutoff both run after their inbound acknowledgements', async () => {
    const config = loadConfig({
      DATABASE_URL: url,
      OFFLINE_AUTH_CHECK_ENABLED: 'true',
      OFFLINE_TX_FALLBACK_S: '30',
    });
    const offline = new OfflineAuthCheckService(db, config, registry);
    offline.afterBootDelayMs = 0;
    rpc.mockImplementation(async (action: string) => {
      if (action === 'GetConfiguration')
        return {
          configurationKey: [
            ...['LocalAuthorizeOffline', 'LocalPreAuthorize', 'AllowOfflineTxForUnknownId'].map(
              (key) => ({ key, value: 'true', readonly: false }),
            ),
            { key: 'SupportedFeatureProfiles', value: 'Core,SmartCharging', readonly: true },
          ],
        };
      return { status: action === 'ChangeConfiguration' ? 'Rejected' : 'Accepted' };
    });
    const handlers = new OcppHandlers(sessions, config, charging, undefined, offline);
    expect(
      await handlers.dispatch(
        'BootNotification',
        { chargePointVendor: 'Fixture', chargePointModel: 'D1' },
        ctx,
      ),
    ).toMatchObject({ status: 'Accepted' });
    await until(
      async () =>
        (await q('SELECT id FROM charge_point_offline_auth_checks WHERE charge_point_id=$1', [cp]))
          .length === 1,
    );
    expect(
      rpc.mock.calls.some(
        ([action, params]) =>
          action === 'SetChargingProfile' &&
          params.csChargingProfiles.chargingProfilePurpose === 'TxDefaultProfile',
      ),
    ).toBe(true);
    const timestamp = new Date().toISOString(),
      request = { connectorId: 1, idTag: tag, meterStart: 1000, timestamp };
    const at = new Date(),
      messageLogId = await new OcppMessageLogger(db).log({
        chargePointId: cp,
        epoch: ctx.epoch,
        direction: 'in',
        messageType: 2,
        uniqueId: tag,
        action: 'StartTransaction',
        cpTimestamp: new Date(timestamp),
        receivedAt: at,
        replayed: false,
        raw: [2, tag, 'StartTransaction', request],
      });
    const ack = await handlers.dispatch('StartTransaction', request, {
      ...ctx,
      receivedAt: at,
      cpTimestamp: new Date(timestamp),
      messageLogId,
    });
    expect(ack.idTagInfo).toEqual({ status: 'Accepted' });
    const tx = Number(ack.transactionId),
      session = await sid(tx);
    await until(async () =>
      rpc.mock.calls.some(
        ([action, params]) =>
          action === 'SetChargingProfile' &&
          params.csChargingProfiles.chargingProfilePurpose === 'TxProfile' &&
          params.csChargingProfiles.transactionId === tx,
      ),
    );
    expect((await hold(session)).amount_vnd).toBe('200000');
    const meterAt = new Date(),
      meterRequest = {
        connectorId: 1,
        transactionId: tx,
        meterValue: [
          {
            timestamp: meterAt.toISOString(),
            sampledValue: [
              { value: '39000', unit: 'Wh', measurand: 'Energy.Active.Import.Register' },
            ],
          },
        ],
      };
    const meterLogId = await new OcppMessageLogger(db).log({
      chargePointId: cp,
      epoch: ctx.epoch,
      direction: 'in',
      messageType: 2,
      uniqueId: tag + '-meter',
      action: 'MeterValues',
      cpTimestamp: meterAt,
      receivedAt: meterAt,
      replayed: false,
      raw: [2, tag + '-meter', 'MeterValues', meterRequest],
    });
    expect(
      await handlers.dispatch('MeterValues', meterRequest, {
        ...ctx,
        receivedAt: meterAt,
        cpTimestamp: meterAt,
        messageLogId: meterLogId,
      }),
    ).toEqual({});
    await until(async () => (await job(session))?.state === 'awaiting_stop');
    expect(await job(session)).toMatchObject({ reason: 'credit_cutoff', attempts: 1 });
    expect((await hold(session)).state).toBe('held');
  });
});
