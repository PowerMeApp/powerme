// WP3/T146: real guarded HTTP and an empty isolated database; never reset an application database.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import type { InboundContext } from '../src/ocpp-gateway/inbound-context.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const ROOT = '/api/admin/v1/rfid-cards';
const BIG = '9007199254740993';
const DASH = { secret: randomBytes(32), issuer: 't146', audience: 'dashboard' };
const DRIVER = { secret: randomBytes(32), issuer: 't146-driver', audience: 'driver' };

describeDb('WP3/T146 admin RFID registry over HTTP and isolated PostgreSQL', () => {
  let db: Db, server: ConsoleServer, svc: SessionsService, config: CsmsConfig;
  let base = '',
    serial = 0;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const logs: string[] = [];
  const password = randomBytes(18).toString('base64url');
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  const uid = () => `T146-${++serial}`;
  async function token(who: string, role = 'admin', driver = false) {
    const cfg = driver ? DRIVER : DASH;
    return new SignJWT({ role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ids[who]!)
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(cfg.secret);
  }
  async function call(
    method: string,
    path = ROOT,
    body?: unknown,
    auth: string | null = tokens['admin']!,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
      text,
    };
  }
  async function raw(method: string, path: string, body: string, media = 'application/json') {
    return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          base + path,
          {
            method,
            headers: {
              Authorization: `Bearer ${tokens['admin']}`,
              'Content-Type': media,
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
                headers: res.headers,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  }
  async function register(input: Record<string, unknown> = {}) {
    const r = await call('POST', ROOT, { card_identifier: uid(), card_kind: 'online', ...input });
    expect(r.status).toBe(201);
    return r.body;
  }
  const patch = (card: { id: string }, body: unknown) => call('PATCH', ROOT + '/' + card.id, body);
  const expectError = (
    r: { status: number; body: any },
    status: number,
    error = 'invalid_input',
  ) => {
    expect([r.status, r.body]).toEqual([status, { error, detail: error }]);
  };

  beforeAll(async () => {
    if (
      !url ||
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw new Error('Requires a fresh isolated MB03 loopback database');
    Logger.overrideLogger({
      log: (m) => void logs.push(String(m)),
      warn: (m) => void logs.push(String(m)),
      error: (m) => void logs.push(String(m)),
    });
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS t"))[0]!.t)
      throw new Error('Database must be empty');
    await migrate(db.$client);
    const hash = await hashChargePointPassword(password);
    for (const [name, role] of [
      ['admin', 'admin'],
      ['suspended', 'admin'],
      ['noadmin', 'admin'],
      ['staff', 'operator_staff'],
      ['owner', 'driver'],
      ['other', 'driver'],
    ] as const) {
      ids[name] = (
        await q(
          'INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id::text AS id',
          [name + '@t146.invalid', name, role, hash],
        )
      )[0].id;
    }
    await q('INSERT INTO admins(user_id) VALUES($1),($2)', [ids['admin'], ids['suspended']]);
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [ids['suspended']]);
    await q(
      "INSERT INTO users(id,email,full_name,role) OVERRIDING SYSTEM VALUE VALUES($1,'big@t146.invalid','big','driver')",
      [BIG],
    );
    ids['big'] = BIG;
    for (const name of ['owner', 'other', 'big']) {
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t146',now())",
        [ids[name]],
      );
      await q('INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,200000)', [ids[name]]);
    }
    config = {
      ...loadConfig({ DATABASE_URL: url }),
      ocppPort: 0,
      consolePort: 0,
      dashboardAuth: DASH,
      driverApi: { ...DRIVER, devAuth: false },
    };
    const registry = new ConnectionRegistry(db);
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    const login = await call(
      'POST',
      '/api/auth/v1/login',
      { email: 'admin@t146.invalid', password },
      null,
    );
    expect(login.status).toBe(200);
    tokens['admin'] = login.body.access_token;
    tokens['refresh'] = login.body.refresh_token;
    for (const name of ['suspended', 'noadmin']) tokens[name] = await token(name);
    tokens['staff'] = await token('staff', 'operator_staff');
    tokens['driver'] = await token('owner', 'driver', true);
    svc = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('guards bad method/query/body/child paths before exposing validation', async () => {
    for (const [method, path, body] of [
      ['GET', ROOT + '?extra=1', undefined],
      ['POST', ROOT, {}],
      ['PATCH', ROOT + '/bad?extra=1', {}],
      ['DELETE', ROOT + '/bad', undefined],
      ['PATCH', ROOT + '/1/extra', {}],
    ] as const) {
      expectError(await call(method, path, body, null), 401, 'unauthorized');
      for (const who of ['staff', 'driver', 'noadmin'])
        expectError(await call(method, path, body, tokens[who]), 403, 'forbidden');
      expectError(await call(method, path, body, tokens['suspended']), 403, 'account_locked');
    }
    expectError(await call('GET', ROOT, undefined, tokens['refresh']), 401, 'unauthorized');
    expectError(await call('GET', ROOT, undefined, 'bad-token'), 401, 'unauthorized');
  });

  it('reuses login/refresh and rejects a live token after suspension', async () => {
    const refresh = await call(
      'POST',
      '/api/auth/v1/refresh',
      { refresh_token: tokens['refresh'] },
      null,
    );
    expect(refresh.status).toBe(200);
    expect((await call('GET', ROOT, undefined, refresh.body.access_token)).status).toBe(200);
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [ids['admin']]);
    try {
      expectError(await call('GET', ROOT), 403, 'account_locked');
    } finally {
      await q("UPDATE users SET account_status='active' WHERE id=$1", [ids['admin']]);
    }
  });

  it('405 with exact Allow and no delete route', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, ROOT, {});
      expectError(r, 405, 'method_not_allowed');
      expect(r.headers.get('allow')).toBe('GET, POST, OPTIONS');
    }
    const r = await call('DELETE', ROOT + '/1');
    expectError(r, 405, 'method_not_allowed');
    expect(r.headers.get('allow')).toBe('PATCH, OPTIONS');
  });

  it.each(['0', '-1', '01', '1.0', '9223372036854775808', 'abc', '1/extra', '%31', ''])(
    'rejects malformed card path %s after auth',
    async (value) => {
      expectError(await call('PATCH', ROOT + '/' + value, { status: 'blocked' }), 400);
    },
  );

  it.each([
    'x=1',
    'page=0',
    'page=10001',
    'page=1.5',
    'page=',
    'page_size=101',
    'page_size=0',
    'status=no',
    'card_kind=wallet',
    'driver_id=0',
    'driver_id=9223372036854775808',
    'q=',
    'q=' + 'X'.repeat(21),
    'page=1&page=2',
    'q=a&q=b',
  ])('rejects invalid or duplicate query %s', async (query) => {
    expectError(await call('GET', ROOT + '?' + query), 400);
  });

  it.each([
    {},
    { card_identifier: '' },
    { card_identifier: '  ' },
    { card_identifier: 'X'.repeat(21) },
    { card_identifier: 'abc\n' },
    { card_identifier: '\u0000' },
    { card_identifier: '\ud800' },
    { card_identifier: 123 },
    { card_kind: 'wallet' },
    { driver_id: 1 },
    { driver_id: '0' },
    { driver_id: '9223372036854775808' },
    { status: 'active' },
    { unknown: true },
  ])('rejects registration input %j', async (input) => {
    const body = Object.keys(input).length
      ? { card_identifier: uid(), card_kind: 'online', ...input }
      : input;
    expectError(await call('POST', ROOT, body), 400);
  });

  it('rejects JSON/media errors, GET bodies, extra mutation query and oversized body', async () => {
    for (const text of ['{', '[]', 'null', '1']) expectError(await raw('POST', ROOT, text), 400);
    expectError(await raw('POST', ROOT, '{}', 'text/plain'), 415, 'unsupported_media_type');
    expectError(
      await raw('POST', ROOT, JSON.stringify({ padding: 'X'.repeat(17000) })),
      413,
      'payload_too_large',
    );
    expectError(await raw('GET', ROOT, '{}'), 400);
    expectError(
      await call('POST', ROOT + '?q=a', { card_identifier: uid(), card_kind: 'online' }),
      400,
    );
    const card = await register();
    expectError(await call('PATCH', ROOT + '/' + card.id + '?q=a', { status: 'blocked' }), 400);
  });

  it('preserves reader digits/leading zeros and registers distinct decimal/hex-like UIDs', async () => {
    for (const value of [
      '00001234',
      '1234',
      '0010',
      '10',
      '0A',
      '00000000000000000000',
      'ABCDEF12345678901234',
    ]) {
      const card = await register({ card_identifier: value });
      expect(card).toMatchObject({ card_identifier: value, status: 'unlinked', driver: null });
      expect(card.id).toMatch(/^[1-9][0-9]*$/);
      expect(card.issued_at).toMatch(/Z$/);
      expect(card.updated_at).toMatch(/Z$/);
    }
  });

  it('returns 409 for duplicate registration, including a database race', async () => {
    const identifier = uid();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('POST', ROOT, { card_identifier: identifier, card_kind: 'online' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201))
      expectError(r, 409, 'card_already_registered');
    expect(
      (
        await q('SELECT count(*)::int AS n FROM rfid_cards WHERE card_identifier=$1', [identifier])
      )[0].n,
    ).toBe(1);
  });

  it('keeps bigint IDs exact through registration, linking, filtering and response', async () => {
    const card = await register({ driver_id: BIG });
    expect(card.driver).toEqual({ id: BIG, email: 'big@t146.invalid', full_name: 'big' });
    const r = await call('GET', ROOT + '?driver_id=' + BIG);
    expect(r.body.items.map((v: any) => v.id)).toContain(card.id);
    expect((await patch(card, { driver_id: null })).body.status).toBe('unlinked');
    expect((await patch(card, { driver_id: BIG })).body.driver.id).toBe(BIG);
  });

  it('404 missing drivers/users and rollback without mutating the card', async () => {
    for (const driver_id of ['9223372036854775807', ids['admin']]) {
      const identifier = uid();
      expectError(
        await call('POST', ROOT, { card_identifier: identifier, card_kind: 'online', driver_id }),
        404,
        'driver_not_found',
      );
      expect(
        await q('SELECT id FROM rfid_cards WHERE card_identifier=$1', [identifier]),
      ).toHaveLength(0);
    }
    const card = await register({ driver_id: ids['owner'] });
    expectError(
      await patch(card, { driver_id: ids['admin'], status: 'blocked' }),
      404,
      'driver_not_found',
    );
    const stored = (
      await q('SELECT driver_id::text,status,updated_at FROM rfid_cards WHERE id=$1', [card.id])
    )[0];
    expect(stored.driver_id).toBe(ids['owner']);
    expect(stored.status).toBe('active');
    expect(stored.updated_at.toISOString()).toBe(card.updated_at);
    expectError(
      await call('PATCH', ROOT + '/9223372036854775807', { status: 'blocked' }),
      404,
      'not_found',
    );
  });

  it('link/unlink/block/unblock transitions preserve issued_at and do not implicitly unblock', async () => {
    const card = await register();
    expectError(await patch(card, { status: 'active' }), 400);
    let r = await patch(card, { driver_id: ids['owner'] });
    expect(r.body.status).toBe('active');
    expect(r.body.driver.id).toBe(ids['owner']);
    expect(r.body.issued_at).toBe(card.issued_at);
    expect(Date.parse(r.body.updated_at)).toBeGreaterThanOrEqual(Date.parse(card.updated_at));
    expect((await patch(card, { status: 'blocked' })).body.status).toBe('blocked');
    expect((await patch(card, { driver_id: ids['other'] })).body.status).toBe('blocked');
    r = await patch(card, { driver_id: null });
    expect(r.body).toMatchObject({ status: 'blocked', driver: null });
    expectError(await patch(card, { status: 'active' }), 400);
    r = await patch(card, { driver_id: ids['owner'], status: 'active' });
    expect(r.body.status).toBe('active');
    expectError(await patch(card, { driver_id: null, status: 'active' }), 400);
    expect((await patch(card, { driver_id: null })).body).toMatchObject({
      status: 'unlinked',
      driver: null,
    });
    for (const body of [
      {},
      { status: 'unlinked' },
      { card_kind: 'free_vend' },
      { card_identifier: uid() },
      { driver_id: 1 },
      { extra: 1 },
    ])
      expectError(await patch(card, body), 400);
  });

  it('free_vend is active without a driver and never permits a driver link', async () => {
    const card = await register({ card_kind: 'free_vend' });
    expect(card).toMatchObject({ card_kind: 'free_vend', status: 'active', driver: null });
    expect(await svc.authorize(card.card_identifier)).toBe('Accepted');
    expectError(
      await call('POST', ROOT, {
        card_identifier: uid(),
        card_kind: 'free_vend',
        driver_id: ids['owner'],
      }),
      409,
      'card_kind_has_no_driver',
    );
    expectError(await patch(card, { driver_id: ids['owner'] }), 409, 'card_kind_has_no_driver');
    expect((await patch(card, { status: 'blocked' })).body.status).toBe('blocked');
    expect((await patch(card, { driver_id: null })).body.status).toBe('blocked');
    expect((await patch(card, { status: 'active' })).body.status).toBe('active');
  });

  it('lists combined filters, deterministic pages and literal prefix wildcards', async () => {
    const prefix = 'P146-';
    const a = await register({ card_identifier: prefix + 'A', driver_id: ids['owner'] });
    const b = await register({ card_identifier: prefix + 'B' });
    const c = await register({ card_identifier: prefix + 'C', card_kind: 'free_vend' });
    const all = await call('GET', ROOT + '?q=' + prefix);
    expect(all.body).toMatchObject({ total: 3, page: 1, page_size: 50 });
    expect(all.headers.get('cache-control')).toBe('no-store');
    expect(all.body.items.map((v: any) => v.id)).toEqual([c.id, b.id, a.id]);
    for (let page = 1; page <= 4; page++) {
      const r = await call('GET', ROOT + `?q=${prefix}&page_size=1&page=${page}`);
      expect(r.body.total).toBe(3);
      expect(r.body.items.map((v: any) => v.id)).toEqual(
        page <= 3 ? [all.body.items[page - 1].id] : [],
      );
    }
    expect(
      (
        await call(
          'GET',
          ROOT + `?q=${prefix}&card_kind=online&status=active&driver_id=${ids['owner']}`,
        )
      ).body.items.map((v: any) => v.id),
    ).toEqual([a.id]);
    expect(
      (await call('GET', ROOT + '?q=' + prefix + '&status=unlinked')).body.items.map(
        (v: any) => v.id,
      ),
    ).toEqual([b.id]);
    for (const literal of ['L146%', 'L146_', 'L146\\', "L146'OR1=1"]) {
      const literalCard = await register({ card_identifier: literal + 'X' });
      await register({ card_identifier: literal.replace(/[%_\\']/g, 'Z') + uid() });
      const r = await call('GET', ROOT + '?q=' + encodeURIComponent(literal));
      expect(r.body.items.map((v: any) => v.id)).toEqual([literalCard.id]);
    }
    expect((await call('GET', ROOT + '?q=DOES-NOT-EXIST')).body.total).toBe(0);
  });

  it('serializes concurrent blocking and reassignment without losing either update', async () => {
    const card = await register({ driver_id: ids['owner'] });
    const results = await Promise.all([
      patch(card, { status: 'blocked' }),
      patch(card, { driver_id: ids['other'] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const row = (
      await q('SELECT status,driver_id::text AS driver_id FROM rfid_cards WHERE id=$1', [card.id])
    )[0];
    expect(row).toMatchObject({ status: 'blocked', driver_id: ids['other'] });
  });

  it('keeps list count/items consistent during concurrent registrations', async () => {
    const writes = Array.from({ length: 8 }, (_, n) =>
      register({ card_identifier: 'SNAP146-' + n }),
    );
    const reads = Array.from({ length: 8 }, () => call('GET', ROOT + '?q=SNAP146-'));
    const results = await Promise.all(reads);
    await Promise.all(writes);
    for (const r of results) expect(r.body.total).toBe(r.body.items.length);
    expect((await call('GET', ROOT + '?q=SNAP146-')).body.total).toBe(8);
  });

  it('Authorize reflects admin changes; an already active session keeps its captured owner and no stop/billing side effects', async () => {
    const card = await register({ driver_id: ids['owner'] });
    expect(await svc.authorize(card.card_identifier)).toBe('Accepted');
    const cp = (
      await q(
        "INSERT INTO charge_points(serial_number,lifecycle) VALUES('T146-CP','in_service') RETURNING id",
      )
    )[0].id;
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1)', [cp]);
    const at = new Date();
    const context: InboundContext = {
      identity: 'T146-CP',
      chargePointId: Number(cp),
      epoch: 1,
      epochOpenedAt: at,
      receivedAt: at,
      cpTimestamp: at,
      messageId: 't146-start',
      messageLogId: 1,
      replay: { replayed: false, reason: null, skewS: 0 },
    };
    const started = await svc.onStartTransaction(
      {
        connectorId: 1,
        idTag: card.card_identifier,
        meterStart: 1000,
        timestamp: at.toISOString(),
      },
      context,
    );
    const before = (
      await q('SELECT * FROM sessions WHERE transaction_no=$1', [started.transactionId])
    )[0];
    expect(before).toMatchObject({
      driver_id: ids['owner'],
      status: 'active',
      payment_mode: 'csms_billed',
    });
    const tables = [
      'remote_commands',
      'credit_transactions',
      'loyalty_transactions',
      'charging_statements',
      'session_status_history',
    ];
    const counts = async () =>
      Promise.all(
        tables.map(async (table) => (await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n),
      );
    const initialCounts = await counts();
    const initialHold = await q('SELECT * FROM rfid_credit_holds WHERE session_id=$1', [before.id]);
    await patch(card, { driver_id: ids['other'] });
    await patch(card, { status: 'blocked' });
    expect(await svc.authorize(card.card_identifier)).toBe('Blocked');
    await patch(card, { driver_id: null });
    expect(await svc.authorize(card.card_identifier)).toBe('Blocked');
    await patch(card, { driver_id: ids['owner'], status: 'active' });
    // WP3: this physical Start lacks a verified epoch; its captured debt blocks a new authorization.
    expect(await svc.authorize(card.card_identifier)).toBe('Blocked');
    await patch(card, { driver_id: null });
    expect(await svc.authorize(card.card_identifier)).toBe('Invalid');
    expect(
      (await q('SELECT * FROM sessions WHERE transaction_no=$1', [started.transactionId]))[0],
    ).toEqual(before);
    expect(await counts()).toEqual(initialCounts);
    expect(await q('SELECT * FROM rfid_credit_holds WHERE session_id=$1', [before.id])).toEqual(
      initialHold,
    );
  });

  it('never logs credentials or JWTs', () => {
    expect(logs.join('\n')).not.toContain(password);
    for (const value of Object.values(tokens)) expect(logs.join('\n')).not.toContain(value);
  });
});
