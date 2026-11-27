import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT, type JWTPayload } from 'jose';
import { createDb, type Db } from '../src/db/db.module.js';
import { loadDriverApiConfig } from '../src/driver/driver-auth.js';
import { createDriverListener } from '../src/driver/driver.http.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const secret = randomBytes(32);
const issuer = 'powerme-t146-test',
  audience = 'driver-test';
const policy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 3000,
  stationStaleAfterMs: 600000,
};

describeDb('T146 owned sessions over real HTTP/JWT and isolated PostgreSQL', () => {
  let db: Db, http: Server, base: string, driver: string, other: string, admin: string;
  let connector: string,
    cp: string,
    vehicle: string,
    foreignVehicle: string,
    service: DriverChargingService;
  const bigDriver = '9007199254740993',
    bigSession = '9007199254740995';
  const sessions: Record<string, string> = {};
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;
  async function jwt(sub = driver, claims: JWTPayload = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      role: 'driver',
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }
  async function call(
    path = '/sessions',
    options: { auth?: string | null; method?: string; key?: string } = {},
  ) {
    const auth = options.auth === undefined ? await jwt() : options.auth;
    const response = await fetch(base + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.status === 204 ? null : ((await response.json()) as any),
    };
  }
  async function session(
    name: string,
    status: string,
    origin = 'rfid',
    stopped = false,
    owner: string | null = driver,
    vehicleId: string | null = null,
    id?: string,
  ) {
    const row = (
      await q(
        `INSERT INTO sessions(id,connector_id,charge_point_id,connector_no,id_tag,
      driver_id,vehicle_id,origin,payment_mode,status,cp_started_at,received_started_at,
      received_stopped_at,meter_start_wh,meter_stop_wh,energy_wh,total_cost_vnd)
      OVERRIDING SYSTEM VALUE VALUES(coalesce($1::bigint,nextval(pg_get_serial_sequence('sessions','id'))),
      $2,$3,1,$4,$5,$6,$7::session_origin,$10::payment_mode,$8,'2026-11-23T01:00:00Z','2026-11-23T01:00:00Z',
      CASE WHEN $9 THEN '2026-11-23T02:00:00Z'::timestamptz ELSE NULL END,1000,
      CASE WHEN $9 THEN 2000 ELSE NULL END,CASE WHEN $9 THEN 1000 ELSE NULL END,9999)
      RETURNING id::text`,
        [
          id ?? null,
          connector,
          cp,
          't146-' + Object.keys(sessions).length,
          owner,
          vehicleId,
          origin,
          status,
          stopped,
          ['hmi_password', 'free_vend'].includes(origin) ? 'unattributed' : 'csms_billed',
        ],
      )
    )[0]!;
    sessions[name] = row.id;
    return row.id as string;
  }
  async function intent(id: string, owner = driver) {
    await q(
      `INSERT INTO driver_charge_intents(driver_id,connector_id,vehicle_id,idempotency_key,
      request_hash,id_tag,energy_limit_wh,reserved_vnd,session_id,state,connector_released_at)
      VALUES($1,$2,$3,$4,'test',$4,10000,50000,$5,'effect',now())`,
      [owner, connector, vehicle, 'intent-' + id, id],
    );
  }
  beforeAll(async () => {
    if (!url) throw new Error('Missing test DB');
    const parsed = new URL(url);
    if (
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(parsed.pathname)
    )
      throw new Error('Requires new isolated loopback test database and explicit opt-in');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    if ((await q("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'"))[0]!.n !== 0)
      throw new Error('Test DB must be completely empty; never reset application data');
    await migrate(db.$client);
    for (const name of ['owner', 'other', 'admin', 'big']) {
      const role = name === 'admin' ? 'admin' : 'driver';
      const row = (
        await q(
          `INSERT INTO users(id,email,full_name,role) OVERRIDING SYSTEM VALUE
        VALUES(coalesce($1::bigint,nextval(pg_get_serial_sequence('users','id'))),$2,$3,$4) RETURNING id::text`,
          [name === 'big' ? bigDriver : null, name + '@t146.invalid', name, role],
        )
      )[0]!;
      if (name === 'admin') admin = row.id;
      else {
        await q(
          "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test',now())",
          [row.id],
        );
        if (name === 'owner') driver = row.id;
        if (name === 'other') other = row.id;
      }
    }
    const op = (
      await q(
        "INSERT INTO operators(tax_code,legal_name) VALUES('T146','Synthetic Op') RETURNING id",
      )
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,site_name,operator_id) VALUES('T146','Synthetic Site',$1) RETURNING id",
        [op],
      )
    )[0]!.id;
    cp = (
      await q(
        "INSERT INTO charge_points(serial_number,display_code,site_id) VALUES('T146-CP','PM-T146-0001',$1) RETURNING id::text",
        [site],
      )
    )[0]!.id;
    connector = (
      await q(
        'INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id::text',
        [cp],
      )
    )[0]!.id;
    const model = (
      await q("INSERT INTO vehicle_models(brand,model_name) VALUES('Synthetic','EV') RETURNING id")
    )[0]!.id;
    vehicle = (
      await q(
        "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number,is_default) VALUES($1,$2,'OWN-DEFAULT',true) RETURNING id::text",
        [driver, model],
      )
    )[0]!.id;
    foreignVehicle = (
      await q(
        "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,'FOREIGN-EV') RETURNING id::text",
        [other, model],
      )
    )[0]!.id;
    await session('rfid-active', 'active');
    await session('rfid-stopped', 'closed', 'rfid', true);
    await session('foreign', 'active', 'rfid', false, other, foreignVehicle);
    await session('unattributed', 'active', 'hmi_password', false, null);
    await session('foreign-vehicle', 'active', 'rfid', false, driver, foreignVehicle);
    await session('big', 'active', 'rfid', false, bigDriver, null, bigSession);
    for (const state of [
      'pending',
      'active',
      'paused',
      'stopping',
      'orphaned',
      'review',
      'failed',
      'closed',
      'reconciled',
    ]) {
      const id = await session(
        'app-' + state,
        state,
        'app_qr',
        ['closed', 'reconciled'].includes(state),
        driver,
        vehicle,
      );
      await intent(id);
    }
    await session('app-no-intent', 'active', 'app_qr');
    const wrong = await session('app-wrong-intent', 'active', 'app_qr');
    await intent(wrong, other);
    await session('app-stopped-active', 'active', 'app_qr', true);
    // StopTransaction với meterStop < meterStart: CSMS ghi giờ dừng nhưng để meter_stop_wh NULL, status giữ orphaned.
    const meterBack = await session('app-orphaned-meter-back', 'orphaned', 'app_qr', true);
    await q('UPDATE sessions SET meter_stop_wh=NULL,energy_wh=NULL WHERE id=$1', [meterBack]);
    await intent(meterBack);
    await intent(sessions['app-stopped-active']!);
    await session('rfid-with-intent', 'active');
    await intent(sessions['rfid-with-intent']!);
    await session('hmi', 'active', 'hmi_password');
    await session('free', 'active', 'free_vend');
    const stmtSession = sessions['app-closed']!;
    const account = (
      await q('INSERT INTO credit_accounts(driver_id) VALUES($1) RETURNING id', [driver])
    )[0]!.id;
    const debit = (
      await q(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,
      amount_vnd,balance_after_vnd,session_id) VALUES($1,1,'session_debit',-4200,-4200,$2) RETURNING id`,
        [account, stmtSession],
      )
    )[0]!.id;
    const loyalty = (
      await q('INSERT INTO loyalty_accounts(driver_id) VALUES($1) RETURNING id', [driver])
    )[0]!.id;
    const earn = (
      await q(
        `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,session_id)
      VALUES($1,1,'earn',4,$2) RETURNING id`,
        [loyalty, stmtSession],
      )
    )[0]!.id;
    await q(
      `INSERT INTO charging_statements(session_id,driver_id,energy_wh,amount_vnd,earned_points,debit_id,loyalty_entry_id)
      VALUES($1,$2,1000,4200,4,$3,$4)`,
      [stmtSession, driver, debit, earn],
    );
    const registry = new ConnectionRegistry(db);
    service = new DriverChargingService(
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
    http = createServer(
      createDriverListener(
        db,
        service,
        loadDriverApiConfig({
          DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
          DRIVER_API_JWT_ISSUER: issuer,
          DRIVER_API_JWT_AUDIENCE: audience,
        }),
      ),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (http.address() as AddressInfo).port + '/api/driver/v1';
  });
  afterAll(async () => {
    if (http)
      await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });
  it('discovers owned app and unbilled RFID, with no ledger or intent dependency', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, page_size: 20 });
    const ids = r.body.items.map((x: any) => x.session_id);
    expect(ids).toContain(sessions['rfid-active']);
    expect(ids).toContain(sessions['rfid-stopped']);
    expect(ids).toContain(sessions['app-active']);
    expect(ids).not.toContain(sessions['foreign']);
    expect(ids).not.toContain(sessions['unattributed']);
    expect(r.body.total).toBe(Object.keys(sessions).length - 3);
    expect(JSON.stringify(r.body)).not.toMatch(
      /id_tag|rfid_card|serial_number|basic_auth|FOREIGN-EV/,
    );
    const stopped = r.body.items.find((x: any) => x.session_id === sessions['rfid-stopped']);
    expect(stopped).toMatchObject({
      energy_wh: 1000,
      amount_vnd: null,
      statement_available: false,
      settlement_state: 'pending',
    });
    expect(stopped.started_at).toBe('2026-11-23T01:00:00.000Z');
    expect(stopped.stopped_at).toBe('2026-11-23T02:00:00.000Z');
  });
  it('active view excludes stopped and terminal states but includes open review/pending/stopping', async () => {
    const r = await call('/sessions?view=active&page_size=100');
    expect(r.status).toBe(200);
    for (const x of r.body.items)
      expect(['pending', 'active', 'paused', 'stopping', 'orphaned', 'review']).toContain(x.status);
    const ids = r.body.items.map((x: any) => x.session_id);
    for (const name of [
      'rfid-stopped',
      'app-closed',
      'app-reconciled',
      'app-failed',
      'app-stopped-active',
      'app-orphaned-meter-back',
    ])
      expect(ids).not.toContain(sessions[name]);
    for (const name of ['app-review', 'app-pending', 'app-stopping'])
      expect(ids).toContain(sessions[name]);
  });
  it('has stable bigint ordering for ties and accurate total for empty out-of-range pages', async () => {
    const all = await call('/sessions?page_size=100');
    const ids = all.body.items.map((x: any) => x.session_id);
    expect(ids).toEqual([...ids].sort((a: string, b: string) => (BigInt(a) > BigInt(b) ? -1 : 1)));
    const first = await call('/sessions?page_size=1'),
      second = await call('/sessions?page=2&page_size=1');
    expect(first.body.items[0].session_id).toBe(ids[0]);
    expect(second.body.items[0].session_id).toBe(ids[1]);
    const end = await call('/sessions?page=100000&page_size=100');
    expect(end.body).toEqual({ items: [], total: all.body.total, page: 100000, page_size: 100 });
    const big = await call('/sessions', { auth: await jwt(bigDriver) });
    expect(big.body.items[0].session_id).toBe(bigSession);
  });
  it('preserves unknown vehicle/energy and derives amount only from a real owned statement', async () => {
    const r = await call('/sessions?page_size=100');
    for (const name of ['rfid-active', 'foreign-vehicle']) {
      const x = r.body.items.find((i: any) => i.session_id === sessions[name]);
      expect(x).toMatchObject({
        vehicle_id: null,
        vehicle_label: null,
        energy_wh: null,
        amount_vnd: null,
      });
    }
    const app = r.body.items.find((i: any) => i.session_id === sessions['app-closed']);
    expect(app).toMatchObject({
      vehicle_id: vehicle,
      vehicle_label: 'OWN-DEFAULT',
      amount_vnd: 4200,
      statement_available: true,
    });
  });
  it('capabilities match progress for every origin/state/intent combination', async () => {
    const r = await call('/sessions?page_size=100');
    for (const item of r.body.items) {
      const name = Object.keys(sessions).find((k) => sessions[k] === item.session_id)!;
      const canStop = ['app-active', 'app-paused', 'app-orphaned'].includes(name);
      expect(item.can_stop).toBe(canStop);
      const p = await call('/sessions/' + item.session_id + '/progress');
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({
        origin: item.origin,
        payment_mode: item.payment_mode,
        can_stop: canStop,
        statement_available: item.statement_available,
      });
    }
  });
  it('owned RFID still cannot POST stop; ownership is hidden for foreign progress', async () => {
    const stop = await call('/sessions/' + sessions['rfid-active'] + '/stop', {
      method: 'POST',
      key: 't146-stop-0001',
    });
    expect(stop.status).toBe(404);
    expect((await call('/sessions/' + sessions['foreign'] + '/progress')).status).toBe(404);
    expect((await call('/sessions/' + sessions['unattributed'] + '/progress')).status).toBe(404);
  });
  it.each([
    'view=stopped',
    'view=all&view=active',
    'driver_id=1',
    'id_tag=card',
    'page=0',
    'page=-1',
    'page=1.5',
    'page=100001',
    'page_size=101',
    'page=1&page=2',
    'page=1%0A',
    'page_size=20%0D',
    'page=1%3BDROP%20TABLE%20sessions',
    'page=999999999999999999999',
  ])('rejects malformed query %s', async (query) => {
    const r = await call('/sessions?' + query);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_input');
  });
  it('auth precedes query/method validation; rejects spoofed role and disabled account', async () => {
    expect((await call('/sessions?driver_id=1', { auth: null })).status).toBe(401);
    expect((await call('/sessions', { auth: await jwt(driver, { role: 'admin' }) })).status).toBe(
      403,
    );
    expect((await call('/sessions', { auth: await jwt(admin) })).status).toBe(403);
    const expired = await jwt(driver, { iat: 1, exp: 2 });
    expect((await call('/sessions', { auth: expired })).status).toBe(401);
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [driver]);
    try {
      expect((await call()).status).toBe(403);
    } finally {
      await q("UPDATE users SET account_status='active' WHERE id=$1", [driver]);
    }
  });
  it('returns an empty owned page and hides another driver statements', async () => {
    const empty = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('empty@t146.invalid','Empty','driver') RETURNING id::text",
      )
    )[0]!.id;
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test',now())",
      [empty],
    );
    expect((await call('/sessions', { auth: await jwt(empty) })).body).toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
    const id = sessions['app-closed']!;
    await q('UPDATE charging_statements SET driver_id=$1 WHERE session_id=$2', [other, id]);
    try {
      const r = await call('/sessions?page_size=100');
      expect(r.body.items.find((x: any) => x.session_id === id)).toMatchObject({
        statement_available: false,
        amount_vnd: null,
      });
      expect((await call('/sessions/' + id + '/progress')).body.statement_available).toBe(false);
    } finally {
      await q('UPDATE charging_statements SET driver_id=$1 WHERE session_id=$2', [driver, id]);
    }
  });
  it('unattributed payment never advertises a statement or amount', async () => {
    const id = sessions['app-closed']!;
    await q("UPDATE sessions SET payment_mode='unattributed' WHERE id=$1", [id]);
    try {
      const r = await call('/sessions?page_size=100');
      expect(r.body.items.find((x: any) => x.session_id === id)).toMatchObject({
        statement_available: false,
        amount_vnd: null,
      });
      expect((await call('/sessions/' + id + '/progress')).body.statement_available).toBe(false);
    } finally {
      await q("UPDATE sessions SET payment_mode='csms_billed' WHERE id=$1", [id]);
    }
  });
  it('unsafe stored Wh cannot become a rounded JSON number', async () => {
    const id = sessions['rfid-stopped']!;
    await q('UPDATE sessions SET energy_wh=$1 WHERE id=$2', ['9007199254740992', id]);
    try {
      const r = await call();
      expect(r.status).toBe(500);
      expect(r.body.error).toBe('internal_error');
    } finally {
      await q('UPDATE sessions SET energy_wh=1000 WHERE id=$1', [id]);
    }
  });
  it('methods advertise GET/OPTIONS and preflight remains compatible', async () => {
    const r = await call('/sessions', { method: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, OPTIONS');
    const opt = await call('/sessions', { method: 'OPTIONS', auth: null });
    expect(opt.status).toBe(204);
    expect(opt.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
  it('GET list/progress works with writes forbidden and dispatches no commands', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM remote_commands'))[0]!.n;
    const original = db.$client.query.bind(db.$client);
    const query = jest.spyOn(db.$client, 'query');
    query.mockImplementation(((...args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(text))
        throw new Error('GET attempted write');
      return (original as any)(...args);
    }) as any);
    try {
      expect((await call()).status).toBe(200);
      expect((await call('/sessions/' + sessions['rfid-active'] + '/progress')).status).toBe(200);
    } finally {
      query.mockRestore();
    }
    expect((await q('SELECT count(*)::int AS n FROM remote_commands'))[0]!.n).toBe(before);
    expect((await q('SELECT count(*)::int AS n FROM charging_statements'))[0]!.n).toBe(1);
  });
  it('keeps rollback stops in all history with unknown final energy, never active or stoppable', async () => {
    const id = sessions['app-orphaned-meter-back']!;
    const all = await call('/sessions?view=all&page_size=100');
    expect(all.status).toBe(200);
    expect(all.body.items.find((item: any) => item.session_id === id)).toMatchObject({
      status: 'orphaned',
      stopped_at: '2026-11-23T02:00:00.000Z',
      energy_wh: null,
      amount_vnd: null,
      can_stop: false,
    });
    const active = await call('/sessions?view=active&page_size=100');
    expect(active.body.items.some((item: any) => item.session_id === id)).toBe(false);
    expect(
      active.body.items.find((item: any) => item.session_id === sessions['app-orphaned']),
    ).toMatchObject({
      can_stop: true,
      stopped_at: null,
    });
    const progress = await call('/sessions/' + id + '/progress');
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({
      status: 'orphaned',
      meter_stop_wh: null,
      can_stop: false,
    });
  });

  it.each(['app-orphaned-meter-back', 'app-stopped-active'])(
    'rejects a new stop key after physical stop (%s) without creating command or intent',
    async (name) => {
      const before = await stopCounts();
      const response = await call('/sessions/' + sessions[name] + '/stop', {
        method: 'POST',
        key: 't146-late-' + name,
      });
      expect([response.status, response.body.error]).toEqual([409, 'session_not_stoppable']);
      expect(await stopCounts()).toEqual(before);
    },
  );

  it.each(['rfid-with-intent', 'hmi', 'free'])(
    'rejects external new stop commands even with an owned app intent (%s)',
    async (name) => {
      const id = sessions[name]!;
      if (name !== 'rfid-with-intent') await intent(id);
      const before = await stopCounts();
      const response = await call('/sessions/' + id + '/stop', {
        method: 'POST',
        key: 't146-external-' + name,
      });
      expect([response.status, response.body.error]).toEqual([409, 'session_not_stoppable']);
      expect(await stopCounts()).toEqual(before);
    },
  );

  it('allows a live orphan stop and recovers the same key after invalid and valid final meters', async () => {
    const id = sessions['app-orphaned']!;
    const key = 't146-live-orphan-stop';
    const before = await stopCounts();
    const initial = await call('/sessions/' + id + '/stop', { method: 'POST', key });
    expect(initial.status).toBe(202);
    expect(initial.body.command_id).toMatch(/^[1-9][0-9]*$/);
    const sent = await stopCounts();
    expect(sent.commands).toBe(before.commands + 1);
    expect(sent.intents).toBe(before.intents + 1);
    expect(sent.attempts).toBe(before.attempts + 1);

    await q('UPDATE sessions SET received_stopped_at=now(),meter_stop_wh=NULL WHERE id=$1', [id]);
    const recovered = await call('/sessions/' + id + '/stop', { method: 'POST', key });
    expect(recovered.status).toBe(202);
    expect(recovered.body.command_id).toBe(initial.body.command_id);
    expect(recovered.body.effect_confirmed).toBe(false);
    const late = await call('/sessions/' + id + '/stop', { method: 'POST', key: key + '-new' });
    expect([late.status, late.body.error]).toEqual([409, 'session_not_stoppable']);
    expect(await stopCounts()).toEqual(sent);

    await q("UPDATE sessions SET status='closed',meter_stop_wh=2000,energy_wh=1000 WHERE id=$1", [
      id,
    ]);
    const confirmed = await call('/sessions/' + id + '/stop', { method: 'POST', key });
    expect(confirmed.status).toBe(202);
    expect(confirmed.body).toMatchObject({
      command_id: initial.body.command_id,
      effect_confirmed: true,
    });
    expect(await stopCounts()).toEqual(sent);
  });

  async function stopCounts() {
    return (
      await q(
        'SELECT (SELECT count(*)::int FROM remote_commands) AS commands, (SELECT count(*)::int FROM driver_stop_intents) AS intents, (SELECT count(*)::int FROM driver_stop_attempts) AS attempts',
      )
    )[0]!;
  }
});
