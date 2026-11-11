/**
 * BE-22 — route sạc/credit của app tài xế qua HTTP thật + OCPP thật + Postgres riêng.
 * Chạy bằng `npm run test:driver-discovery -w @powerme/csms` (runner tạo DB mới cho mỗi suite).
 *
 * Trụ giả là một RPCClient trong test (cùng cách wf01): nhận RemoteStart/RemoteStop, trả Accepted
 * rồi gửi StartTransaction/StopTransaction như trụ thật. Mọi kỳ vọng là đầu ra của CSMS.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT, type JWTPayload } from 'jose';
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
import type { ChargePolicy } from '../src/sessions/charge-start-policy.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { ChargePointAuthService } from '../src/stations/charge-point-auth.service.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const secret = randomBytes(32);
const issuer = 'powerme-be22-test';
const audience = 'powerme-driver-test';
const policy: ChargePolicy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 3000,
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

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error('observable effect not received');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describeDb('BE-22 driver charges and credit over HTTP, real OCPP and dedicated Postgres', () => {
  let db: Db;
  let server: ConsoleServer;
  let ocpp: OcppServer;
  let grace: OfflineGraceService;
  let station: RPCClient;
  let config: CsmsConfig;
  let base: string;
  let driver: string;
  let other: string;
  let poor: string;
  let walletless: string;
  let vehicle: string;
  let otherVehicle: string;
  let poorVehicle: string;
  let connector: string;
  let token: string;
  let otherToken: string;
  let startCount = 0;
  let stopCount = 0;
  let transactionId = 0;
  let meterStop = 5000;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function jwt(sub: string, overrides: JWTPayload = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }
  async function call(
    method: string,
    path: string,
    options: {
      auth?: string | null;
      key?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const auth = options.auth === undefined ? token : options.auth;
    const headers: Record<string, string> = {
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    };
    const response = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }
  const startBody = (extra: Record<string, unknown> = {}) => ({
    connector_id: connector,
    vehicle_id: vehicle,
    mode: 'energy_kwh',
    energy_limit_wh: 10000,
    ...extra,
  });
  async function meter(wh: number) {
    await station.call('MeterValues', {
      connectorId: 1,
      transactionId,
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

  beforeAll(async () => {
    if (!url) throw new Error('Missing test database');
    const parsed = new URL(url);
    if (
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(parsed.pathname)
    )
      throw new Error('Requires explicit opt-in and a new isolated MB03 loopback test database');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS table_name"))[0]?.table_name)
      throw new Error('Test database must be new and empty; never reset user data');
    await migrate(db.$client);

    const op = (
      await q("INSERT INTO operators(tax_code,legal_name) VALUES('BE22','BE22 Op') RETURNING id")
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('BE22',$1,'BE22 Site') RETURNING id",
        [op],
      )
    )[0]!.id;
    const password = randomBytes(18).toString('base64url');
    const cp = (
      await q(
        `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,basic_auth_password_hash)
         VALUES('BE22-CP','PM-BE22-0001',$1,'awaiting_connection',$2) RETURNING id`,
        [site, await hashChargePointPassword(password)],
      )
    )[0]!.id;
    connector = String(
      (
        await q(
          'INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id::text AS id',
          [cp],
        )
      )[0]!.id,
    );
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
       VALUES($1,'normal','00:00','24:00',5000,current_date-1)`,
      [op],
    );
    const model = (
      await q("INSERT INTO vehicle_models(brand,model_name) VALUES('Test','EV') RETURNING id")
    )[0]!.id;
    const ids: Record<string, string> = {};
    const vehicles: Record<string, string> = {};
    for (const [name, balance] of [
      ['driver', 200000],
      ['other', 200000],
      ['poor', 20000],
      ['walletless', null],
    ] as const) {
      const id = String(
        (
          await q(
            "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id::text AS id",
            [`${name}@be22.invalid`, name],
          )
        )[0]!.id,
      );
      ids[name] = id;
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
        [id],
      );
      vehicles[name] = String(
        (
          await q(
            'INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,$3) RETURNING id::text AS id',
            [id, model, `BE22-${name.slice(0, 5)}`],
          )
        )[0]!.id,
      );
      if (balance === null) continue;
      const account = (
        await q('INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,$2) RETURNING id', [
          id,
          balance,
        ])
      )[0]!.id;
      await q(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd)
         VALUES($1,1,'adjustment',$2,$2)`,
        [account, balance],
      );
    }
    driver = ids['driver']!;
    other = ids['other']!;
    poor = ids['poor']!;
    walletless = ids['walletless']!;
    vehicle = vehicles['driver']!;
    otherVehicle = vehicles['other']!;
    poorVehicle = vehicles['poor']!;

    config = {
      ...loadConfig({
        DATABASE_URL: url,
        DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
        DRIVER_API_JWT_ISSUER: issuer,
        DRIVER_API_JWT_AUDIENCE: audience,
      }),
      ocppPort: await freePort(),
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
    const service = new DriverChargingService(
      db,
      registry,
      new ChargeSettlementService(db, policy),
      policy,
    );
    grace = new OfflineGraceService(db, config, sessions, registry);
    ocpp = new OcppServer(
      config,
      registry,
      new OcppMessageLogger(db),
      new InboundSerializer(),
      new ReplayDetector(5),
      new OcppHandlers(sessions, config, service),
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
      service,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;

    // Trụ giả: trả Accepted rồi tự gửi StartTransaction/StopTransaction như trụ thật.
    station = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'BE22-CP',
      password,
      protocols: ['ocpp1.6'],
      strictMode: true,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    let triggers = 0;
    station.handle('TriggerMessage', async () => {
      triggers++;
      return { status: 'Accepted' };
    });
    station.handle('ChangeAvailability', async () => ({ status: 'Accepted' }));
    station.handle('RemoteStartTransaction', async ({ params }) => {
      startCount++;
      const idTag = (params as { idTag: string }).idTag;
      setImmediate(() => {
        void (async () => {
          const result = (await station.call('StartTransaction', {
            connectorId: 1,
            idTag,
            meterStart: 1000,
            timestamp: new Date().toISOString(),
          })) as { transactionId: number };
          transactionId = result.transactionId;
          await station.call('StatusNotification', {
            connectorId: 1,
            errorCode: 'NoError',
            status: 'Charging',
          });
        })().catch(() => undefined);
      });
      return { status: 'Accepted' };
    });
    station.handle('RemoteStopTransaction', async () => {
      stopCount++;
      setImmediate(() => {
        void station
          .call('StopTransaction', {
            transactionId,
            meterStop,
            timestamp: new Date().toISOString(),
            reason: 'Remote',
          })
          .catch(() => undefined);
      });
      return { status: 'Accepted' };
    });
    await station.connect();
    await station.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'D1' });
    await station.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });
    await until(
      async () => triggers,
      (n) => n >= 3,
    );
    token = await jwt(driver);
    otherToken = await jwt(other);
  });
  afterAll(async () => {
    await station?.close({ force: true });
    await ocpp?.stop();
    await server?.stop();
    grace?.cancelAll();
    await until(
      async () => db.$client.waitingCount === 0 && db.$client.idleCount === db.$client.totalCount,
      Boolean,
    );
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('rejects missing, wrong-audience and expired bearer tokens on every charge/credit route', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await jwt(driver, { iat: now - 1000, exp: now - 100 });
    const foreign = await new SignJWT({ sub: driver, role: 'driver', iss: issuer, aud: 'x' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    const routes: [string, string][] = [
      ['POST', '/charges'],
      ['GET', '/charges/key-12345678'],
      ['GET', '/sessions/1/progress'],
      ['POST', '/sessions/1/stop'],
      ['GET', '/sessions/1/statement'],
      ['GET', '/credit'],
      ['GET', '/credit/transactions'],
    ];
    for (const [method, path] of routes)
      for (const auth of [null, expired, foreign, 'not-a-jwt']) {
        const result = await call(method, path, { auth, key: 'unauth-probe-0001' });
        expect([method, path, result.status, result.body?.error]).toEqual([
          method,
          path,
          401,
          'unauthorized',
        ]);
        expect(result.headers.get('www-authenticate')).toBe('Bearer');
      }
    expect(startCount).toBe(0);
  });

  it('returns own credit balance equal to the ledger sum, and zero for a driver without a wallet', async () => {
    const credit = await call('GET', '/credit');
    expect(credit.status).toBe(200);
    expect(credit.headers.get('cache-control')).toBe('no-store');
    expect(credit.body).toMatchObject({
      balance_vnd: 200000,
      held_vnd: 0,
      available_vnd: 200000,
      status: 'active',
    });
    const history = await call('GET', '/credit/transactions');
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ total: 1, page: 1, page_size: 20 });
    expect(history.body.items[0]).toMatchObject({
      entry_no: 1,
      transaction_type: 'adjustment',
      amount_vnd: 200000,
      balance_after_vnd: 200000,
      session_id: null,
    });
    expect(typeof history.body.items[0].transaction_id).toBe('string');
    const none = await call('GET', '/credit', { auth: await jwt(walletless) });
    expect(none.body).toEqual({
      balance_vnd: 0,
      held_vnd: 0,
      available_vnd: 0,
      status: 'none',
      updated_at: null,
    });
    expect(
      (await call('GET', '/credit/transactions', { auth: await jwt(walletless) })).body,
    ).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
    for (const bad of ['?page=0', '?page_size=101', '?page=x', '?foo=1', '?page=1&page=2'])
      expect((await call('GET', `/credit/transactions${bad}`)).body.error).toBe('invalid_input');
    expect((await call('GET', '/credit?x=1')).status).toBe(400);
  });

  it('validates the start request: key header, JSON body, method and media type', async () => {
    const noKey = await call('POST', '/charges', { body: startBody() });
    expect([noKey.status, noKey.body.error]).toEqual([400, 'invalid_idempotency_key']);
    for (const key of ['short', 'has space key', 'x'.repeat(101)])
      expect((await call('POST', '/charges', { key, body: startBody() })).body.error).toBe(
        'invalid_idempotency_key',
      );
    const key = 'validate-0001';
    for (const body of [
      startBody({ extra: 1 }),
      startBody({ connector_id: Number(connector) }),
      startBody({ energy_limit_wh: 0 }),
      startBody({ energy_limit_wh: 1.5 }),
      startBody({ mode: undefined }),
      '[1]',
      '{bad json',
    ])
      expect([(await call('POST', '/charges', { key, body })).body.error]).toEqual([
        'invalid_input',
      ]);
    expect(
      (await call('POST', '/charges', { key, body: startBody({ mode: 'vnd' }) })).body,
    ).toEqual({ error: 'unsupported_mode', detail: 'unsupported_mode' });
    expect(
      (await call('POST', '/charges', { key, body: startBody({ vehicle_id: otherVehicle }) })).body
        .error,
    ).toBe('vehicle_not_owned_or_incompatible');
    const textPlain = await call('POST', '/charges', {
      key,
      body: JSON.stringify(startBody()),
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(textPlain.status).toBe(415);
    const get = await call('GET', '/charges');
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST, OPTIONS']);
    const getStop = await call('GET', '/sessions/1/stop');
    expect([getStop.status, getStop.headers.get('allow')]).toEqual([405, 'POST, OPTIONS']);
    const postProgress = await call('POST', '/sessions/1/progress', { key });
    expect([postProgress.status, postProgress.headers.get('allow')]).toEqual([405, 'GET, OPTIONS']);
    expect((await call('POST', '/charges?x=1', { key, body: startBody() })).status).toBe(400);
    const preflight = await call('OPTIONS', '/charges', {
      auth: null,
      headers: { Origin: 'http://localhost:4200' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, Idempotency-Key',
    );
    // Không request nào ở trên ghi intent hay gửi lệnh xuống trụ.
    expect(await q('SELECT 1 FROM driver_charge_intents')).toHaveLength(0);
    expect(startCount).toBe(0);
  });

  it('records insufficient credit as a rejected intent (202 topuprequired), idempotently, without RemoteStart', async () => {
    const auth = await jwt(poor);
    const body = startBody({ vehicle_id: poorVehicle });
    const first = await call('POST', '/charges', { auth, key: 'poor-start-1', body });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({
      command_id: null,
      session_id: null,
      outcome: 'topuprequired',
      effect_confirmed: false,
      max_energy_wh: null,
    });
    const again = await call('POST', '/charges', { auth, key: 'poor-start-1', body });
    expect(again).toMatchObject({ status: 202, body: first.body });
    expect((await call('GET', '/charges/poor-start-1', { auth })).body).toEqual(first.body);
    const credit = await call('GET', '/credit', { auth });
    expect(credit.body).toMatchObject({ balance_vnd: 20000, held_vnd: 0, available_vnd: 20000 });
    expect(startCount).toBe(0);
  });

  it('runs start → poll → progress → stop → statement, scoped to the owner, with idempotent replays', async () => {
    // Start (D4): 202 ngay khi intent ghi bền và lệnh đã có kết quả.
    const started = await call('POST', '/charges', { key: 'start-main-0001', body: startBody() });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      intent_id: expect.stringMatching(/^[1-9][0-9]*$/),
      command_id: expect.stringMatching(/^[1-9][0-9]*$/),
      max_energy_wh: null,
    });
    // Poll như app cho đến khi trụ gửi StartTransaction.
    const polled = await until(
      () => call('GET', '/charges/start-main-0001'),
      (r) => r.body.session_id !== null,
    );
    expect(polled.body).toMatchObject({
      intent_id: started.body.intent_id,
      command_id: started.body.command_id,
      outcome: 'active',
      effect_confirmed: true,
    });
    const sessionId: string = polled.body.session_id;
    expect(sessionId).toMatch(/^[1-9][0-9]*$/);
    expect(startCount).toBe(1);

    // Cùng key cùng body: cùng snapshot, không RemoteStart lần hai. Khác body: 409.
    const replay = await call('POST', '/charges', { key: 'start-main-0001', body: startBody() });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(polled.body);
    const conflict = await call('POST', '/charges', {
      key: 'start-main-0001',
      body: startBody({ energy_limit_wh: 9000 }),
    });
    expect([conflict.status, conflict.body.error]).toEqual([409, 'idempotency_conflict']);
    expect(startCount).toBe(1);
    // Súng đang sạc (trụ báo Charging): key mới → 409, không gửi lệnh.
    const busy = await call('POST', '/charges', { key: 'start-main-0002', body: startBody() });
    expect([busy.status, busy.body.error]).toEqual([409, 'connector_unavailable']);

    // Giữ trước BR-P18: 10 kWh × 5.000 ₫ = 50.000 ₫.
    expect((await call('GET', '/credit')).body).toMatchObject({
      balance_vnd: 200000,
      held_vnd: 50000,
      available_vnd: 150000,
    });

    await meter(4000);
    const progress = await call('GET', `/sessions/${sessionId}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({
      session_id: sessionId,
      status: 'active',
      meter_start_wh: 1000,
      meter_stop_wh: null,
      energy_wh: null,
      consumed_wh: 3000,
      telemetry_quality: 'observed',
      limit_value: 10000,
      reserved_vnd: 50000,
      estimated_cost_vnd: 15000,
      billing_review_required: false,
      settlement_state: null,
      time_left: null,
      charge_point: { lifecycle: 'in_service', is_online: true },
    });

    // Tài xế khác: không xem/dừng/thấy bảng kê/thấy start của A → 404 như id không tồn tại.
    for (const [method, path] of [
      ['GET', `/sessions/${sessionId}/progress`],
      ['POST', `/sessions/${sessionId}/stop`],
      ['GET', `/sessions/${sessionId}/statement`],
      ['GET', '/charges/start-main-0001'],
      ['GET', '/sessions/999999/progress'],
    ] as const) {
      const result = await call(method, path, { auth: otherToken, key: 'other-stop-0001' });
      expect([path, result.status, result.body]).toEqual([
        path,
        404,
        { error: 'not_found', detail: 'not_found' },
      ]);
    }
    expect(stopCount).toBe(0);
    expect((await call('GET', '/sessions/9007199254740993/progress')).status).toBe(404);
    expect((await call('GET', '/sessions/abc/progress')).body.error).toBe('invalid_input');
    expect(
      (await call('POST', `/sessions/${sessionId}/stop`, { key: 'limit:12345678' })).body.error,
    ).toBe('reserved_idempotency_key');
    expect((await call('POST', `/sessions/${sessionId}/stop`)).body.error).toBe(
      'invalid_idempotency_key',
    );
    // Chưa quyết toán → statement 404.
    expect((await call('GET', `/sessions/${sessionId}/statement`)).status).toBe(404);

    // Stop: 202 với lệnh mới nhất; trụ gửi StopTransaction meterStop 5000 → 4000 Wh.
    meterStop = 5000;
    const stopped = await call('POST', `/sessions/${sessionId}/stop`, { key: 'stop-main-0001' });
    expect(stopped.status).toBe(202);
    expect(stopped.body).toMatchObject({
      command_id: expect.stringMatching(/^[1-9][0-9]*$/),
      command_status: 'accepted',
    });
    const closed = await until(
      () => call('GET', `/sessions/${sessionId}/progress`),
      (r) => r.body.energy_wh !== null && r.body.settlement_state === 'posted',
    );
    expect(closed.body).toMatchObject({
      meter_stop_wh: 5000,
      energy_wh: 4000,
      consumed_wh: 4000,
      estimated_cost_vnd: 20000,
    });
    expect(['closed', 'reconciled']).toContain(closed.body.status);
    const stopReplay = await call('POST', `/sessions/${sessionId}/stop`, { key: 'stop-main-0001' });
    expect(stopReplay.status).toBe(202);
    expect(stopReplay.body).toMatchObject({
      command_id: stopped.body.command_id,
      effect_confirmed: true,
    });
    expect(stopCount).toBe(1);
    const late = await call('POST', `/sessions/${sessionId}/stop`, { key: 'stop-main-0002' });
    expect([late.status, late.body.error]).toEqual([409, 'session_not_stoppable']);
    const reused = await call('POST', '/sessions/999999/stop', { key: 'stop-main-0001' });
    expect(reused.status).toBe(404);

    // Bảng kê một lần trừ (BR-P45): 4 kWh × 5.000 ₫ = 20.000 ₫.
    const statement = await call('GET', `/sessions/${sessionId}/statement`);
    expect(statement.status).toBe(200);
    expect(statement.body).toMatchObject({
      session_id: sessionId,
      driver_id: driver,
      energy_wh: 4000,
      amount_vnd: 20000,
      earned_points: 20,
    });
    expect(statement.body.debit_id).toMatch(/^[1-9][0-9]*$/);

    // Credit sau phiên: hết giữ trước, số dư = Σ sổ cái, dòng mới nhất là session_debit của phiên.
    const credit = await call('GET', '/credit');
    expect(credit.body).toMatchObject({
      balance_vnd: 180000,
      held_vnd: 0,
      available_vnd: 180000,
    });
    const [ledger] = await q(
      `SELECT sum(t.amount_vnd)::bigint AS sum FROM credit_transactions t
       JOIN credit_accounts a ON a.id=t.credit_account_id WHERE a.driver_id=$1`,
      [driver],
    );
    expect(Number(ledger!.sum)).toBe(credit.body.balance_vnd);
    const history = await call('GET', '/credit/transactions?page_size=1');
    expect(history.body).toMatchObject({ total: 2, page: 1, page_size: 1 });
    expect(history.body.items).toEqual([
      expect.objectContaining({
        transaction_id: statement.body.debit_id,
        entry_no: 2,
        transaction_type: 'session_debit',
        amount_vnd: -20000,
        balance_after_vnd: 180000,
        session_id: sessionId,
      }),
    ]);
    expect((await call('GET', '/credit/transactions?page=2&page_size=1')).body.items[0]).toEqual(
      expect.objectContaining({ entry_no: 1, transaction_type: 'adjustment' }),
    );
    expect((await call('GET', '/credit/transactions?page=9')).body).toEqual({
      items: [],
      total: 2,
      page: 9,
      page_size: 20,
    });
    // Tài xế khác chỉ thấy ví của mình.
    expect((await call('GET', '/credit', { auth: otherToken })).body).toMatchObject({
      balance_vnd: 200000,
      held_vnd: 0,
    });
    expect((await call('GET', '/credit/transactions', { auth: otherToken })).body.total).toBe(1);
  });

  it('shows progress of a session the app did not start (RFID online) to its driver only', async () => {
    // Phiên RFID online ghi thẳng DB (không qua trụ) — chỉ để kiểm quyền xem và chặn dừng từ app.
    const [cp] = await q("SELECT id FROM charge_points WHERE serial_number='BE22-CP'");
    const [row] = await q(
      `INSERT INTO sessions(charge_point_id,connector_id,connector_no,id_tag,driver_id,origin,
        payment_mode,status,meter_start_wh,cp_started_at)
       VALUES($1,$2,1,'BE22-CARD',$3,'rfid','csms_billed','active',2000,now()-interval '1 hour')
       RETURNING id::text AS id`,
      [cp!.id, connector, driver],
    );
    const progress = await call('GET', `/sessions/${row!.id}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({
      session_id: row!.id,
      status: 'active',
      meter_start_wh: 2000,
      consumed_wh: null,
      telemetry_quality: 'unknown',
      reserved_vnd: null,
      estimated_cost_vnd: null,
      billing_review_required: false,
    });
    expect((await call('GET', `/sessions/${row!.id}/progress`, { auth: otherToken })).status).toBe(
      404,
    );
    // Dừng từ app chỉ cho phiên bắt đầu từ app (service hiện tại) → 404, không gửi lệnh.
    expect(
      (await call('POST', `/sessions/${row!.id}/stop`, { key: 'stop-rfid-0001' })).status,
    ).toBe(404);
    expect(stopCount).toBe(1);
  });
});
