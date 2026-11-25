/**
 * T104 — BR-P20 trên đường app: ví âm chặn sạc, top-up trả phần thiếu trước, đủ mức tối thiểu
 * (BR-P18) mới sạc được. HTTP thật (`POST /charges`) + OCPP thật + Postgres thật.
 *
 * Vì sao tồn tại: các test có sẵn chỉ kiểm từng mảnh (wf01: phiên vượt số dư → `in_shortfall` ở
 * cấp service; billing-ipn / billing-ledger: nạp → `active`; card-authorize: thẻ bị chặn). Chưa ca
 * nào đi hết chuỗi trên route app, và chưa ca nào kiểm 409 `credit_unavailable` của POST /charges.
 *
 * Hành vi kiểm theo code + hợp đồng (DRIVER-API-HOP-DONG.md dòng 183): ví không `active`
 * (`in_shortfall`) → 409 `credit_unavailable` TRƯỚC khi kiểm mức tối thiểu, không ghi intent;
 * ví `active` nhưng dưới mức tối thiểu → 202 `topuprequired` (intent `rejected`).
 *
 * Số dư âm dựng bằng một phiên thật (trụ gửi StopTransaction vượt số dư → quyết toán trừ một
 * dòng `session_debit`), không UPDATE `credit_accounts` tay. Nạp tiền qua `TopUpService.create`
 * + IPN đã ký như billing-ipn. Trụ giả là RPCClient như driver-charges.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { RPCClient } from 'ocpp-rpc';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TOP_UP_MIN_VND, TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter, vnpSecureHash, vnpSignData } from '../src/billing/vnpay.adapter.js';
import type { VnpayConfig } from '../src/billing/vnpay.config.js';
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
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const secret = randomBytes(32);
const issuer = 'powerme-t104-test';
const audience = 'powerme-driver-test';
const MINIMUM_START_VND = 50_000;
const policy: ChargePolicy = {
  minimumStartVnd: MINIMUM_START_VND,
  cutoffReserveVnd: 10_000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 3000,
  stationStaleAfterMs: 600_000,
};
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const IP = '203.0.113.7';
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

/** Poll đến khi `ok`; hết hạn thì fail và nói rõ đang chờ gì (không sleep cố định). */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `timeout ${POLL_TIMEOUT_MS} ms waiting for ${what}; last value: ${JSON.stringify(value)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Ký tham số như VNPay (cùng cách billing-ipn). */
function sign(params: Record<string, string>): Record<string, string> {
  return { ...params, vnp_SecureHash: vnpSecureHash(vnpSignData(params), VNPAY.hashSecret) };
}

describeDb('T104 BR-P20 trên đường app: ví âm, nạp bù phần thiếu, mức tối thiểu', () => {
  let db: Db;
  let server: ConsoleServer;
  let ocpp: OcppServer;
  let grace: OfflineGraceService;
  let station: RPCClient;
  let ledger: CreditLedgerService;
  let topUps: TopUpService;
  let base: string;
  let connector: string;
  let model: string;
  let startCount = 0;
  let transactionId = 0;
  let meterStop = 1000;
  let txn = 80_000_000;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function jwt(sub: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }

  async function call(method: string, path: string, auth: string, key?: string, body?: unknown) {
    const response = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  /** Tài xế + xe + ví (qua CreditLedgerService, số dư mở đầu là một dòng adjustment). */
  async function newDriver(openingVnd: number) {
    seq += 1;
    const id = String(
      (
        await q(
          "INSERT INTO users(email,full_name,role) VALUES($1,'T104','driver') RETURNING id::text AS id",
          [`d${seq}@t104.invalid`],
        )
      )[0]!.id,
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [id],
    );
    const vehicle = String(
      (
        await q(
          'INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,$3) RETURNING id::text AS id',
          [id, model, `T104-${seq}`],
        )
      )[0]!.id,
    );
    const { creditAccountId } = await ledger.ensureAccounts(Number(id));
    const c = await db.$client.connect();
    try {
      await c.query('BEGIN');
      await ledger.post(c, creditAccountId, 'adjustment', openingVnd);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    return { id, vehicle, accountId: creditAccountId, auth: await jwt(id) };
  }

  /** Top-up thật: `create` (pending) rồi IPN thành công đã ký → `credited`. */
  async function topUp(driverId: string, amountVnd: number): Promise<number> {
    const { topUp: made } = await topUps.create(
      Number(driverId),
      `t104-topup-${++seq}`,
      { amountVnd },
      IP,
    );
    const ref = String(
      (await q('SELECT gateway_reference FROM top_ups WHERE id=$1', [made.topUpId]))[0]!
        .gateway_reference,
    );
    const reply = await topUps.applyPaymentResult(
      sign({
        vnp_TmnCode: VNPAY.tmnCode,
        vnp_Amount: String(made.amountPaidVnd * 100),
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: 'VNP14000000',
        vnp_CardType: 'ATM',
        vnp_OrderInfo: `Nap tien PowerMe ${ref}`,
        vnp_PayDate: '20261120103000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: String(++txn),
        vnp_TxnRef: ref,
      }),
    );
    expect(reply.RspCode).toBe('00');
    return made.topUpId;
  }

  const startBody = (vehicle: string) => ({
    connector_id: connector,
    vehicle_id: vehicle,
    mode: 'energy_kwh',
    energy_limit_wh: 10_000,
  });
  const account = async (accountId: number) =>
    (await q('SELECT balance_vnd,status FROM credit_accounts WHERE id=$1', [accountId]))[0];
  const commandCount = async () =>
    Number((await q('SELECT count(*)::int AS n FROM remote_commands'))[0]!.n);
  const connectorAvailable = () =>
    station.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      status: 'Available',
    });

  /** Dừng phiên app qua route, chờ quyết toán `posted`, trả súng về Available. */
  async function stopAndSettle(auth: string, sessionId: string, key: string) {
    const stopped = await call('POST', `/sessions/${sessionId}/stop`, auth, key);
    expect(stopped.status).toBe(202);
    const closed = await until(
      `session ${sessionId} settlement_state = 'posted'`,
      () => call('GET', `/sessions/${sessionId}/progress`, auth),
      (r) => r.body?.settlement_state === 'posted',
    );
    await connectorAvailable();
    return closed;
  }

  /** Start được chấp nhận: chờ trụ gửi StartTransaction (snapshot có session_id). */
  async function startedSession(auth: string, key: string): Promise<string> {
    const polled = await until(
      `StartTransaction for start ${key} (session_id on GET /charges/${key})`,
      () => call('GET', `/charges/${key}`, auth),
      (r) => r.body?.session_id != null,
    );
    return polled.body.session_id as string;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    ledger = new CreditLedgerService(db);
    topUps = new TopUpService(
      db,
      ledger,
      new LoyaltyService({ pointsExpiryMonths: 12 }),
      new VnpayAdapter(VNPAY),
    );

    const op = (
      await q("INSERT INTO operators(tax_code,legal_name) VALUES('T104','T104 Op') RETURNING id")
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name) VALUES('T104',$1,'T104 Site') RETURNING id",
        [op],
      )
    )[0]!.id;
    const password = randomBytes(18).toString('base64url');
    const cp = (
      await q(
        `INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,basic_auth_password_hash)
         VALUES('T104-CP','PM-T104-0001',$1,'awaiting_connection',$2) RETURNING id`,
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
    model = String(
      (await q("INSERT INTO vehicle_models(brand,model_name) VALUES('Test','EV') RETURNING id"))[0]!
        .id,
    );

    const config: CsmsConfig = {
      ...loadConfig({
        DATABASE_URL: DATABASE_URL as string,
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
    const charging = new DriverChargingService(
      db,
      registry,
      new ChargeSettlementService(
        db,
        new CreditLedgerService(db),
        new LoyaltyService(policy),
        policy,
      ),
      policy,
    );
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
    base = `http://127.0.0.1:${server.port}`;

    // Trụ giả: Accepted rồi tự gửi StartTransaction / StopTransaction như trụ thật.
    station = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'T104-CP',
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
    await station.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'T104' });
    await connectorAvailable();
    await until(
      'TriggerMessage calls after BootNotification',
      async () => triggers,
      (n) => n >= 3,
    );
  });

  afterAll(async () => {
    await station?.close({ force: true });
    await ocpp?.stop();
    await server?.stop();
    grace?.cancelAll();
    if (db) {
      await until(
        'database pool to become idle',
        async () => db.$client.waitingCount === 0 && db.$client.idleCount === db.$client.totalCount,
        Boolean,
      );
      await db.$client.end();
    }
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('TC-F04-01 (biến thể BR-P20): ví âm chặn sạc app, nạp bù phần thiếu trước, đủ mức tối thiểu mới sạc được', async () => {
    const d = await newDriver(60_000);

    // 1. Phiên trước vượt số dư: giữ 10 kWh × 5.000 = 50.000 ≤ 60.000, trụ báo 22 kWh → 110.000 ₫.
    const first = await call('POST', '/charges', d.auth, 't104-first-0001', startBody(d.vehicle));
    expect(first.status).toBe(202);
    expect(['accepted', 'active']).toContain(first.body.outcome);
    const firstSession = await startedSession(d.auth, 't104-first-0001');
    meterStop = 1000 + 22_000;
    await stopAndSettle(d.auth, firstSession, 't104-stop-0001');
    expect(
      await q(
        "SELECT amount_vnd,balance_after_vnd FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
        [firstSession],
      ),
    ).toEqual([{ amount_vnd: '-110000', balance_after_vnd: '-50000' }]);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      balance_vnd: -50_000,
      held_vnd: 0,
      available_vnd: -50_000,
      status: 'in_shortfall',
    });

    // 2. Ví in_shortfall → 409 credit_unavailable trước khi kiểm mức tối thiểu; không ghi gì.
    const startsBefore = startCount;
    const commandsBefore = await commandCount();
    const blocked = await call('POST', '/charges', d.auth, 't104-blocked-01', startBody(d.vehicle));
    expect([blocked.status, blocked.body.error]).toEqual([409, 'credit_unavailable']);
    expect(
      await q('SELECT 1 FROM driver_charge_intents WHERE driver_id=$1 AND idempotency_key=$2', [
        d.id,
        't104-blocked-01',
      ]),
    ).toHaveLength(0);
    expect(await commandCount()).toBe(commandsBefore);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      held_vnd: 0,
      status: 'in_shortfall',
    });

    // 3. Nạp đúng mức nạp tối thiểu: trả hết phần thiếu trước (−50.000 + 50.000 = 0) → active,
    //    nhưng 0 < mức khởi đầu → 202 topuprequired.
    expect(TOP_UP_MIN_VND).toBe(50_000);
    const covering = await topUp(d.id, 50_000);
    expect(await account(d.accountId)).toEqual({ balance_vnd: '0', status: 'active' });
    expect(
      await q(
        'SELECT transaction_type,amount_vnd,balance_after_vnd FROM credit_transactions WHERE top_up_id=$1',
        [covering],
      ),
    ).toEqual([{ transaction_type: 'top_up', amount_vnd: '50000', balance_after_vnd: '0' }]);
    const low = await call('POST', '/charges', d.auth, 't104-low-000001', startBody(d.vehicle));
    expect(low.status).toBe(202);
    expect(low.body).toMatchObject({
      outcome: 'topuprequired',
      session_id: null,
      command_id: null,
      effect_confirmed: false,
    });
    expect(await commandCount()).toBe(commandsBefore);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      balance_vnd: 0,
      held_vnd: 0,
      status: 'active',
    });

    // 4. Nạp thêm → available = 50.000 = đúng mức tối thiểu → bắt đầu được (biên "đúng mức").
    await topUp(d.id, 50_000);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      balance_vnd: MINIMUM_START_VND,
      held_vnd: 0,
      available_vnd: MINIMUM_START_VND,
    });
    const ok = await call('POST', '/charges', d.auth, 't104-ok-0000001', startBody(d.vehicle));
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ command_id: expect.stringMatching(/^[1-9][0-9]*$/) });
    const okSession = await startedSession(d.auth, 't104-ok-0000001');
    expect(startCount).toBe(startsBefore + 1);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      balance_vnd: MINIMUM_START_VND,
      held_vnd: 50_000,
      available_vnd: 0,
    });

    // Dọn: dừng phiên 0 Wh để súng rảnh cho ca sau và không còn phiên mở khi afterAll đóng trụ.
    meterStop = 1000;
    await stopAndSettle(d.auth, okSession, 't104-stop-0002');
  });

  it('BR-P18 biên trên đường app: available thiếu 1 VND so với mức tối thiểu → 202 topuprequired', async () => {
    const d = await newDriver(MINIMUM_START_VND - 1);
    const startsBefore = startCount;
    const res = await call('POST', '/charges', d.auth, 't104-edge-00001', startBody(d.vehicle));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      outcome: 'topuprequired',
      session_id: null,
      command_id: null,
    });
    expect(startCount).toBe(startsBefore);
    expect((await call('GET', '/credit', d.auth)).body).toMatchObject({
      balance_vnd: MINIMUM_START_VND - 1,
      held_vnd: 0,
      status: 'active',
    });
  });
});
