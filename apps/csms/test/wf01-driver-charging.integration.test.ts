// WP3/T31: real Postgres and OCPP transport; seeded inputs never replace business outputs.
import { Logger } from '@nestjs/common';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RPCClient } from 'ocpp-rpc';
import { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { OfflineGraceService } from '../src/ocpp-gateway/offline-grace.service.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { ChargePolicy } from '../src/sessions/charge-start-policy.js';
import {
  DriverChargingService,
  EnergyStartInput,
} from '../src/sessions/driver-charging.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { PillarAuthService } from '../src/stations/pillar-auth.service.js';
import { hashPillarPassword } from '../src/stations/pillar-credential.js';
import { MIGRATIONS_DIR, resetAndMigrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 150,
  stationStaleAfterMs: 600000,
};

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('observable effect not received');
}

describeDb('WP3/T31 WF-01 service journey with real OCPP + Postgres', () => {
  let db: Db;
  let server: OcppServer;
  let sessionsService: SessionsService;
  let registry: ConnectionRegistry;
  let pillarPassword: string;
  let availabilityResponse: 'Accepted' | 'Rejected' | 'Scheduled' | 'silence';
  let grace: OfflineGraceService;
  let client: RPCClient;
  let service: DriverChargingService;
  let settlement: ChargeSettlementService;
  let config: CsmsConfig;
  let driver: number;
  let other: number;
  let admin: number;
  let vehicle: number;
  let connector: number;
  let input: EnergyStartInput;
  let startCount: number;
  let stopCount: number;
  let tag: string;
  let transaction: number;
  let startTimestamp: string;
  let meterStop: number;
  let startResponse: 'Accepted' | 'Rejected' | 'silence';
  let stopResponse: 'Accepted' | 'Rejected' | 'silence' | 'accepted_no_effect';
  let stopEffectBeforeReply: boolean;
  let triggerCount: number;
  let startBeforeReply: boolean;
  let authorizeRemoteStart: boolean;
  let remoteAuthorizeStatus: string | undefined;
  let extraClients: RPCClient[];
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('T31 requires powerme_test');
    Logger.overrideLogger(['error']);
    db = createDb(url);
  });
  beforeEach(async () => {
    extraClients = [];
    await resetAndMigrate(db.$client);
    const op = (
      await q("INSERT INTO operators(tax_code,legal_name) VALUES('T31','T31 Test') RETURNING id")
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('T31',$1,'T31 Site') RETURNING id",
        [op],
      )
    )[0]!.id;
    const password = (pillarPassword = randomBytes(18).toString('base64url'));
    const hash = await hashPillarPassword(password);
    const cp = (
      await q(
        `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,basic_auth_password_hash)
      VALUES('T31-PILLAR','PM-D1-HCM-0031',$1,'awaiting_connection',$2) RETURNING id`,
        [site, hash],
      )
    )[0]!.id;
    connector = Number(
      (
        await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id', [
          cp,
        ])
      )[0]!.id,
    );
    for (const name of ['driver', 'other', 'admin']) {
      const id = Number(
        (
          await q('INSERT INTO users(email,full_name,role) VALUES($1,$2,$3) RETURNING id', [
            `${name}@t31.test`,
            name,
            name === 'admin' ? 'admin' : 'driver',
          ])
        )[0]!.id,
      );
      if (name === 'admin') {
        admin = id;
        continue;
      }
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
        [id],
      );
      const account = (
        await q(
          'INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,200000) RETURNING id',
          [id],
        )
      )[0]!.id;
      await q(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd)
        VALUES($1,1,'adjustment',200000,200000)`,
        [account],
      );
      if (name === 'driver') driver = id;
      else other = id;
    }
    const model = (
      await q("INSERT INTO vehicle_models(brand,model_name) VALUES('Test','EV') RETURNING id")
    )[0]!.id;
    vehicle = Number(
      (
        await q(
          "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,'T31') RETURNING id",
          [driver, model],
        )
      )[0]!.id,
    );
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      VALUES($1,'normal','00:00','24:00',5000,current_date-1)`,
      [op],
    );
    config = {
      databaseUrl: url!,
      ocppPort: await freePort(),
      heartbeatIntervalS: 300,
      sessionStartTimeoutS: 120,
      sessionHardCapH: 24,
      replaySkewThresholdS: 5,
      meterValueSampleIntervalS: 10,
      reconcileGapFactor: 3,
      reconcileEnergyToleranceWh: 1,
      consoleEnabled: false,
      consoleHost: '127.0.0.1',
      consolePort: 0,
      offlineGraceS: 60,
    };
    registry = new ConnectionRegistry(db);
    const sessions = (sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    ));
    settlement = new ChargeSettlementService(db, policy);
    service = new DriverChargingService(db, registry, settlement, policy);
    grace = new OfflineGraceService(db, config, sessions, registry);
    server = new OcppServer(
      config,
      registry,
      new OcppMessageLogger(db),
      new InboundSerializer(),
      new ReplayDetector(5),
      new OcppHandlers(sessions, config, service),
      sessions,
      new PillarAuthService(db, config),
      grace,
    );
    await server.start();
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T31-PILLAR',
      password,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    availabilityResponse = 'Accepted';
    client.handle('ChangeAvailability', async () => {
      if (availabilityResponse === 'silence')
        await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: availabilityResponse === 'silence' ? 'Accepted' : availabilityResponse };
    });
    startCount = 0;
    stopCount = 0;
    tag = '';
    transaction = 0;
    meterStop = 11000;
    startResponse = 'Accepted';
    stopResponse = 'Accepted';
    stopEffectBeforeReply = false;
    startBeforeReply = false;
    authorizeRemoteStart = false;
    remoteAuthorizeStatus = undefined;
    triggerCount = 0;
    client.handle('TriggerMessage', async () => {
      triggerCount++;
      return { status: 'Accepted' };
    });
    client.handle('RemoteStartTransaction', async ({ params }) => {
      startCount++;
      tag = (params as { idTag: string }).idTag;
      if (authorizeRemoteStart) {
        await client.call('StatusNotification', {
          connectorId: 1,
          errorCode: 'NoError',
          status: 'Preparing',
        });
        remoteAuthorizeStatus = (
          (await client.call('Authorize', { idTag: tag })) as { idTagInfo: { status: string } }
        ).idTagInfo.status;
        if (remoteAuthorizeStatus !== 'Accepted') return { status: 'Rejected' };
      }
      if (startBeforeReply) {
        startTimestamp = new Date().toISOString();
        transaction = (
          (await client.call('StartTransaction', {
            connectorId: 1,
            idTag: tag,
            meterStart: 1000,
            timestamp: startTimestamp,
          })) as { transactionId: number }
        ).transactionId;
      }
      if (startResponse === 'silence') await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: startResponse === 'Rejected' ? 'Rejected' : 'Accepted' };
    });
    client.handle('RemoteStopTransaction', async () => {
      stopCount++;
      const response = stopResponse;
      if (stopEffectBeforeReply) await sendStop();
      if (response === 'silence') await new Promise((resolve) => setTimeout(resolve, 600));
      if (response === 'Accepted')
        setImmediate(() => {
          void sendStop().catch(() => undefined);
        });
      return { status: response === 'Rejected' ? 'Rejected' : 'Accepted' };
    });
    await client.connect();
    await client.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'D1' });
    await client.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    await until(async () => triggerCount === 3);
    input = {
      connectorId: connector,
      vehicleId: vehicle,
      energyLimitWh: 10000,
      mode: 'energy_kwh',
    };
  });
  afterEach(async () => {
    for (const extra of extraClients) await extra.close({ force: true });
    await client?.close({ force: true });
    await server?.stop();
    await until(
      async () =>
        (await q("SELECT 1 FROM charge_points WHERE serial_number='T31-PILLAR' AND NOT is_online"))
          .length === 1,
    );
    await until(
      async () => db.$client.waitingCount === 0 && db.$client.idleCount === db.$client.totalCount,
    );
    grace?.cancelAll();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  async function observedStart(key = 'start') {
    await service.start(driver, key, input);
    startTimestamp = new Date().toISOString();
    const result = (await client.call('StartTransaction', {
      connectorId: 1,
      idTag: tag,
      meterStart: 1000,
      timestamp: startTimestamp,
    })) as { transactionId: number };
    transaction = result.transactionId;
    return (await service.getStart(driver, key)).sessionId!;
  }
  async function meter(value: string, unit = 'Wh') {
    await client.call('MeterValues', {
      connectorId: 1,
      transactionId: transaction,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [{ value, unit, measurand: 'Energy.Active.Import.Register' }],
        },
      ],
    });
  }
  async function sendStop() {
    return client.call('StopTransaction', {
      transactionId: transaction,
      meterStop,
      timestamp: new Date().toISOString(),
      reason: 'Remote',
    });
  }

  async function secondPillar() {
    const cp = (
      await q(`INSERT INTO charge_points(serial_number,site_id,lifecycle,basic_auth_password_hash)
      SELECT 'T72-SECOND',site_id,'awaiting_connection',basic_auth_password_hash FROM charge_points
      WHERE serial_number='T31-PILLAR' RETURNING id`)
    )[0]!.id;
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1)', [cp]);
    const second = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T72-SECOND',
      password: pillarPassword,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    extraClients.push(second);
    second.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    await second.connect();
    await second.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'D1' });
    return second;
  }

  async function authorize(idTag = tag, caller = client) {
    return caller.call('Authorize', { idTag });
  }

  it('T72 AuthorizeRemoteTxRequests accepts a reserved P3 intent before RemoteStart replies and starts once', async () => {
    await q('UPDATE credit_accounts SET balance_vnd=50000 WHERE driver_id=$1', [driver]);
    authorizeRemoteStart = true;
    startBeforeReply = true;
    const result = await service.start(driver, 'authorize-before-reply', input);
    expect(remoteAuthorizeStatus).toBe('Accepted');
    expect(result).toMatchObject({ outcome: 'active', effectConfirmed: true });
    expect(startCount).toBe(1);
    expect(
      await q("SELECT 1 FROM sessions WHERE driver_id=$1 AND payment_mode='csms_billed'", [driver]),
    ).toHaveLength(1);
    expect(await authorize()).toEqual({ idTagInfo: { status: 'Invalid' } });
  });

  it('T72 Authorize accepts a pending intent repeatedly without creating sessions or double-reserving credit', async () => {
    await service.start(driver, 'auth-pending', input);
    const before = await q('SELECT * FROM driver_charge_intents');
    for (let i = 0; i < 2; i++)
      expect(await authorize()).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(await q('SELECT * FROM driver_charge_intents')).toEqual(before);
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
  });

  it('T72 Authorize keeps a timed-out pending start recoverable within its original connection', async () => {
    startResponse = 'silence';
    expect((await service.start(driver, 'auth-unknown', input)).outcome).toBe('unknown');
    expect(await authorize()).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect((await service.getStart(driver, 'auth-unknown')).outcome).toBe('unknown');
    expect(startCount).toBe(1);
  });

  it('T72 Authorize refuses forged P3 tags and a valid intent sent by another authenticated pillar', async () => {
    await service.start(driver, 'auth-binding', input);
    expect(await authorize('P3000000000000000000')).toEqual({ idTagInfo: { status: 'Invalid' } });
    expect(await authorize(tag, await secondPillar())).toEqual({
      idTagInfo: { status: 'Invalid' },
    });
    expect(await authorize()).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
  });

  it.each([
    ['rejected', "UPDATE driver_charge_intents SET state='rejected',reserved_vnd=0"],
    [
      'released',
      "UPDATE driver_charge_intents SET state='released',reserved_vnd=0,connector_released_at=now()",
    ],
    ['settled', "UPDATE driver_charge_intents SET state='settled'"],
    ['effect', "UPDATE driver_charge_intents SET state='effect'"],
    ['suspended driver', "UPDATE users SET account_status='suspended' WHERE role='driver'"],
    ['closed credit', "UPDATE credit_accounts SET status='closed',closed_at=now()"],
    ['insufficient credit', 'UPDATE credit_accounts SET balance_vnd=30000'],
    ['released reserve', 'UPDATE driver_charge_intents SET reserved_vnd=0'],
    ['disabled pillar', "UPDATE charge_points SET lifecycle='disabled'"],
    ['inactive operator', "UPDATE operators SET status='suspended'"],
    ['unowned vehicle', 'UPDATE vehicles SET driver_id=(SELECT max(user_id) FROM drivers)'],
    [
      'command mismatch',
      "UPDATE remote_commands SET payload=jsonb_set(payload,'{idTag}','\"forged\"')",
    ],
  ])('T72 Authorize refuses a pending app tag after %s', async (_reason, mutation) => {
    await service.start(driver, 'auth-deny', input);
    await q(mutation);
    const before = await q('SELECT * FROM driver_charge_intents');
    expect(await authorize()).toEqual({ idTagInfo: { status: 'Invalid' } });
    expect(await q('SELECT * FROM driver_charge_intents')).toEqual(before);
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
  });

  it('T72 Authorize refuses a previous-epoch intent after a real reconnect', async () => {
    await service.start(driver, 'auth-old-epoch', input);
    await client.close({ force: true });
    await until(async () => !registry.get('T31-PILLAR'));
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T31-PILLAR',
      password: pillarPassword,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    await client.connect();
    expect(await authorize()).toEqual({ idTagInfo: { status: 'Invalid' } });
    expect((await service.getStart(driver, 'auth-old-epoch')).outcome).toBe('accepted');
  });

  it.each(['MeterValues', 'StopTransaction'] as const)(
    'T72 session_pillar_mismatch rejects %s over authenticated OCPP without business mutation',
    async (action) => {
      const sid = await observedStart();
      const second = await secondPillar();
      const snapshot = async () =>
        Promise.all([
          q('SELECT * FROM sessions ORDER BY id'),
          q('SELECT * FROM meter_values ORDER BY id'),
          q('SELECT * FROM reconciliation_records ORDER BY id'),
          q('SELECT * FROM session_status_history ORDER BY id'),
          q('SELECT * FROM driver_charge_intents ORDER BY id'),
          q('SELECT * FROM charge_settlement_jobs ORDER BY session_id'),
          q('SELECT * FROM credit_transactions ORDER BY id'),
          q('SELECT * FROM loyalty_transactions ORDER BY id'),
        ]);
      const before = await snapshot();
      const sample = [
        { timestamp: new Date().toISOString(), sampledValue: [{ value: '11000', unit: 'Wh' }] },
      ];
      const params =
        action === 'MeterValues'
          ? { connectorId: 1, transactionId: transaction, meterValue: sample }
          : {
              transactionId: transaction,
              meterStop: 11000,
              timestamp: new Date().toISOString(),
              transactionData: sample,
            };
      await expect(second.call(action, params)).rejects.toMatchObject({
        rpcErrorCode: 'GenericError',
        message: 'session_pillar_mismatch',
      });
      expect(await snapshot()).toEqual(before);
      expect(
        await q(
          `SELECT 1 FROM ocpp_message_log l JOIN charge_points cp ON cp.id=l.charge_point_id
        WHERE cp.serial_number='T72-SECOND' AND l.action=$1 AND l.direction='in' AND l.message_type=2`,
          [action],
        ),
      ).toHaveLength(1);
      if (action === 'MeterValues') {
        expect(await client.call(action, params)).toEqual({});
        expect(await q('SELECT 1 FROM meter_values WHERE session_id=$1', [sid])).toHaveLength(1);
      } else {
        expect(await client.call(action, params)).toEqual({ idTagInfo: { status: 'Accepted' } });
        expect((await service.progress(driver, sid)).status).toBe('reconciled');
        expect(
          await q('SELECT 1 FROM charge_settlement_jobs WHERE session_id=$1', [sid]),
        ).toHaveLength(1);
      }
    },
  );

  it('DS01 full app service journey: find/QR/start/progress/limit/statement, debit and earn once', async () => {
    expect((await service.findStations(driver, vehicle)).items).toHaveLength(1);
    expect(
      (await service.resolveConnector(driver, vehicle, 'PM-D1-HCM-0031', 1)).connector_id,
    ).toBe(String(connector));
    const sid = await observedStart();
    expect((await service.getStart(driver, 'start')).outcome).toBe('active');
    await meter('6000');
    expect((await service.progress(driver, sid)).consumed_wh).toBe('5000');
    await meter('11000');
    await until(
      async () =>
        (await q('SELECT 1 FROM charging_statements WHERE session_id=$1', [sid])).length === 1,
    );
    expect((await service.getStart(driver, 'start')).outcome).toBe('reconciled');
    expect(await service.statement(driver, sid)).toMatchObject({
      energy_wh: '10000',
      amount_vnd: '50000',
      earned_points: '50',
    });
    expect(
      (await q('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [driver]))[0]!
        .balance_vnd,
    ).toBe('150000');
    expect(
      (await q('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [driver]))[0]!
        .points_balance,
    ).toBe('50');
    expect(startCount).toBe(1);
    expect(stopCount).toBe(1);
    await sendStop();
    expect(await settlement.settle(sid)).toBe('already_posted');
    expect(
      await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
    ).toHaveLength(1);
    expect(
      await q("SELECT 1 FROM loyalty_transactions WHERE transaction_type='earn'"),
    ).toHaveLength(1);
  });
  it('T72 persists retry work and ACKs stop despite a real ledger write failure', async () => {
    const sid = await observedStart();
    await q(`CREATE FUNCTION test_billing_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic transient billing fault' USING ERRCODE='40001'; END $$;
      CREATE TRIGGER test_billing_failure BEFORE INSERT ON credit_transactions
      FOR EACH ROW EXECUTE FUNCTION test_billing_failure()`);
    expect(await sendStop()).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(
      (await q('SELECT * FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0],
    ).toMatchObject({ state: 'pending', reason: 'transient_error', last_error_code: '40001' });
    expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
    expect(
      (await q('SELECT connector_released_at,reserved_vnd FROM driver_charge_intents'))[0],
    ).toMatchObject({ connector_released_at: expect.any(Date), reserved_vnd: '50000' });
    await q(
      'DROP TRIGGER test_billing_failure ON credit_transactions; DROP FUNCTION test_billing_failure()',
    );
    await q('UPDATE charge_settlement_jobs SET next_attempt_at=now()');
    const restarted = new ChargeSettlementService(db, policy);
    await Promise.all([restarted.retryPending(), settlement.retryPending()]);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('50000');
    expect(
      await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
    ).toHaveLength(1);
    expect(
      await q("SELECT 1 FROM loyalty_transactions WHERE transaction_type='earn'"),
    ).toHaveLength(1);
  });

  it('T72 review exposes pending reason and resumes after reconciliation', async () => {
    const sid = await observedStart();
    meterStop = 500;
    expect(await sendStop()).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect(
      (await q('SELECT * FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0],
    ).toMatchObject({ state: 'pending', reason: 'awaiting_reconciliation' });
    // WP3/T72: synthetic operator resolution, not an automatic override of the WP2 verdict.
    await q(
      "UPDATE sessions SET meter_stop_wh=11000,energy_wh=10000,status='reconciled' WHERE id=$1",
      [sid],
    );
    expect(await settlement.retryPending()).toBe(1);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('50000');
  });

  it.each([
    [1499, 1],
    [1500, 2],
    [1999, 2],
  ])('T72 BR-P45 %s milli-VND rounds once to %s VND', async (energy, amount) => {
    await q('UPDATE tariff_periods SET price_per_kwh_vnd=1');
    const sid = await observedStart();
    meterStop = 1000 + energy;
    await sendStop();
    expect((await service.statement(driver, sid)).amount_vnd).toBe(String(amount));
  });

  it('T72 pending billing frees the stopped connector but preserves its credit liability', async () => {
    const sid = await observedStart();
    meterStop = 500;
    await sendStop();
    expect((await service.getStart(driver, 'start')).outcome).toBe('review');
    await client.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    const ownVehicle = (
      await q(
        `INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number)
      SELECT $1,vehicle_model_id,'other' FROM vehicles WHERE id=$2 RETURNING id`,
        [other, vehicle],
      )
    )[0]!.id;
    expect(
      (await service.start(other, 'next', { ...input, vehicleId: Number(ownVehicle) })).outcome,
    ).toBe('accepted');
    expect(
      (await q('SELECT reserved_vnd FROM driver_charge_intents WHERE session_id=$1', [sid]))[0]!
        .reserved_vnd,
    ).toBe('50000');
  });

  async function operator() {
    const id = Number(
      (
        await q(
          `INSERT INTO users(email,full_name,role) VALUES('op@t72.test','Operator','operator_staff') RETURNING id`,
        )
      )[0]!.id,
    );
    await q(
      `INSERT INTO operator_staff(user_id,operator_id,staff_role) SELECT $1,operator_id,'manager' FROM sites LIMIT 1`,
      [id],
    );
    return id;
  }
  async function status(value: string) {
    await client.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: value,
    });
  }
  async function lateFrame(savedTag: string, stamp = new Date().toISOString()) {
    startTimestamp = stamp;
    transaction = (
      (await client.call('StartTransaction', {
        connectorId: 1,
        idTag: savedTag,
        meterStart: 1000,
        timestamp: stamp,
      })) as { transactionId: number }
    ).transactionId;
    return transaction;
  }

  it('T72 uncertain start needs accepted fencing and observed unavailable before release/restore', async () => {
    const op = await operator();
    startResponse = 'silence';
    const intent = await service.start(driver, 'uncertain', input);
    expect(intent.outcome).toBe('unknown');
    await expect(
      service.beginStartRecovery(admin, intent.intentId, 'verify'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await service.beginStartRecovery(op, intent.intentId, 'Checked site, disable before releasing');
    await expect(service.completeStartRecovery(op, intent.intentId)).rejects.toMatchObject({
      code: 'recovery_evidence_incomplete',
    });
    await status('Unavailable');
    await service.completeStartRecovery(op, intent.intentId);
    expect((await service.getStart(driver, 'uncertain')).outcome).toBe('released');
    expect(
      (await q('SELECT reserved_vnd FROM driver_charge_intents WHERE id=$1', [intent.intentId]))[0]!
        .reserved_vnd,
    ).toBe('0');
    await service.restoreRecoveredConnector(op, intent.intentId);
    await expect(service.start(driver, 'fresh', input)).rejects.toMatchObject({
      code: 'connector_unavailable',
    });
    await status('Available');
    startResponse = 'Accepted';
    expect((await service.start(driver, 'fresh', input)).outcome).toBe('accepted');
    expect(startCount).toBe(2);
  });

  it.each(['Rejected', 'silence', 'Scheduled'] as const)(
    'T72 retries unsuccessful fence %s and restore without resending start',
    async (response) => {
      const op = await operator();
      startResponse = 'silence';
      const intent = await service.start(driver, 'unknown', input);
      availabilityResponse = response;
      const initial = await service.beginStartRecovery(op, intent.intentId, 'site checked');
      expect(initial.fence_status).toBe(
        response === 'Rejected' ? 'rejected' : response === 'Scheduled' ? 'scheduled' : 'timeout',
      );
      await expect(service.completeStartRecovery(op, intent.intentId)).rejects.toMatchObject({
        code: 'recovery_evidence_incomplete',
      });
      availabilityResponse = 'Accepted';
      await service.retryStartRecovery(
        op,
        intent.intentId,
        'fence',
        'repeat idempotent fence after unknown/rejection',
      );
      await status('Unavailable');
      await service.completeStartRecovery(op, intent.intentId);
      availabilityResponse = 'Rejected';
      expect((await service.restoreRecoveredConnector(op, intent.intentId)).restore_status).toBe(
        'rejected',
      );
      availabilityResponse = 'Accepted';
      expect(
        (await service.retryStartRecovery(op, intent.intentId, 'restore', 'restore retry'))
          .restore_status,
      ).toBe('accepted');
      expect(startCount).toBe(1);
      expect(
        await q(
          "SELECT 1 FROM driver_charge_intent_events WHERE event IN ('retry_fence','retry_restore')",
        ),
      ).toHaveLength(2);
    },
  );

  it('T72 Scheduled fence completes only after observed status arrives', async () => {
    const op = await operator();
    await service.start(driver, 'accepted', input);
    const intent = await service.getStart(driver, 'accepted');
    availabilityResponse = 'Scheduled';
    await service.beginStartRecovery(op, intent.intentId, 'waiting for unplug');
    await status('Unavailable');
    expect((await service.completeStartRecovery(op, intent.intentId)).released_at).toBeInstanceOf(
      Date,
    );
  });

  it('T72 reconnect requires fencing in the new epoch and supports service reconstruction', async () => {
    const op = await operator();
    const intent = await service.start(driver, 'accepted', input);
    await service.beginStartRecovery(op, intent.intentId, 'before disconnect');
    await client.close({ force: true });
    await until(async () => !registry.get('T31-PILLAR'));
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T31-PILLAR',
      password: pillarPassword,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    client.handle('ChangeAvailability', async () => ({ status: 'Accepted' }));
    await client.connect();
    await status('Unavailable');
    service = new DriverChargingService(db, registry, settlement, policy);
    await expect(service.completeStartRecovery(op, intent.intentId)).rejects.toMatchObject({
      code: 'recovery_evidence_incomplete',
    });
    await service.retryStartRecovery(op, intent.intentId, 'fence', 'new epoch verified');
    await status('Unavailable');
    expect((await service.completeStartRecovery(op, intent.intentId)).released_at).toBeInstanceOf(
      Date,
    );
  });

  it.each(['released', 'rejected'] as const)(
    'T72 late %s start retains attribution and requires audited billing approval',
    async (kind) => {
      const op = await operator();
      startResponse = kind === 'rejected' ? 'Rejected' : 'silence';
      const intent = await service.start(driver, 'old', input);
      const saved = tag;
      if (kind === 'released') {
        await service.beginStartRecovery(op, intent.intentId, 'site verified');
        await status('Unavailable');
        await service.completeStartRecovery(op, intent.intentId);
        await service.restoreRecoveredConnector(op, intent.intentId);
      }
      await status('Available');
      startResponse = 'Accepted';
      await service.start(driver, 'new', input);
      await lateFrame(saved);
      const sid = (await service.getStart(driver, 'old')).sessionId!;
      expect(sid).toBeGreaterThan(0);
      await sendStop();
      expect((await service.progress(driver, sid)).settlement_reason).toBe(
        'late_start_operator_review',
      );
      expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
      await service.approveLateStart(
        op,
        intent.intentId,
        'Confirmed original driver and meter evidence',
      );
      await settlement.retryPending();
      expect((await service.statement(driver, sid)).amount_vnd).toBe('50000');
      expect(
        await q(
          "SELECT 1 FROM driver_charge_intent_events WHERE event='late_start_billing_approved'",
        ),
      ).toHaveLength(1);
      await lateFrame(saved, startTimestamp);
      expect((await service.getStart(driver, 'old')).sessionId).toBe(sid);
      expect(await q('SELECT 1 FROM sessions')).toHaveLength(1);
    },
  );

  it('T72 independent energy series keeps aggregate Wh/kWh/default units and excludes phase/other measurands', async () => {
    const sid = await observedStart();
    for (const [index, value, unit, phase, measurand] of [
      [0, '1000', 'Wh', null, 'Energy.Active.Import.Register'],
      [1, '1.5', 'kWh', null, 'Energy.Active.Import.Register'],
      [2, '2000', null, null, 'Energy.Active.Import.Register'],
      [3, '99999', 'Wh', 'L1', 'Energy.Active.Import.Register'],
      [4, '99999', 'W', null, 'Energy.Active.Import.Register'],
      [5, '80', 'Percent', null, 'SoC'],
    ] as const)
      await q(
        `INSERT INTO meter_values(session_id,cp_timestamp,received_at,measurand,value,unit,phase)
      VALUES($1,now()+make_interval(secs=>$2),now(),$3,$4,$5,$6)`,
        [sid, index, measurand, value, unit, phase],
      );
    expect((await sessionsService.getEnergySeries(db, sid)).map((s) => s.wh)).toEqual([
      1000, 1500, 2000,
    ]);
  });

  it('T72 wrong pillar meter and stop cannot mutate another pillar session', async () => {
    const sid = await observedStart();
    const ctx = {
      identity: 'other-pillar',
      chargePointId: 999,
      epoch: 1,
      epochOpenedAt: new Date(),
      receivedAt: new Date(),
      cpTimestamp: null,
      messageId: 'test',
      messageLogId: 1,
      replay: { replayed: false, skewS: 0, reason: null },
    };
    await expect(
      sessionsService.onMeterValues(
        { connectorId: 1, transactionId: transaction, meterValue: [] },
        ctx,
      ),
    ).rejects.toThrow('session_pillar_mismatch');
    await expect(
      sessionsService.onStopTransaction(
        { transactionId: transaction, meterStop: 11000, timestamp: new Date().toISOString() },
        ctx,
      ),
    ).rejects.toThrow('session_pillar_mismatch');
    expect((await service.progress(driver, sid)).status).toBe('active');
    expect(await q('SELECT 1 FROM charge_settlement_jobs')).toHaveLength(0);
  });

  it.each([0, 1])(
    'T72 zero energy/zero-price posts one zero debit and zero points (%s)',
    async (freePrice) => {
      if (freePrice) await q('UPDATE tariff_periods SET price_per_kwh_vnd=0');
      const sid = await observedStart();
      if (!freePrice) meterStop = 1000;
      await sendStop();
      expect((await service.statement(driver, sid)).amount_vnd).toBe('0');
      expect((await service.statement(driver, sid)).earned_points).toBe('0');
    },
  );

  async function pricingFixture(from: Date, to: Date, energyWh: number) {
    const sid = await observedStart();
    meterStop = 500;
    await sendStop();
    // WP3/T72: explicit synthetic billing fixture, not measured production timestamps or outcomes.
    await q(
      `UPDATE sessions SET received_started_at=$2,received_stopped_at=$3,meter_stop_wh=$4,
      energy_wh=$5,status='reconciled' WHERE id=$1`,
      [sid, from, to, 1000 + energyWh, energyWh],
    );
    return sid;
  }
  function utcTime(hour: number, minute: number) {
    const date = new Date();
    date.setUTCHours(hour, minute, 0, 0);
    return date;
  }
  async function twoBands(overlap = false, gap = false) {
    await q('DELETE FROM tariff_periods');
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      SELECT operator_id,'normal','00:00',$1::time,1,current_date-2 FROM sites LIMIT 1`,
      [overlap ? '12:01' : gap ? '11:59' : '12:00'],
    );
    await q(`INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      SELECT operator_id,'normal','12:00','24:00',1,current_date-2 FROM sites LIMIT 1`);
  }
  it('T72 two 0.4 VND portions sum to 1 VND, not two independently rounded zeroes', async () => {
    await twoBands();
    const sid = await pricingFixture(utcTime(4, 59), utcTime(5, 1), 800);
    const op = await operator();
    await expect(
      settlement.recordTariffBoundary(admin, sid, utcTime(5, 0), 1400, 'wrong role'),
    ).rejects.toThrow('not_found');
    expect(await settlement.settle(sid)).toBe('pending');
    await settlement.recordTariffBoundary(
      op,
      sid,
      utcTime(5, 0),
      1400,
      'Synthetic verified boundary meter',
    );
    await expect(
      settlement.recordTariffBoundary(op, sid, utcTime(5, 0), 1500, 'conflict'),
    ).rejects.toThrow('boundary_evidence_conflict');
    expect(await settlement.retryPending()).toBe(1);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('1');
    expect(
      (
        await q(
          'SELECT sum(exact_amount_milli_vnd) AS exact,sum(amount_vnd) AS rounded FROM session_tariff_segments',
        )
      )[0],
    ).toEqual({ exact: '800', rounded: '1' });
  });
  it('T72 same daily tariff survives midnight as two distinct segments', async () => {
    await q('UPDATE tariff_periods SET price_per_kwh_vnd=1');
    const sid = await pricingFixture(utcTime(16, 59), utcTime(17, 1), 800);
    await q(
      `INSERT INTO meter_values(session_id,cp_timestamp,received_at,measurand,value,unit)
      VALUES($1,$2,$2,'Energy.Active.Import.Register',1400,'Wh')`,
      [sid, utcTime(17, 0)],
    );
    expect(await settlement.settle(sid)).toBe('posted');
    expect(
      await q('SELECT 1 FROM session_tariff_segments WHERE session_id=$1', [sid]),
    ).toHaveLength(2);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('1');
  });
  it.each(['suspended', 'closed'] as const)(
    'T72 inactive operator %s cannot submit tariff boundary evidence',
    async (state) => {
      await twoBands();
      const sid = await pricingFixture(utcTime(4, 59), utcTime(5, 1), 800);
      const op = await operator();
      await q('UPDATE operators SET status=$1', [state]);
      await expect(
        settlement.recordTariffBoundary(op, sid, utcTime(5, 0), 1400, 'blocked operator'),
      ).rejects.toThrow('not_found');
      expect(await q('SELECT 1 FROM charge_tariff_boundary_evidence')).toHaveLength(0);
      expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
      expect(
        (await q('SELECT state FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0]!.state,
      ).toBe('pending');
      await q("UPDATE operators SET status='active'");
      await settlement.recordTariffBoundary(
        op,
        sid,
        utcTime(5, 0),
        1400,
        'verified after activation',
      );
      await settlement.retryPending();
      expect((await service.statement(driver, sid)).amount_vnd).toBe('1');
    },
  );
  it.each(['gap', 'overlap'] as const)(
    'T72 tariff %s stays observable pending without a guessed charge',
    async (kind) => {
      await twoBands(kind === 'overlap', kind === 'gap');
      const sid = await pricingFixture(utcTime(4, 58), utcTime(5, 2), 800);
      expect(await settlement.settle(sid)).toBe('pending');
      expect((await service.progress(driver, sid)).settlement_reason).toBe(
        'tariff_coverage_or_boundary_meter_required',
      );
      expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
      // WP3/T72: correcting the synthetic tariff configuration permits the original durable job to resume.
      await q("UPDATE tariff_periods SET time_end='12:00' WHERE time_start='00:00'");
      const op = await operator();
      await settlement.recordTariffBoundary(
        op,
        sid,
        utcTime(5, 0),
        1400,
        'Verified boundary after tariff correction',
      );
      await settlement.retryPending();
      expect((await service.statement(driver, sid)).amount_vnd).toBe('1');
    },
  );

  async function extraSite(
    code: string,
    name: string,
    lat: number | null = null,
    lon: number | null = null,
  ) {
    const st = (
      await q(
        `INSERT INTO sites(site_code,site_name,operator_id,address,latitude,longitude)
      SELECT $1,$2,operator_id,'Đường Nguyễn Văn Linh',$3,$4 FROM sites ORDER BY id LIMIT 1 RETURNING id`,
        [code, name, lat, lon],
      )
    )[0]!.id;
    const cp = (
      await q(
        `INSERT INTO charge_points(site_id,serial_number,display_code,lifecycle,is_online,last_message_at)
      VALUES($1,$2,$2,'in_service',true,now()) RETURNING id`,
        [st, code],
      )
    )[0]!.id;
    await q(
      `INSERT INTO connectors(charge_point_id,connector_no,status,status_changed_at) VALUES($1,1,'Available',now())`,
      [cp],
    );
    return String(st);
  }
  it('T72 search groups two compatible guns in one station with status metadata', async () => {
    await q(
      `INSERT INTO connectors(charge_point_id,connector_no,status,status_changed_at)
      SELECT charge_point_id,2,'Charging',now() FROM connectors WHERE id=$1`,
      [connector],
    );
    const result = await service.findStations(driver, vehicle);
    expect(result.total).toBe(1);
    expect(result.items[0]!.connectors).toHaveLength(2);
    expect(result.items[0]!.connectors[0]).toMatchObject({
      status: 'Available',
      driver_status: 'available',
      available_now: true,
      status_quality: 'fresh',
    });
    expect(result.items[0]!.connectors[1]).toMatchObject({
      driver_status: 'in_use',
      available_now: false,
    });
    expect(result.items[0]!.distance_m).toBeNull();
  });
  it.each([
    'Đà Nẵng',
    'da nang',
    'ĐÀ NẴNG',
    'da nang'.normalize('NFD'),
    'nguyen van linh',
    'pm-d1-hcm-0031',
    'T31',
  ])('T72 search Vietnamese station/code/address literal %s', async (query) => {
    await q("UPDATE sites SET site_name='Trạm Đà Nẵng',address='Đường Nguyễn Văn Linh'");
    expect((await service.findStations(driver, vehicle, { query })).total).toBe(1);
  });
  it('T72 search treats SQL and wildcard characters as literal input', async () => {
    for (const query of ['%', "' OR 1=1 --", '_'])
      expect((await service.findStations(driver, vehicle, { query })).total).toBe(0);
  });
  it('T72 search protects vehicle ownership and Driver role', async () => {
    await expect(service.findStations(other, vehicle)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.findStations(admin, vehicle)).rejects.toMatchObject({ code: 'forbidden' });
    await q("UPDATE vehicle_models SET connector_type='chademo'");
    expect((await service.findStations(driver, vehicle)).total).toBe(0);
  });
  it('T72 search keeps stale/offline/unknown distinct and never promises stale Available', async () => {
    await q("UPDATE charge_points SET last_message_at=now()-interval '11 minutes'");
    let result = await service.findStations(driver, vehicle);
    expect(result.items[0]!.connectors[0]).toMatchObject({
      status: 'Available',
      driver_status: 'unknown',
      status_quality: 'stale',
      is_online: true,
      available_now: false,
    });
    expect((await service.findStations(driver, vehicle, { availability: 'available' })).total).toBe(
      0,
    );
    await q("UPDATE charge_points SET last_message_at=now()-interval '16 minutes'");
    expect((await service.findStations(driver, vehicle, { availability: 'offline' })).total).toBe(
      1,
    );
    await q(
      'UPDATE charge_points SET last_message_at=now(); UPDATE connectors SET status_changed_at=NULL',
    );
    result = await service.findStations(driver, vehicle);
    expect(result.items[0]!.connectors[0]).toMatchObject({
      status_quality: 'unknown',
      available_now: false,
    });
  });
  it.each([
    ['Charging', 'in_use'],
    ['Finishing', 'freeing_soon'],
    ['Faulted', 'unavailable'],
    ['Reserved', 'unavailable'],
  ] as const)('T72 search availability maps %s to %s', async (raw, mapped) => {
    await status(raw);
    expect((await service.findStations(driver, vehicle, { availability: mapped })).total).toBe(1);
    expect((await service.findStations(driver, vehicle, { availability: 'available' })).total).toBe(
      0,
    );
  });
  it('T72 search excludes administrative disable and inactive operators independently of connectivity', async () => {
    await q("UPDATE operators SET status='suspended'");
    expect((await service.findStations(driver, vehicle)).total).toBe(0);
    await expect(
      service.resolveConnector(driver, vehicle, 'PM-D1-HCM-0031', 1),
    ).rejects.toMatchObject({ code: 'not_found' });
    await q("UPDATE operators SET status='active'; UPDATE charge_points SET lifecycle='disabled'");
    expect((await service.findStations(driver, vehicle)).total).toBe(0);
  });
  it('T72 search BR-P03 hides VinFast-only unless owned vehicle is VinFast or explicit override', async () => {
    await q('UPDATE sites SET vinfast_only=true');
    expect((await service.findStations(driver, vehicle)).total).toBe(0);
    expect(
      (await service.findStations(driver, vehicle, { includeVinfastOnly: true })).items[0]!
        .vinfast_only,
    ).toBe(true);
    await q('UPDATE vehicle_models SET is_vinfast=true');
    expect((await service.findStations(driver, vehicle)).total).toBe(1);
  });
  it('T72 search calculates optional straight-line distance and radius, with unknown coordinates last', async () => {
    const near = await extraSite('NEAR', 'Near', 10, 106);
    await extraSite('FAR', 'Far', 11, 107);
    const result = await service.findStations(driver, vehicle, {
      latitude: 10,
      longitude: 106,
      sort: 'distance',
    });
    expect(result.items[0]).toMatchObject({ site_id: near, distance_m: 0 });
    expect(result.items[1]!.distance_m).toBeGreaterThan(100000);
    expect(result.items[2]!.distance_m).toBeNull();
    expect(
      (await service.findStations(driver, vehicle, { latitude: 10, longitude: 106, radiusKm: 1 }))
        .total,
    ).toBe(1);
  });
  it('T72 search stable pages retain total and QR lookup does not depend on page membership', async () => {
    await q("UPDATE sites SET site_name='Same'");
    await extraSite('TIE1', 'Same');
    await extraSite('TIE2', 'Same');
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      const r = await service.findStations(driver, vehicle, { page, pageSize: 1 });
      expect(r.total).toBe(3);
      pages.push(r.items[0]!.site_id);
    }
    expect(new Set(pages).size).toBe(3);
    expect(pages).toEqual([...pages].sort((a, b) => Number(a) - Number(b)));
    expect(await service.findStations(driver, vehicle, { page: 4, pageSize: 1 })).toMatchObject({
      items: [],
      total: 3,
    });
    expect(
      (await service.resolveConnector(driver, vehicle, 'PM-D1-HCM-0031', 1)).connector_id,
    ).toBe(String(connector));
  });
  it('T72 search start intent blocks available filter; stopped billing still needs a new status observation', async () => {
    const sid = await observedStart();
    expect((await service.findStations(driver, vehicle, { availability: 'available' })).total).toBe(
      0,
    );
    meterStop = 500;
    await sendStop();
    expect((await service.findStations(driver, vehicle, { availability: 'available' })).total).toBe(
      0,
    );
    await expect(service.start(driver, 'premature', input)).rejects.toMatchObject({
      code: 'connector_busy_or_unknown',
    });
    await status('Available');
    expect((await service.findStations(driver, vehicle, { availability: 'available' })).total).toBe(
      1,
    );
    expect((await service.progress(driver, sid)).settlement_state).toBe('pending');
  });
  it.each([
    { page: 0 },
    { pageSize: 101 },
    { latitude: 91, longitude: 1 },
    { latitude: 1 },
    { sort: 'distance' },
    { radiusKm: 1 },
    { query: 'x'.repeat(121) },
    { availability: 'invented' },
    { includeVinfastOnly: 'yes' },
  ])('T72 search rejects malformed input %j', async (input) => {
    await expect(service.findStations(driver, vehicle, input as never)).rejects.toMatchObject({
      code: 'invalid_search',
    });
  });

  it.each(['last_message_at', 'status_changed_at'] as const)(
    'T72 search never treats future %s as fresh',
    async (field) => {
      if (field === 'last_message_at')
        await q("UPDATE charge_points SET last_message_at=now()+interval '1 hour'");
      else await q("UPDATE connectors SET status_changed_at=now()+interval '1 hour'");
      const result = await service.findStations(driver, vehicle);
      expect(result.items[0]!.connectors[0]).toMatchObject({
        driver_status: 'unknown',
        status_quality: 'stale',
        available_now: false,
      });
    },
  );
  it('T72 independent natural replay can race settlement without rebinding or double charging', async () => {
    const sid = await observedStart();
    await sendStop();
    const conn = registry.get('T31-PILLAR')!;
    const message = (
      await q(
        "SELECT id FROM ocpp_message_log WHERE action='StartTransaction' ORDER BY id DESC LIMIT 1",
      )
    )[0]!;
    const ctx = {
      identity: conn.identity,
      chargePointId: conn.chargePointId,
      epoch: conn.epoch,
      epochOpenedAt: conn.epochOpenedAt,
      receivedAt: new Date(),
      cpTimestamp: new Date(startTimestamp),
      messageId: 'replay-test',
      messageLogId: Number(message.id),
      replay: { replayed: false, skewS: 0, reason: null },
    };
    const req = { connectorId: 1, idTag: tag, meterStart: 1000, timestamp: startTimestamp };
    const [replay] = await Promise.all([
      sessionsService.onStartTransaction(req, ctx),
      settlement.settle(sid),
    ]);
    expect(replay).toEqual({ transactionId: transaction, duplicate: true });
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(1);
    expect(
      await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
    ).toHaveLength(1);
  });

  it('DS02 insufficient credit creates no session, command or debit and requests topup', async () => {
    await q('UPDATE credit_accounts SET balance_vnd=30000 WHERE driver_id=$1', [driver]);
    const result = await service.start(driver, 'poor', input);
    expect(result).toMatchObject({
      outcome: 'topuprequired',
      sessionId: null,
      commandId: null,
      effectConfirmed: false,
    });
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
    expect(await q('SELECT 1 FROM remote_commands')).toHaveLength(0);
    expect(
      await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
    ).toHaveLength(0);
    expect(startCount).toBe(0);
  });
  it('Accepted is not evidence of an active session', async () => {
    expect(await service.start(driver, 'accepted', input)).toMatchObject({
      outcome: 'accepted',
      sessionId: null,
      effectConfirmed: false,
    });
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
  });
  it('concurrent retries with the same principal/key dispatch exactly once', async () => {
    const results = await Promise.all([
      service.start(driver, 'same', input),
      service.start(driver, 'same', input),
    ]);
    expect(results[0]!.intentId).toBe(results[1]!.intentId);
    expect(startCount).toBe(1);
  });
  it('same key with a different payload is rejected', async () => {
    await service.start(driver, 'key', input);
    await expect(service.start(driver, 'key', { ...input, energyLimitWh: 5000 })).rejects.toThrow(
      'idempotency_conflict',
    );
    expect(startCount).toBe(1);
  });
  it('another start key cannot bypass an unresolved connector intent', async () => {
    await service.start(driver, 'first', input);
    await expect(service.start(driver, 'second', input)).rejects.toThrow(
      'connector_busy_or_unknown',
    );
    expect(startCount).toBe(1);
  });
  it('transport timeout stays unknown; restart recovers the same durable intent', async () => {
    startResponse = 'silence';
    expect((await service.start(driver, 'unknown', input)).outcome).toBe('unknown');
    const snapshot = await service.getStart(driver, 'unknown');
    const restarted = new DriverChargingService(db, new ConnectionRegistry(db), settlement, policy);
    expect((await restarted.start(driver, 'unknown', input)).intentId).toBe(snapshot.intentId);
    expect(startCount).toBe(1);
  });
  it('a rejected start has no session, debit or retained credit reservation', async () => {
    startResponse = 'Rejected';
    expect((await service.start(driver, 'reject', input)).outcome).toBe('rejected');
    expect((await q('SELECT reserved_vnd FROM driver_charge_intents'))[0]!.reserved_vnd).toBe('0');
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(0);
  });
  it('admin and other-driver vehicle cannot start', async () => {
    await expect(service.start(admin, 'admin', input)).rejects.toThrow('forbidden');
    await expect(service.start(other, 'other', input)).rejects.toThrow(
      'vehicle_not_owned_or_incompatible',
    );
    expect(startCount).toBe(0);
  });
  it('another driver cannot read progress/intent/statement or stop a session', async () => {
    const sid = await observedStart();
    await expect(service.progress(other, sid)).rejects.toThrow('not_found');
    await expect(service.getStart(other, 'start')).rejects.toThrow('not_found');
    await expect(service.statement(other, sid)).rejects.toThrow('not_found');
    await expect(service.stop(other, 'steal', sid)).rejects.toThrow('not_found');
    expect(stopCount).toBe(0);
  });
  it('T72 review start rejects pre-reconnect Available until fresh current-epoch status', async () => {
    await client.close({ force: true });
    await until(async () => !registry.get('T31-PILLAR'));
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T31-PILLAR',
      password: pillarPassword,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    client.handle('RemoteStartTransaction', async () => {
      startCount++;
      return { status: 'Accepted' };
    });
    await client.connect();
    await client.call('Heartbeat', {});
    await expect(service.start(driver, 'old-available', input)).rejects.toThrow(
      'connector_unavailable',
    );
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    await status('Available');
    expect(await service.start(driver, 'fresh-available', input)).toMatchObject({
      outcome: 'accepted',
      effectConfirmed: false,
    });
    expect(startCount).toBe(1);
  });
  it.each([
    'unknown_status',
    'future_status',
    'future_last_seen',
    'replayed_status',
    'future_pillar_timestamp',
  ] as const)('T72 review start rejects %s without command or held credit', async (kind) => {
    if (kind === 'unknown_status') await q('UPDATE connectors SET status_changed_at=NULL');
    if (kind === 'future_status')
      await q("UPDATE connectors SET status_changed_at=now()+interval '1 hour'");
    if (kind === 'future_last_seen')
      await q("UPDATE charge_points SET last_message_at=now()+interval '1 hour'");
    if (kind === 'replayed_status' || kind === 'future_pillar_timestamp')
      await client.call('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: new Date(
          Date.now() + (kind === 'replayed_status' ? -60000 : 60000),
        ).toISOString(),
      });
    await expect(service.start(driver, 'invalid-status', input)).rejects.toThrow(
      'connector_unavailable',
    );
    expect(startCount).toBe(0);
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    expect(
      await q("SELECT 1 FROM remote_commands WHERE action='RemoteStartTransaction'"),
    ).toHaveLength(0);
  });
  it('stale and faulted connectors reject start', async () => {
    await q("UPDATE charge_points SET last_message_at=now()-interval '1 hour'");
    await expect(service.start(driver, 'stale', input)).rejects.toThrow('connector_unavailable');
    await q('UPDATE charge_points SET last_message_at=now()');
    await q("UPDATE connectors SET status='Faulted'");
    await expect(service.start(driver, 'fault', input)).rejects.toThrow('connector_unavailable');
    expect(startCount).toBe(0);
  });
  it('WP3/T31 lists an offline in-service pillar but rejects start without creating an intent', async () => {
    await client.close({ force: true });
    await until(
      async () => (await q('SELECT 1 FROM charge_points WHERE NOT is_online')).length === 1,
    );
    expect((await service.findStations(driver, vehicle)).items[0]!.connectors).toEqual([
      expect.objectContaining({
        lifecycle: 'in_service',
        is_online: false,
        driver_status: 'offline',
      }),
    ]);
    await expect(service.start(driver, 'offline', input)).rejects.toThrow('connector_unavailable');
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    expect(await q('SELECT 1 FROM remote_commands')).toHaveLength(0);
    expect(startCount).toBe(0);
  });
  it('WP3/T31 hides a disabled pillar even with an online socket and rejects start', async () => {
    await q("UPDATE charge_points SET lifecycle='disabled'");
    expect((await q('SELECT is_online FROM charge_points'))[0]!.is_online).toBe(true);
    expect((await service.findStations(driver, vehicle)).items).toHaveLength(0);
    await expect(service.resolveConnector(driver, vehicle, 'PM-D1-HCM-0031', 1)).rejects.toThrow(
      'not_found',
    );
    await expect(service.start(driver, 'disabled', input)).rejects.toThrow('connector_unavailable');
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    expect(startCount).toBe(0);
  });
  it('WP3/T31 progress separates socket loss from the active session during offline grace', async () => {
    const sid = await observedStart();
    await meter('6000');
    await client.close({ force: true });
    await until(
      async () => (await q('SELECT 1 FROM charge_points WHERE NOT is_online')).length === 1,
    );
    expect(await service.progress(driver, sid)).toMatchObject({
      status: 'active',
      lifecycle: 'in_service',
      is_online: false,
      online_changed_at: expect.any(Date),
      consumed_wh: '5000',
    });
    expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
    expect(
      await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
    ).toHaveLength(0);
  });
  it('manual Stop is idempotent and bills actual energy, not the requested limit', async () => {
    const sid = await observedStart();
    meterStop = 5000;
    await meter('5000');
    await service.stop(driver, 'manual', sid);
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    await service.stop(driver, 'manual', sid);
    expect(await service.statement(driver, sid)).toMatchObject({
      energy_wh: '4000',
      amount_vnd: '20000',
      earned_points: '20',
    });
    expect(stopCount).toBe(1);
  });
  it('normalizes kWh meter evidence for limit and reconciliation', async () => {
    const sid = await observedStart();
    await meter('11', 'kWh');
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect((await service.statement(driver, sid)).energy_wh).toBe('10000');
    expect(stopCount).toBe(1);
  });
  it('credit cutoff triggers a real stop before an oversized remaining limit', async () => {
    input = { ...input, energyLimitWh: 30000 };
    const sid = await observedStart();
    await q('UPDATE credit_accounts SET balance_vnd=40000 WHERE driver_id=$1', [driver]);
    meterStop = 7000;
    await meter('7000');
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(stopCount).toBe(1);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('30000');
  });
  it('rejected Stop follows STM-1 and permits a later explicit retry', async () => {
    const sid = await observedStart();
    stopResponse = 'Rejected';
    expect(await service.stop(driver, 'stop', sid)).toMatchObject({
      command_status: 'rejected',
      session_status: 'active',
    });
    expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
    stopResponse = 'Accepted';
    meterStop = 5000;
    await meter('5000');
    await service.stop(driver, 'retry', sid);
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(await service.statement(driver, sid)).toMatchObject({
      energy_wh: '4000',
      amount_vnd: '20000',
      earned_points: '20',
    });
    expect(stopCount).toBe(2);
  });
  it('T72 review auto-stop retries confirmed rejection with persisted backoff and one parallel attempt', async () => {
    const sid = await observedStart();
    stopResponse = 'Rejected';
    await meter('11000');
    await until(
      async () =>
        (await q("SELECT 1 FROM driver_stop_intents WHERE state='rejected'")).length === 1,
    );
    await Promise.all([service.onMeter(transaction), service.onMeter(transaction)]);
    expect(stopCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    stopResponse = 'Accepted';
    await meter('11000');
    await Promise.all([service.onMeter(transaction), service.onMeter(transaction)]);
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(stopCount).toBe(2);
    expect(await q('SELECT 1 FROM driver_stop_intents')).toHaveLength(1);
    expect(
      (await q('SELECT kind FROM driver_stop_attempts ORDER BY attempt_no')).map((r) => r.kind),
    ).toEqual(['initial', 'auto_retry']);
    expect((await service.statement(driver, sid)).amount_vnd).toBe('50000');
  });
  it('unknown Stop blocks fresh-key retries and never claims a completed effect', async () => {
    const sid = await observedStart();
    stopResponse = 'silence';
    expect(await service.stop(driver, 'stop', sid)).toMatchObject({
      command_status: 'timeout',
      session_status: 'stopping',
      effect_confirmed: false,
    });
    await expect(service.stop(driver, 'again', sid)).rejects.toThrow('session_not_stoppable');
    expect(stopCount).toBe(1);
    expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
  });
  it.each(['energy', 'credit'] as const)(
    'T72 review suspended driver still receives system %s cutoff but cannot call public actions',
    async (kind) => {
      const sid = await observedStart();
      await q("UPDATE users SET account_status='suspended' WHERE id=$1", [driver]);
      await expect(service.stop(driver, 'forged-system', sid)).rejects.toThrow('forbidden');
      await expect(service.start(driver, 'suspended-start', input)).rejects.toThrow('forbidden');
      await expect(service.progress(driver, sid)).rejects.toThrow('forbidden');
      if (kind === 'credit') {
        await q('UPDATE credit_accounts SET balance_vnd=40000 WHERE driver_id=$1', [driver]);
        meterStop = 7000;
      }
      await meter(String(meterStop));
      await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
      expect(stopCount).toBe(1);
      expect(
        (
          await q("SELECT requested_by FROM remote_commands WHERE action='RemoteStopTransaction'")
        )[0]!.requested_by,
      ).toBeNull();
      expect(
        (await q("SELECT actor FROM session_status_history WHERE event='STOP_REQUESTED'"))[0]!
          .actor,
      ).toBe('system');
    },
  );
  it.each(['station_wallet', 'unattributed'] as const)(
    'T72 review system cutoff refuses %s attribution',
    async (mode) => {
      await observedStart();
      await q('UPDATE sessions SET payment_mode=$1', [mode]);
      await meter('11000');
      await service.onMeter(transaction);
      expect(stopCount).toBe(0);
      expect(await q('SELECT 1 FROM driver_stop_intents')).toHaveLength(0);
    },
  );
  it('T72 review auto-stop joins a newer manual intent and cannot compete with pending or rejected backoff', async () => {
    const sid = await observedStart();
    stopResponse = 'Rejected';
    await meter('11000');
    await until(
      async () =>
        (await q("SELECT 1 FROM driver_stop_intents WHERE state='rejected'")).length === 1,
    );
    stopResponse = 'accepted_no_effect';
    const manual = await service.stop(driver, 'manual-after-limit', sid);
    await meter('11000');
    await Promise.all([service.onMeter(transaction), service.onMeter(transaction)]);
    expect(stopCount).toBe(2);
    expect(
      (await q("SELECT command_id FROM driver_stop_intents WHERE state='accepted'"))[0]!.command_id,
    ).toBe(manual.command_id);
    meterStop = 11000;
    await sendStop();
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(stopCount).toBe(2);
  });
  it('T72 review auto cutoff retries the latest confirmed rejected manual intent after its own backoff', async () => {
    const sid = await observedStart();
    stopResponse = 'Rejected';
    await service.stop(driver, 'manual', sid);
    await meter('11000');
    await service.onMeter(transaction);
    expect(stopCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    stopResponse = 'Accepted';
    await meter('11000');
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(stopCount).toBe(2);
    expect(await q('SELECT 1 FROM driver_stop_intents')).toHaveLength(1);
    expect((await q('SELECT idempotency_key FROM driver_stop_intents'))[0]!.idempotency_key).toBe(
      'manual',
    );
  });
  async function recoveryEvidence() {
    await status('Charging');
    await new Promise((resolve) => setTimeout(resolve, 180));
    await meter('5000');
  }
  it.each(['silence', 'accepted_no_effect'] as const)(
    'T72 review recovers %s stop with live evidence, durable intent and duplicate audit',
    async (response) => {
      const sid = await observedStart();
      const op = await operator();
      stopResponse = response;
      const initial = await service.stop(driver, 'stop', sid);
      await expect(
        service.recoverStop(op, sid, Number(initial.command_id), 'inspect'),
      ).rejects.toThrow('recovery_evidence_incomplete');
      await recoveryEvidence();
      service = new DriverChargingService(db, registry, settlement, policy);
      stopResponse = 'Accepted';
      meterStop = 5000;
      const results = await Promise.all([
        service.recoverStop(op, sid, Number(initial.command_id), 'live confirmation'),
        service.recoverStop(op, sid, Number(initial.command_id), 'duplicate request'),
      ]);
      expect(results[0]!.command_id).toBe(results[1]!.command_id);
      await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
      expect(stopCount).toBe(2);
      expect(await q('SELECT 1 FROM driver_stop_intents')).toHaveLength(1);
      expect(
        await q(
          "SELECT 1 FROM driver_stop_attempts WHERE kind='operator_recovery' AND operator_user_id=$1 AND note='live confirmation'",
          [op],
        ),
      ).toHaveLength(1);
      expect(
        await q("SELECT 1 FROM session_status_history WHERE event='REMOTE_STOP_REJECTED'"),
      ).toHaveLength(0);
      expect((await service.statement(driver, sid)).amount_vnd).toBe('20000');
    },
  );
  it('T72 review historical recovery replay and late old response do not overwrite the newer attempt', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'silence';
    const initial = await service.stop(driver, 'stop', sid);
    await recoveryEvidence();
    const second = await service.recoverStop(op, sid, Number(initial.command_id), 'second');
    await recoveryEvidence();
    stopResponse = 'accepted_no_effect';
    const third = await service.recoverStop(op, sid, Number(second.command_id), 'third');
    expect(
      (await service.recoverStop(op, sid, Number(initial.command_id), 'old replay')).command_id,
    ).toBe(second.command_id);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect((await q('SELECT command_id,state FROM driver_stop_intents'))[0]).toMatchObject({
      command_id: third.command_id,
      state: 'accepted',
    });
    expect(stopCount).toBe(3);
    expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(0);
    expect((await q('SELECT reserved_vnd FROM driver_charge_intents'))[0]!.reserved_vnd).toBe(
      '50000',
    );
    meterStop = 5000;
    await sendStop();
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(
      (await service.recoverStop(op, sid, Number(second.command_id), 'replay after effect'))
        .effect_confirmed,
    ).toBe(true);
  });
  it('T72 review delayed old Rejected persistence cannot revert a newer recovery attempt', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'Rejected';
    const internals = service as unknown as {
      recordDispatch(
        id: number,
        action: string,
        status: 'accepted' | 'rejected' | 'timeout',
        response: unknown,
      ): Promise<void>;
    };
    const persist = internals.recordDispatch.bind(service);
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(internals, 'recordDispatch').mockImplementationOnce(async (...args) => {
      reached();
      await gate;
      return persist(...args);
    });
    const original = service.stop(driver, 'stop', sid);
    try {
      await arrived;
      const old = (await q('SELECT command_id FROM driver_stop_intents'))[0]!.command_id;
      await recoveryEvidence();
      stopResponse = 'accepted_no_effect';
      const next = await service.recoverStop(
        op,
        sid,
        Number(old),
        'live during delayed persistence',
      );
      release();
      await original;
      expect((await q('SELECT command_id,state FROM driver_stop_intents'))[0]).toMatchObject({
        command_id: next.command_id,
        state: 'accepted',
      });
      expect((await q('SELECT status FROM sessions'))[0]!.status).toBe('stopping');
      expect(
        await q("SELECT 1 FROM session_status_history WHERE event='REMOTE_STOP_REJECTED'"),
      ).toHaveLength(0);
      expect((await q('SELECT status FROM remote_commands WHERE id=$1', [old]))[0]!.status).toBe(
        'rejected',
      );
    } finally {
      release();
      spy.mockRestore();
      await original;
    }
  });
  it('T72 review reconnect requires new epoch status and meter before stop recovery', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'silence';
    const initial = await service.stop(driver, 'stop', sid);
    await recoveryEvidence();
    await client.close({ force: true });
    await until(async () => !registry.get('T31-PILLAR'));
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T31-PILLAR',
      password: pillarPassword,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    client.handle('RemoteStopTransaction', async () => {
      stopCount++;
      return { status: 'Accepted' };
    });
    await client.connect();
    await client.call('Heartbeat', {});
    await until(async () => Boolean(registry.get('T31-PILLAR')));
    service = new DriverChargingService(db, registry, settlement, policy);
    await expect(
      service.recoverStop(op, sid, Number(initial.command_id), 'old epoch'),
    ).rejects.toThrow('recovery_evidence_incomplete');
    await recoveryEvidence();
    const result = await service.recoverStop(
      op,
      sid,
      Number(initial.command_id),
      'new epoch observed',
    );
    expect(result).toMatchObject({ command_status: 'accepted', effect_confirmed: false });
    expect(
      (
        await q("SELECT connection_epoch FROM driver_stop_attempts WHERE kind='operator_recovery'")
      )[0]!.connection_epoch,
    ).toBe(registry.get('T31-PILLAR')!.epoch);
    expect(stopCount).toBe(2);
  });
  it('T72 review received StopTransaction before the lost reply confirms effect without a recovery command', async () => {
    const sid = await observedStart();
    const op = await operator();
    await meter('5000');
    meterStop = 5000;
    stopResponse = 'silence';
    stopEffectBeforeReply = true;
    const result = await service.stop(driver, 'stop', sid);
    expect(result).toMatchObject({ command_status: 'timeout', effect_confirmed: true });
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    await expect(
      service.recoverStop(op, sid, Number(result.command_id), 'already observed'),
    ).rejects.toThrow('stop_effect_observed_or_not_recoverable');
    expect(stopCount).toBe(1);
  });
  it('T72 review public caller cannot occupy the automatic cutoff key namespace', async () => {
    const sid = await observedStart();
    await expect(service.stop(driver, `limit:${sid}`, sid)).rejects.toThrow(
      'reserved_idempotency_key',
    );
    await meter('11000');
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    expect(stopCount).toBe(1);
  });
  it('T72 review migration backfills a legacy unknown stop and keeps attempt evidence immutable', async () => {
    const sid = await observedStart();
    await q('DROP TABLE driver_stop_attempts');
    const command = (
      await q(
        `INSERT INTO remote_commands(charge_point_id,connector_no,action,payload,status,sent_at)
      SELECT charge_point_id,connector_no,'RemoteStopTransaction',jsonb_build_object('transactionId',transaction_no),
        'timeout',now() FROM sessions WHERE id=$1 RETURNING id`,
        [sid],
      )
    )[0]!.id;
    await q(
      `INSERT INTO driver_stop_intents(driver_id,session_id,idempotency_key,command_id,state)
      VALUES($1,$2,'legacy-stop',$3,'unknown')`,
      [driver, sid, command],
    );
    await db.$client.query(
      readFileSync(path.join(MIGRATIONS_DIR, '0007_wp3_stop_attempts.sql'), 'utf8'),
    );
    expect((await q('SELECT command_id,attempt_no,kind FROM driver_stop_attempts'))[0]).toEqual({
      command_id: command,
      attempt_no: 1,
      kind: 'initial',
    });
    await expect(q("UPDATE driver_stop_attempts SET note='rewrite'")).rejects.toThrow(
      'append-only',
    );
    await recoveryEvidence();
    stopResponse = 'accepted_no_effect';
    const result = await service.recoverStop(
      await operator(),
      sid,
      Number(command),
      'migrated unknown',
    );
    expect(result).toMatchObject({ command_status: 'accepted', effect_confirmed: false });
    expect(await q('SELECT 1 FROM driver_stop_intents')).toHaveLength(1);
  });
  it('T72 review a delivered unknown stop settles on late effect without redispatch', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'silence';
    const initial = await service.stop(driver, 'stop', sid);
    await meter('5000');
    meterStop = 5000;
    await sendStop();
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
    await expect(
      service.recoverStop(op, sid, Number(initial.command_id), 'already stopped'),
    ).rejects.toThrow('stop_effect_observed_or_not_recoverable');
    expect(stopCount).toBe(1);
    expect((await q('SELECT state FROM driver_stop_intents'))[0]!.state).toBe('effect');
  });
  it('T72 review recovery Rejected preserves unknown and stopping until real stop evidence', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'silence';
    const initial = await service.stop(driver, 'stop', sid);
    await recoveryEvidence();
    stopResponse = 'Rejected';
    const retry = await service.recoverStop(
      op,
      sid,
      Number(initial.command_id),
      'live but rejected',
    );
    expect(retry).toMatchObject({
      command_status: 'rejected',
      session_status: 'stopping',
      effect_confirmed: false,
    });
    expect((await q('SELECT state FROM driver_stop_intents'))[0]!.state).toBe('unknown');
    expect(
      await q("SELECT 1 FROM session_status_history WHERE event='REMOTE_STOP_REJECTED'"),
    ).toHaveLength(0);
    await recoveryEvidence();
    stopResponse = 'Accepted';
    meterStop = 5000;
    await service.recoverStop(op, sid, Number(retry.command_id), 'new live evidence');
    await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
  });
  it('T72 review wrong operator, admin and driver cannot recover an unknown stop', async () => {
    const sid = await observedStart();
    const op = await operator();
    stopResponse = 'silence';
    const initial = await service.stop(driver, 'stop', sid);
    await recoveryEvidence();
    for (const actor of [driver, other, admin])
      await expect(
        service.recoverStop(actor, sid, Number(initial.command_id), 'forged'),
      ).rejects.toThrow('forbidden');
    await q("INSERT INTO operators(tax_code,legal_name) VALUES('OTHER','Other')");
    await q(
      "UPDATE operator_staff SET operator_id=(SELECT id FROM operators WHERE tax_code='OTHER') WHERE user_id=$1",
      [op],
    );
    await expect(
      service.recoverStop(op, sid, Number(initial.command_id), 'wrong site'),
    ).rejects.toThrow('forbidden');
    expect(stopCount).toBe(1);
    expect(
      await q("SELECT 1 FROM driver_stop_attempts WHERE kind='operator_recovery'"),
    ).toHaveLength(0);
  });
  it.each(['replayed', 'old_epoch', 'stale', 'future'] as const)(
    'T72 review recovery refuses %s telemetry',
    async (invalid) => {
      const sid = await observedStart();
      const op = await operator();
      stopResponse = 'silence';
      const initial = await service.stop(driver, 'stop', sid);
      await recoveryEvidence();
      const mutation = {
        replayed: 'replayed=true',
        old_epoch: 'epoch=0',
        stale: "received_at=now()-interval '2 hours'",
        future: "cp_timestamp=now()+interval '1 hour'",
      }[invalid];
      await q(`UPDATE meter_values SET ${mutation}`);
      await expect(
        service.recoverStop(op, sid, Number(initial.command_id), 'invalid evidence'),
      ).rejects.toThrow('recovery_evidence_incomplete');
      expect(stopCount).toBe(1);
    },
  );
  it('StartTransaction before RemoteStart reply binds once and survives a replay', async () => {
    startBeforeReply = true;
    const started = await service.start(driver, 'early', input);
    expect(started).toMatchObject({ outcome: 'active', effectConfirmed: true });
    expect(started.sessionId).not.toBeNull();
    expect(
      (
        (await client.call('StartTransaction', {
          connectorId: 1,
          idTag: tag,
          meterStart: 1000,
          timestamp: startTimestamp,
        })) as { transactionId: number }
      ).transactionId,
    ).toBe(transaction);
    expect(await q('SELECT 1 FROM sessions')).toHaveLength(1);
    expect(
      await q("SELECT 1 FROM reconciliation_records WHERE record_type='unknown_id_tag'"),
    ).toHaveLength(0);
  });

  it.each([
    { change: 'meter', cardKind: null },
    { change: 'time', cardKind: 'online' },
    { change: 'both', cardKind: 'wallet' },
    { change: 'both', cardKind: 'free_vend' },
  ])(
    'preserves a separate unattributed start after $change changes with RFID $cardKind',
    async ({ change, cardKind }) => {
      const originalId = await observedStart();
      const originalTransaction = transaction;
      const originalTimestamp = startTimestamp;
      const originalTag = tag;
      meterStop = 5000;
      await meter('5000');
      await service.stop(driver, 'finish-original', originalId);
      await until(async () => (await q('SELECT 1 FROM charging_statements')).length === 1);
      const originalIntent = (await q('SELECT * FROM driver_charge_intents'))[0]!;
      expect(originalIntent.state).toBe('settled');
      if (cardKind) {
        await q('INSERT INTO rfid_cards(card_identifier,card_kind,driver_id) VALUES($1,$2,$3)', [
          originalTag,
          cardKind,
          other,
        ]);
      }

      const unexpectedStart = {
        connectorId: 1,
        idTag: originalTag,
        meterStart: change === 'time' ? 1000 : 6000,
        timestamp: change === 'meter' ? originalTimestamp : new Date().toISOString(),
      };
      const unexpected = (await client.call('StartTransaction', unexpectedStart)) as {
        transactionId: number;
        idTagInfo: { status: string };
      };
      expect(unexpected.idTagInfo.status).toBe('Accepted');
      expect(unexpected.transactionId).not.toBe(originalTransaction);
      const separate = (
        await q('SELECT * FROM sessions WHERE transaction_no=$1', [unexpected.transactionId])
      )[0]!;
      expect(separate).toMatchObject({
        origin: 'app_qr',
        payment_mode: 'unattributed',
        driver_id: null,
        vehicle_id: null,
        rfid_card_id: null,
        status: 'active',
      });
      const evidence = await q(
        "SELECT * FROM reconciliation_records WHERE session_id=$1 AND record_type='conflict'",
        [separate.id],
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.resolution).toContain(
        `app_intent_reused: intent_id=${originalIntent.id} bound_session_id=${originalId}`,
      );

      // WP3/T31: replay identity stays the natural key, regardless of the app tag's current classification.
      for (const [request, expectedTransaction] of [
        [
          { ...unexpectedStart, meterStart: 1000, timestamp: originalTimestamp },
          originalTransaction,
        ],
        [unexpectedStart, unexpected.transactionId],
      ] as const) {
        expect(
          ((await client.call('StartTransaction', request)) as { transactionId: number })
            .transactionId,
        ).toBe(expectedTransaction);
      }
      expect(await q('SELECT 1 FROM sessions')).toHaveLength(2);
      expect((await q('SELECT * FROM driver_charge_intents'))[0]).toEqual(originalIntent);

      transaction = unexpected.transactionId;
      meterStop = unexpectedStart.meterStart + 1000;
      await meter(String(meterStop));
      await sendStop();
      expect((await q('SELECT status FROM sessions WHERE id=$1', [separate.id]))[0]!.status).toBe(
        'reconciled',
      );
      expect(await settlement.settle(Number(separate.id))).toBe('ineligible');
      expect(await q('SELECT 1 FROM charging_statements')).toHaveLength(1);
      expect(
        await q("SELECT 1 FROM credit_transactions WHERE transaction_type='session_debit'"),
      ).toHaveLength(1);
      expect(
        await q("SELECT 1 FROM loyalty_transactions WHERE transaction_type='earn'"),
      ).toHaveLength(1);
      expect(
        (await q('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [driver]))[0]!
          .balance_vnd,
      ).toBe('180000');
      expect(
        (await q('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [other]))[0]!
          .balance_vnd,
      ).toBe('200000');
      expect(
        (await q('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [driver]))[0]!
          .points_balance,
      ).toBe('20');
      expect(await q('SELECT 1 FROM loyalty_accounts WHERE driver_id=$1', [other])).toHaveLength(0);
      expect(
        await q('SELECT 1 FROM charging_statements WHERE session_id=$1', [separate.id]),
      ).toHaveLength(0);
    },
  );
});
