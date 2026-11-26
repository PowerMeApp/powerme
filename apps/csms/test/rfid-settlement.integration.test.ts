import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
// WP3/T148: real RFID OCPP, JWT HTTP and isolated Postgres protect the shared settlement path.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { RPCClient } from 'ocpp-rpc';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { OfflineGraceService } from '../src/ocpp-gateway/offline-grace.service.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { SessionReviewService } from '../src/sessions/session-review.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { ChargePointAuthService } from '../src/stations/charge-point-auth.service.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { chargeTransaction } from '../src/sessions/charge-sql.js';
import { migrate } from './helpers/apply-migrations.js';

// Ngày biểu giá theo giờ Việt Nam như charge-settlement.service.ts — KHÔNG dùng current_date (theo
// TimeZone của session, UTC trên CI): 00:00–07:00 giờ VN, current_date+1 đã là "hôm nay" ở VN.
const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const secret = randomBytes(32);
const policy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 3000,
  stationStaleAfterMs: 600000,
};
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
  return port;
}
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('observable effect not received');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describeDb('T148 RFID settlement over OCPP and owner-scoped JWT HTTP', () => {
  let db: Db, server: ConsoleServer, ocpp: OcppServer, grace: OfflineGraceService;
  let station: RPCClient, config: CsmsConfig, settlement: ChargeSettlementService;
  let sessions: SessionsService, registry: ConnectionRegistry;
  let base: string, cp: number, op: number, driver: number, other: number, staff: number;
  let card: string, token: string, otherToken: string;
  let serial = 0;
  const password = randomBytes(18).toString('base64url');
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  const id = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0]!.id);
  async function jwt(owner: number) {
    return new SignJWT({ sub: String(owner), role: 'driver', iss: 't148', aud: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(secret);
  }
  async function call(method: string, path: string, auth = token) {
    const response = await fetch(base + '/api/driver/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + auth,
        ...(method === 'POST' ? { 'Idempotency-Key': 't148-stop-session' } : {}),
      },
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  async function connect() {
    const client = new RPCClient({
      endpoint: 'ws://127.0.0.1:' + config.ocppPort + '/ocpp',
      identity: 'T148-CP',
      password,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    client.handle('ChangeAvailability', async () => ({ status: 'Accepted' }));
    client.handle('RemoteStopTransaction', async () => ({ status: 'Accepted' }));
    await client.connect();
    await client.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'D1' });
    return client;
  }
  async function available(connectorId = 1) {
    await station.call('StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status: 'Available',
    });
  }
  async function start(connectorId = 1, tag = card) {
    await available(connectorId);
    const auth = (await station.call('Authorize', { idTag: tag })) as {
      idTagInfo: { status: string };
    };
    expect(auth.idTagInfo.status).toBe('Accepted');
    const result = (await station.call('StartTransaction', {
      connectorId,
      idTag: tag,
      meterStart: 1000,
      timestamp: new Date().toISOString(),
    })) as { transactionId: number };
    const session = await q(
      'SELECT id,driver_id,origin,payment_mode FROM sessions WHERE transaction_no=$1',
      [result.transactionId],
    );
    return { id: Number(session[0]!.id), tx: result.transactionId };
  }
  async function meter(tx: number, wh: number, connectorId = 1) {
    await station.call('MeterValues', {
      connectorId,
      transactionId: tx,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: String(wh), unit: 'Wh', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    });
  }
  async function stop(tx: number, meterStop = 2000) {
    return station.call('StopTransaction', {
      transactionId: tx,
      meterStop,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
  }
  async function effects(sid: number) {
    return (
      await q(
        `SELECT (SELECT count(*)::int FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit') AS debit,
      (SELECT count(*)::int FROM loyalty_transactions WHERE session_id=$1 AND transaction_type='earn') AS earn,
      (SELECT count(*)::int FROM charging_statements WHERE session_id=$1) AS statement`,
        [sid],
      )
    )[0];
  }
  beforeAll(async () => {
    if (
      !url ||
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw new Error('Requires a fresh isolated MB03 loopback database');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS t"))[0]!.t)
      throw new Error('Database must be empty');
    await migrate(db.$client);
    op = await id(
      "INSERT INTO operators(tax_code,legal_name) VALUES('T148','T148 Op') RETURNING id",
    );
    const site = await id(
      "INSERT INTO sites(site_code,operator_id,site_name) VALUES('T148',$1,'T148 Site') RETURNING id",
      [op],
    );
    cp = await id(
      `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,basic_auth_password_hash)
      VALUES('T148-CP','PM-T148-0001',$1,'awaiting_connection',$2) RETURNING id`,
      [site, await hashChargePointPassword(password)],
    );
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1),($1,2)', [cp]);
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      VALUES($1,'normal','00:00','24:00',5000,current_date-2)`,
      [op],
    );
    const owners = [];
    for (const name of ['owner', 'other']) {
      const owner = await id(
        "INSERT INTO users(email,full_name,role) VALUES($1::varchar(255),$2::varchar(120),'driver') RETURNING id",
        [name + '@t148.invalid', name],
      );
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t148',now())",
        [owner],
      );
      const account = await id(
        'INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,200000) RETURNING id',
        [owner],
      );
      await q(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd)
        VALUES($1,1,'adjustment',200000,200000)`,
        [account],
      );
      owners.push(owner);
    }
    [driver, other] = owners as [number, number];
    staff = await id(
      "INSERT INTO users(email,full_name,role) VALUES('staff@t148.invalid','staff','operator_staff') RETURNING id",
    );
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      staff,
      op,
    ]);
    config = {
      ...loadConfig({
        DATABASE_URL: url,
        DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
        DRIVER_API_JWT_ISSUER: 't148',
        DRIVER_API_JWT_AUDIENCE: 'driver',
      }),
      ocppPort: await freePort(),
      consolePort: 0,
      offlineGraceS: 60,
    };
    registry = new ConnectionRegistry(db);
    sessions = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
    settlement = new ChargeSettlementService(
      db,
      new CreditLedgerService(db),
      new LoyaltyService(policy),
      policy,
      config,
    );
    const charging = new DriverChargingService(db, registry, settlement, policy);
    grace = new OfflineGraceService(db, config, sessions, registry);
    ocpp = new OcppServer(
      config,
      registry,
      new OcppMessageLogger(db),
      new InboundSerializer(),
      new ReplayDetector(5),
      new OcppHandlers(sessions, config, charging),
      sessions,
      new ChargePointAuthService(db, config),
      grace,
    );
    await ocpp.start();
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      charging,
    );
    await server.start();
    base = 'http://127.0.0.1:' + server.port;
    station = await connect();
    token = await jwt(driver);
    otherToken = await jwt(other);
  });
  beforeEach(async () => {
    await q(
      "UPDATE credit_accounts SET status='active',closed_at=NULL,updated_at=now() WHERE driver_id IN ($1,$2)",
      [driver, other],
    );
    await q(
      "UPDATE tariff_periods SET price_per_kwh_vnd=5000,effective_from=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-2,updated_at=now() WHERE operator_id=$1",
      [op],
    );
    await q(
      "UPDATE charge_settlement_jobs SET next_attempt_at=now()+interval '1 day',updated_at=now() WHERE state='pending'",
    );
    await chargeTransaction(db, async (c) => {
      const accounts = (
        await c.query(
          'SELECT id,balance_vnd FROM credit_accounts WHERE driver_id IN ($1,$2) ORDER BY id FOR UPDATE',
          [driver, other],
        )
      ).rows;
      const ledger = new CreditLedgerService(db);
      for (const a of accounts)
        if (Number(a.balance_vnd) !== 200000)
          await ledger.post(c, Number(a.id), 'adjustment', 200000 - Number(a.balance_vnd));
    });
    card = 'T148-FIXTURE-' + ++serial;
    await q(
      "INSERT INTO rfid_cards(card_identifier,card_kind,status,driver_id) VALUES($1,'online','active',$2)",
      [card, driver],
    );
    await available();
  });
  afterAll(async () => {
    await station?.close({ force: true });
    await ocpp?.stop();
    await server?.stop();
    grace?.cancelAll();
    if (db) {
      await until(async () => db.$client.idleCount === db.$client.totalCount, Boolean);
      await db.$client.end();
    }
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });
  it('posts one RFID debit, earn and statement without an app intent or default vehicle', async () => {
    expect(await q('SELECT 1 FROM vehicles WHERE driver_id=$1', [driver])).toEqual([]);
    const s = await start();
    expect((await call('GET', '/sessions/' + s.id + '/progress')).body).toMatchObject({
      origin: 'rfid',
      payment_mode: 'csms_billed',
      can_stop: false,
    });
    expect((await call('POST', '/sessions/' + s.id + '/stop')).status).toBe(404);
    await meter(s.tx, 1500);
    await stop(s.tx);
    const [row] = await q('SELECT status FROM sessions WHERE id=$1', [s.id]);
    expect(row!.status).toBe('reconciled');
    expect(
      (await q('SELECT state FROM charge_settlement_jobs WHERE session_id=$1', [s.id]))[0]!.state,
    ).toBe('posted');
    expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
    const statement = await call('GET', '/sessions/' + s.id + '/statement');
    expect(statement.status).toBe(200);
    expect(statement.body).toMatchObject({ amount_vnd: 5000, earned_points: 5, energy_wh: 1000 });
    expect((await call('GET', '/sessions/' + s.id + '/statement', otherToken)).status).toBe(404);
    expect((await call('GET', '/sessions/' + s.id + '/progress', otherToken)).status).toBe(404);
    expect(await q('SELECT 1 FROM driver_charge_intents WHERE session_id=$1', [s.id])).toEqual([]);
    expect((await call('GET', '/credit')).body).toMatchObject({ balance_vnd: 195000, held_vnd: 0 });
    expect((await call('GET', '/credit/transactions')).body.items).toContainEqual(
      expect.objectContaining({ session_id: String(s.id), amount_vnd: -5000 }),
    );
    expect(
      (await call('GET', '/credit/transactions', otherToken)).body.items.some(
        (r: any) => r.session_id === String(s.id),
      ),
    ).toBe(false);
    expect((await call('GET', '/sessions')).body.items).toContainEqual(
      expect.objectContaining({
        session_id: String(s.id),
        statement_available: true,
        settlement_state: 'posted',
      }),
    );
  });
  async function job(sid: number) {
    return (await q('SELECT * FROM charge_settlement_jobs WHERE session_id=$1', [sid]))[0]!;
  }
  async function storedSession(owner: number | null = driver) {
    return id(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,driver_id,
      origin,payment_mode,status,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,
      meter_start_wh,meter_stop_wh,energy_wh)
      SELECT id,$1,1,$2,$3,'rfid','csms_billed','reconciled',now()-interval '10 seconds',
        now()-interval '10 seconds',now(),now(),1000,2000,1000 FROM connectors
      WHERE charge_point_id=$1 AND connector_no=1 RETURNING id`,
      [cp, 'T148-OLD-' + ++serial, owner],
    );
  }
  async function injectFailure(table: 'loyalty_transactions' | 'charging_statements') {
    await q(`CREATE OR REPLACE FUNCTION t148_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'T148 transient test fault' USING ERRCODE='40001'; END $$`);
    await q(
      `CREATE TRIGGER t148_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION t148_fail()`,
    );
  }
  async function removeFailure() {
    await q('DROP TRIGGER IF EXISTS t148_fail ON loyalty_transactions');
    await q('DROP TRIGGER IF EXISTS t148_fail ON charging_statements');
  }
  async function invariant() {
    expect(
      await q(`SELECT a.id FROM credit_accounts a LEFT JOIN credit_transactions t ON t.credit_account_id=a.id
      GROUP BY a.id HAVING a.balance_vnd<>coalesce(sum(t.amount_vnd),0)`),
    ).toEqual([]);
    expect(
      await q(`SELECT a.id FROM loyalty_accounts a LEFT JOIN loyalty_transactions t ON t.loyalty_account_id=a.id
      GROUP BY a.id HAVING a.points_balance<>coalesce(sum(t.points),0)`),
    ).toEqual([]);
  }
  afterEach(async () => {
    if (db) {
      await removeFailure();
      await invariant();
    }
  });

  it.each([
    ['zero energy', 1000, 5000, 0],
    ['zero tariff', 2000, 0, 0],
    ['fractional Wh samples and half-VND total', 1001, 500, 1],
  ])('posts %s exactly once', async (_label, meterStop, price, amount) => {
    await q(
      'UPDATE tariff_periods SET price_per_kwh_vnd=$2,updated_at=now() WHERE operator_id=$1',
      [op, price],
    );
    const s = await start();
    await meter(s.tx, meterStop === 1001 ? 1000.5 : meterStop);
    await stop(s.tx, meterStop);
    expect((await call('GET', '/sessions/' + s.id + '/statement')).body).toMatchObject({
      amount_vnd: amount,
      earned_points: 0,
    });
    expect(await settlement.settle(s.id)).toBe('already_posted');
    expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
  });

  it.each(['blocked', 'unlinked', 'reassigned'])(
    'keeps the captured owner when the card is %s after start',
    async (change) => {
      const s = await start();
      if (change === 'reassigned')
        await q('UPDATE rfid_cards SET driver_id=$2,updated_at=now() WHERE card_identifier=$1', [
          card,
          other,
        ]);
      else
        await q(
          'UPDATE rfid_cards SET status=$2,driver_id=NULL,updated_at=now() WHERE card_identifier=$1',
          [card, change],
        );
      await meter(s.tx, 2000);
      await stop(s.tx);
      expect((await call('GET', '/sessions/' + s.id + '/statement')).body).toMatchObject({
        driver_id: String(driver),
        amount_vnd: 5000,
      });
      expect((await call('GET', '/sessions/' + s.id + '/statement', otherToken)).status).toBe(404);
      expect((await call('GET', '/credit', otherToken)).body.balance_vnd).toBe(200000);
    },
  );

  it.each(['loyalty_transactions', 'charging_statements'] as const)(
    'rolls back after debit at %s, ACKs Stop and retries atomically',
    async (table) => {
      const s = await start();
      await meter(s.tx, 2000);
      const balance = (await call('GET', '/credit')).body.balance_vnd;
      await injectFailure(table);
      expect(await stop(s.tx)).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(await effects(s.id)).toEqual({ debit: 0, earn: 0, statement: 0 });
      expect((await call('GET', '/credit')).body.balance_vnd).toBe(balance);
      expect(await q('SELECT 1 FROM session_tariff_segments WHERE session_id=$1', [s.id])).toEqual(
        [],
      );
      expect(await job(s.id)).toMatchObject({
        state: 'pending',
        reason: 'transient_error',
        last_error_code: '40001',
      });
      expect((await call('GET', '/sessions/' + s.id + '/progress')).body).toMatchObject({
        settlement_state: 'pending',
        can_stop: false,
        statement_available: false,
      });
      expect((await call('GET', '/sessions/' + s.id + '/statement')).status).toBe(404);
      await removeFailure();
      await q(
        'UPDATE charge_settlement_jobs SET next_attempt_at=now(),updated_at=now() WHERE session_id=$1',
        [s.id],
      );
      expect(await settlement.retryPending()).toBeGreaterThanOrEqual(1);
      expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
      expect(await job(s.id)).toMatchObject({ state: 'posted', last_error_code: null });
    },
  );

  it('serializes duplicate Stop, settlement and recovery calls under the session lock', async () => {
    const s = await start();
    await meter(s.tx, 2000);
    await injectFailure('charging_statements');
    await stop(s.tx);
    await removeFailure();
    await q(
      'UPDATE charge_settlement_jobs SET next_attempt_at=now(),updated_at=now() WHERE session_id=$1',
      [s.id],
    );
    const lock = await db.$client.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [s.id]);
    const work = Promise.all([
      settlement.settle(s.id),
      settlement.settle(s.id),
      settlement.retryPending(),
      stop(s.tx),
    ]);
    try {
      await until(
        async () =>
          Number(
            (
              await q(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.n,
          ),
        (n) => n >= 2,
      );
    } finally {
      await lock.query('COMMIT');
      lock.release();
    }
    await work;
    expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
    expect(await job(s.id)).toMatchObject({ state: 'posted' });
    await settlement.settle(s.id);
    expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
  });

  it('serializes multiple RFID sessions on one account and permits deeper BR-P20 shortfall', async () => {
    const a = await start(1),
      b = await start(2);
    await meter(a.tx, 2000, 1);
    await meter(b.tx, 2000, 2);
    await injectFailure('charging_statements');
    await Promise.all([stop(a.tx), stop(b.tx)]);
    await removeFailure();
    const ledger = new CreditLedgerService(db);
    const lock = await db.$client.connect();
    await lock.query('BEGIN');
    const account = (
      await lock.query('SELECT id,balance_vnd FROM credit_accounts WHERE driver_id=$1 FOR UPDATE', [
        driver,
      ])
    ).rows[0]!;
    await ledger.post(lock, Number(account.id), 'adjustment', -Number(account.balance_vnd) - 1000);
    const work = Promise.all([settlement.settle(a.id), settlement.settle(b.id)]);
    try {
      await until(
        async () =>
          Number(
            (
              await q(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.n,
          ),
        (n) => n >= 2,
      );
    } finally {
      await lock.query('COMMIT');
      lock.release();
    }
    expect(await work).toEqual(['posted', 'posted']);
    expect(await effects(a.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
    expect(await effects(b.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
    expect((await call('GET', '/credit')).body).toMatchObject({
      balance_vnd: -11000,
      status: 'in_shortfall',
    });
  });

  it('holds a closed account with an explicit D6 reason and no debit', async () => {
    const s = await start();
    await meter(s.tx, 2000);
    await q(
      "UPDATE credit_accounts SET status='closed',closed_at=now(),updated_at=now() WHERE driver_id=$1",
      [driver],
    );
    await stop(s.tx);
    expect(await job(s.id)).toMatchObject({
      state: 'pending',
      reason: 'account_closed',
      last_error_code: null,
    });
    expect(await effects(s.id)).toEqual({ debit: 0, earn: 0, statement: 0 });
  });

  it('keeps missing accounts recoverable without inventing one during settlement', async () => {
    const owner = await id(
      "INSERT INTO users(email,full_name,role) VALUES('missing@t148.invalid','missing','driver') RETURNING id",
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t148',now())",
      [owner],
    );
    const sid = await storedSession(owner);
    expect(await settlement.settle(sid)).toBe('pending');
    expect(await job(sid)).toMatchObject({ reason: 'credit_account_missing' });
    expect(await q('SELECT 1 FROM credit_accounts WHERE driver_id=$1', [owner])).toEqual([]);
    expect(await effects(sid)).toEqual({ debit: 0, earn: 0, statement: 0 });
  });

  it.each([
    ['meter_stop_wh=NULL', 'missing_meter'],
    ['energy_wh=999', 'invalid_energy'],
    ["status='review'", 'awaiting_reconciliation'],
  ])('retains recoverable evidence: %s', async (mutation, reason) => {
    const sid = await storedSession();
    await q('UPDATE sessions SET ' + mutation + ',updated_at=now() WHERE id=$1', [sid]);
    expect(await settlement.settle(sid)).toBe('pending');
    expect(await job(sid)).toMatchObject({ state: 'pending', reason });
    expect(await effects(sid)).toEqual({ debit: 0, earn: 0, statement: 0 });
  });

  it('holds missing tariff coverage and posts after a real retry when coverage is restored', async () => {
    const s = await start();
    await meter(s.tx, 2000);
    await q(
      "UPDATE tariff_periods SET effective_from=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+1,updated_at=now() WHERE operator_id=$1",
      [op],
    );
    await stop(s.tx);
    expect(await job(s.id)).toMatchObject({
      state: 'pending',
      reason: 'tariff_coverage_or_boundary_meter_required',
    });
    await q(
      "UPDATE tariff_periods SET effective_from=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-2,updated_at=now() WHERE operator_id=$1",
      [op],
    );
    expect(await settlement.settle(s.id)).toBe('posted');
  });

  it('reconnects, keeps conflicting replay pending, then settles after operator resolution', async () => {
    const s = await start();
    await meter(s.tx, 3000);
    await station.close({ force: true });
    await until(async () => !registry.get('T148-CP'), Boolean);
    station = await connect();
    const received = (await q('SELECT received_started_at FROM sessions WHERE id=$1', [s.id]))[0]!
      .received_started_at as Date;
    expect(
      await station.call('StopTransaction', {
        transactionId: s.tx,
        meterStop: 2000,
        timestamp: received.toISOString(),
        reason: 'Local',
      }),
    ).toEqual({ idTagInfo: { status: 'Accepted' } });
    expect((await q('SELECT status FROM sessions WHERE id=$1', [s.id]))[0]!.status).toBe('review');
    expect(await job(s.id)).toMatchObject({ state: 'pending', reason: 'awaiting_reconciliation' });
    expect(await effects(s.id)).toEqual({ debit: 0, earn: 0, statement: 0 });
    expect(
      (
        await new SessionReviewService(db, settlement).resolveReview(
          s.id,
          staff,
          'meter_confirmed',
          'T148 isolated evidence checked',
        )
      ).settlement,
    ).toBe('posted');
    expect(await effects(s.id)).toEqual({ debit: 1, earn: 1, statement: 1 });
  });

  it.each(['free_vend', 'unattributed'])(
    'does not charge %s, including malformed owned free vend',
    async (kind) => {
      const sid = await storedSession();
      await q(
        kind === 'free_vend'
          ? "UPDATE sessions SET origin='free_vend',updated_at=now() WHERE id=$1"
          : "UPDATE sessions SET payment_mode='unattributed',updated_at=now() WHERE id=$1",
        [sid],
      );
      expect(await settlement.settle(sid)).toBe('ineligible');
      expect(await effects(sid)).toEqual({ debit: 0, earn: 0, statement: 0 });
    },
  );
});
