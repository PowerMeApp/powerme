// WP3/T31: real Postgres and OCPP transport; seeded inputs never replace business outputs.
import { Logger } from '@nestjs/common';
import { createServer } from 'node:net';
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
import { resetAndMigrate } from './helpers/apply-migrations.js';

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
  let stopResponse: 'Accepted' | 'Rejected' | 'silence';
  let triggerCount: number;
  let startBeforeReply: boolean;
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;

  beforeAll(async () => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('T31 requires powerme_test');
    Logger.overrideLogger(['error']);
    db = createDb(url);
  });
  beforeEach(async () => {
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
    const password = randomBytes(18).toString('base64url');
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
    const registry = new ConnectionRegistry(db);
    const sessions = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
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
    startCount = 0;
    stopCount = 0;
    tag = '';
    transaction = 0;
    meterStop = 11000;
    startResponse = 'Accepted';
    stopResponse = 'Accepted';
    startBeforeReply = false;
    triggerCount = 0;
    client.handle('TriggerMessage', async () => {
      triggerCount++;
      return { status: 'Accepted' };
    });
    client.handle('RemoteStartTransaction', async ({ params }) => {
      startCount++;
      tag = (params as { idTag: string }).idTag;
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
      if (stopResponse === 'silence') await new Promise((resolve) => setTimeout(resolve, 300));
      if (stopResponse === 'Accepted')
        setImmediate(() => {
          void sendStop().catch(() => undefined);
        });
      return { status: stopResponse === 'Rejected' ? 'Rejected' : 'Accepted' };
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

  it('DS01 full app service journey: find/QR/start/progress/limit/statement, debit and earn once', async () => {
    expect(await service.findStations(driver, vehicle)).toHaveLength(1);
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
    expect(await service.findStations(driver, vehicle)).toEqual([
      expect.objectContaining({ lifecycle: 'in_service', is_online: false }),
    ]);
    await expect(service.start(driver, 'offline', input)).rejects.toThrow('connector_unavailable');
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    expect(await q('SELECT 1 FROM remote_commands')).toHaveLength(0);
    expect(startCount).toBe(0);
  });
  it('WP3/T31 hides a disabled pillar even with an online socket and rejects start', async () => {
    await q("UPDATE charge_points SET lifecycle='disabled'");
    expect((await q('SELECT is_online FROM charge_points'))[0]!.is_online).toBe(true);
    expect(await service.findStations(driver, vehicle)).toHaveLength(0);
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
