import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { SignJWT, type JWTPayload } from 'jose';
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const driver = '9007199254740993';
const vehicle = '9007199254740994';
const connectorId = '9007199254740995';
const secret = randomBytes(32);
const issuer = 'powerme-mb03-test';
const audience = 'powerme-driver-test';

describeDb('MB03 authenticated Driver discovery over HTTP and dedicated Postgres', () => {
  let db: Db;
  let server: ConsoleServer;
  let config: CsmsConfig;
  let service: DriverChargingService;
  let base: string;
  let otherVehicle: string;
  let other: string;
  let admin: string;
  let noSubtype: string;
  let token: string;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function jwt(overrides: JWTPayload = {}, alg = 'HS256', key: Uint8Array = secret) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: driver,
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
      ...overrides,
    })
      .setProtectedHeader({ alg, typ: 'JWT' })
      .sign(key);
  }
  async function get(
    path: string,
    auth: string | null = token,
    extra: Record<string, string> = {},
    method = 'GET',
  ) {
    const response = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers: { ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }), ...extra },
    });
    const body = response.status === 204 ? null : ((await response.json()) as any);
    return { response, body };
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
    await q(
      "INSERT INTO users(id,email,full_name,role) OVERRIDING SYSTEM VALUE VALUES($1,'mb03-big@example.invalid','MB03 Big Driver','driver')",
      [driver],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'local-test',now())",
      [driver],
    );
    other = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('mb03-other@example.invalid','Other','driver') RETURNING id",
      )
    )[0]!.id;
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'local-test',now())",
      [other],
    );
    admin = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('mb03-admin@example.invalid','Admin','admin') RETURNING id",
      )
    )[0]!.id;
    noSubtype = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('mb03-no-subtype@example.invalid','No subtype','driver') RETURNING id",
      )
    )[0]!.id;
    const model = (
      await q(
        "INSERT INTO vehicle_models(brand,model_name,connector_type) VALUES('Synthetic','MB03 Test','ccs2') RETURNING id",
      )
    )[0]!.id;
    await q(
      "INSERT INTO vehicles(id,driver_id,vehicle_model_id,plate_number,is_default) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'MB03-BIG',true)",
      [vehicle, driver, model],
    );
    otherVehicle = (
      await q(
        "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,'MB03-OTHER') RETURNING id",
        [other, model],
      )
    )[0]!.id;
    const op = (
      await q(
        "INSERT INTO operators(tax_code,legal_name) VALUES('MB03-TEST','MB03 Operator') RETURNING id",
      )
    )[0]!.id;
    for (const [index, name, vinfast] of [
      [0, 'Đông Hòa A', false],
      [1, 'Đông Hòa B', false],
      [2, 'VinFast only', true],
    ] as const) {
      const site = (
        await q(
          'INSERT INTO sites(site_code,operator_id,site_name,vinfast_only,latitude,longitude) VALUES($1,$2,$3,$4,10.888,106.8) RETURNING id',
          [`MB03-${index}`, op, name, vinfast],
        )
      )[0]!.id;
      const cp = (
        await q(
          "INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,is_online,last_message_at,online_changed_at) VALUES($1,$2,$3,'in_service',true,now(),now()-interval '1 minute') RETURNING id",
          [`MB03-${index}`, `PM-MB03-${index}`, site],
        )
      )[0]!.id;
      if (index === 0)
        await q(
          "INSERT INTO connectors(id,charge_point_id,connector_no,status,status_changed_at,max_power_kw) OVERRIDING SYSTEM VALUE VALUES($1,$2,1,'Available',now(),60)",
          [connectorId, cp],
        );
      else
        await q(
          "INSERT INTO connectors(charge_point_id,connector_no,status,status_changed_at) VALUES($1,1,'Available',now())",
          [cp],
        );
      await q(
        "INSERT INTO connectors(charge_point_id,connector_no,connector_type,status) VALUES($1,2,'chademo','Unavailable')",
        [cp],
      );
    }
    config = {
      ...loadConfig({
        DATABASE_URL: url,
        DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
        DRIVER_API_JWT_ISSUER: issuer,
        DRIVER_API_JWT_AUDIENCE: audience,
      }),
      consolePort: 0,
    };
    const registry = new ConnectionRegistry(db);
    const policy = loadChargePolicy({});
    service = new DriverChargingService(
      db,
      registry,
      new ChargeSettlementService(db, policy),
      policy,
    );
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      service,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    token = await jwt();
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('returns DB inventory, lossless IDs, snake_case, numeric units and owned bootstrap', async () => {
    const { response, body } = await get(
      `/stations?vehicle_id=${vehicle}&q=dong%20hoa&page_size=1`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({ total: 2, page: 1, page_size: 1 });
    expect(body.pageSize).toBeUndefined();
    expect(body.items[0]).toMatchObject({
      site_name: 'Đông Hòa A',
      latitude: 10.888,
      longitude: 106.8,
      distance_m: null,
    });
    expect(body.items[0].connectors).toHaveLength(1);
    expect(body.items[0].connectors[0]).toMatchObject({
      connector_id: connectorId,
      max_power_kw: 60,
      available_now: true,
      driver_status: 'available',
      status_quality: 'fresh',
    });
    expect(typeof body.items[0].connectors[0].status_updated_at).toBe('string');
    const me = await get('/me');
    expect(me.body).toMatchObject({
      user_id: driver,
      vehicles: [{ vehicle_id: vehicle, battery_capacity_kwh: null, max_dc_kw: null }],
    });
    expect(JSON.stringify(me.body)).not.toContain(
      otherVehicle === vehicle ? 'never' : 'MB03-OTHER',
    );
    expect(
      (await get(`/connectors/by-code/PM-MB03-0/1?vehicle_id=${vehicle}`)).body.connector_id,
    ).toBe(connectorId);
  });

  it('paginates sites stably, preserves empty pages and uses straight-line distance', async () => {
    expect(
      (await get(`/stations?vehicle_id=${vehicle}&page=2&page_size=1`)).body.items[0].site_name,
    ).toBe('Đông Hòa B');
    expect((await get(`/stations?vehicle_id=${vehicle}&page=20`)).body).toMatchObject({
      items: [],
      total: 2,
    });
    expect(
      (await get(`/stations?vehicle_id=${vehicle}&include_vinfast_only=true`)).body.total,
    ).toBe(3);
    const result = await get(
      `/stations?vehicle_id=${vehicle}&latitude=10.888&longitude=106.8&sort=distance&radius_km=1`,
    );
    expect(result.response.status).toBe(200);
    expect(result.body.items[0].distance_m).toBe(0);
  });

  it('rejects missing/invalid/expired/future/incorrect issuer, audience, algorithm and signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      null,
      'invalid',
      await jwt({ exp: now - 1 }),
      await jwt({ iat: now + 60 }),
      await jwt({ iss: 'wrong' }),
      await jwt({ aud: 'wrong' }),
      await jwt({}, 'HS384', randomBytes(48)),
      await jwt({}, 'HS256', randomBytes(32)),
      await jwt({ exp: undefined }),
      await jwt({ sub: '1e3' }),
      await jwt({ exp: now + 1000 }),
      await jwt({ sub: '9223372036854775807' }),
    ];
    for (const auth of tokens) {
      const result = await get(`/stations?vehicle_id=${vehicle}`, auth);
      expect(result.response.status).toBe(401);
      expect(result.body.error).toBe('unauthorized');
    }
  });

  it('rejects JWT role spoofing, wrong DB role, absent subtype and suspended/closed accounts', async () => {
    for (const claims of [{ role: 'admin' }, { sub: admin }, { sub: noSubtype }])
      expect((await get('/me', await jwt(claims))).response.status).toBe(403);
    for (const status of ['suspended', 'closed']) {
      try {
        await q('UPDATE users SET account_status=$1 WHERE id=$2', [status, driver]);
        expect((await get('/me')).response.status).toBe(403);
      } finally {
        await q("UPDATE users SET account_status='active' WHERE id=$1", [driver]);
      }
    }
  });

  it('does not trust query identity or disabled dev headers, including invalid bearer fallback', async () => {
    expect((await get('/me', null, { 'X-Driver-Id': driver })).response.status).toBe(401);
    expect((await get('/me', 'invalid', { 'X-Driver-Id': driver })).response.status).toBe(401);
    expect((await get(`/stations?vehicle_id=${vehicle}&driver_id=${other}`)).response.status).toBe(
      400,
    );
    expect((await get(`/stations?vehicle_id=${otherVehicle}`)).response.status).toBe(404);
    expect(
      (await get(`/connectors/by-code/PM-MB03-0/1?vehicle_id=${otherVehicle}`)).response.status,
    ).toBe(404);
    expect((await get('/me', await jwt({ sub: other }))).body.vehicles[0].vehicle_id).toBe(
      otherVehicle,
    );
  });

  it.each([
    'page=0',
    'page=1.2',
    'page_size=101',
    'page=100001',
    'latitude=10',
    'latitude=91&longitude=106',
    'radius_km=2',
    'sort=distance',
    'availability=invalid',
    'include_vinfast_only=1',
    'page=1&page=2',
    'page=',
    'page=1e2',
    'page=0x10',
    'q=' + 'a'.repeat(121),
    'q=%00',
    'q=%0A',
  ])('validates %s', async (params) => {
    expect((await get(`/stations?vehicle_id=${vehicle}&${params}`)).response.status).toBe(400);
  });

  it.each([
    'PM%2FMB03/1',
    'PM%5CMB03/1',
    'PM%00MB03/1',
    'PM%0AMB03/1',
    'PM%7FMB03/1',
    'PM%ZZ/1',
    'PM-MB03-0/0',
    'PM-MB03-0/3',
    'PM-MB03-0/1/extra',
  ])('rejects malformed connector path %s', async (path) => {
    expect((await get(`/connectors/by-code/${path}?vehicle_id=${vehicle}`)).response.status).toBe(
      400,
    );
  });

  it('keeps status, freshness and connectivity separate without promising availability', async () => {
    try {
      await q('UPDATE connectors SET status_changed_at=NULL WHERE id=$1', [connectorId]);
      let result = await get(`/stations?vehicle_id=${vehicle}`);
      expect(result.body.items[0].connectors[0]).toMatchObject({
        status_quality: 'unknown',
        driver_status: 'unknown',
        status_updated_at: null,
        available_now: false,
      });
      await q('UPDATE connectors SET status_changed_at=now() WHERE id=$1', [connectorId]);
      await q(
        "UPDATE charge_points SET last_message_at=now()-interval '11 minutes' WHERE display_code='PM-MB03-0'",
      );
      result = await get(`/stations?vehicle_id=${vehicle}`);
      expect(result.body.items[0].connectors[0]).toMatchObject({
        status_quality: 'stale',
        available_now: false,
      });
      await q(
        "UPDATE charge_points SET last_message_at=now()-interval '16 minutes' WHERE display_code='PM-MB03-0'",
      );
      result = await get(`/stations?vehicle_id=${vehicle}`);
      expect(result.body.items[0].connectors[0].driver_status).toBe('offline');
    } finally {
      await q('UPDATE connectors SET status_changed_at=now() WHERE id=$1', [connectorId]);
      await q("UPDATE charge_points SET last_message_at=now() WHERE display_code='PM-MB03-0'");
    }
  });

  it('preserves method, CORS, unknown route and dev-auth boundaries', async () => {
    expect((await get('/me', token, {}, 'POST')).response.status).toBe(405);
    expect((await get('/charges')).response.status).toBe(404);
    expect((await get('/me', token, { Origin: 'https://untrusted.invalid' })).response.status).toBe(
      403,
    );
    const preflight = await get('/stations', null, { Origin: 'http://localhost:3001' }, 'OPTIONS');
    expect(preflight.response.status).toBe(204);
    expect(preflight.response.headers.get('access-control-allow-headers')).toBe('Authorization');
    config.driverApi!.devAuth = true;
    try {
      expect((await get('/me', null, { 'X-Driver-Id': driver })).response.status).toBe(200);
      expect((await get('/me', 'invalid', { 'X-Driver-Id': driver })).response.status).toBe(401);
      expect((await get('/me', null, { 'X-Driver-Id': admin })).response.status).toBe(403);
    } finally {
      config.driverApi!.devAuth = false;
    }
  });

  it('rejects duplicate authorization headers and refuses non-loopback shared listeners', async () => {
    const status = await new Promise<number>((resolve) => {
      const req = request(
        `${base}/api/driver/v1/me`,
        { headers: { Authorization: [`Bearer ${token}`, `Bearer ${token}`] } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    expect(status).toBe(401);
    const registry = new ConnectionRegistry(db);
    const unsafe = new ConsoleServer(
      { ...config, consoleHost: '0.0.0.0' },
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      service,
    );
    await expect(unsafe.start()).rejects.toThrow(/loopback/);
  });

  it('starts on a non-loopback host only with the explicit staging acknowledgement', async () => {
    const registry = new ConnectionRegistry(db);
    const staging = new ConsoleServer(
      { ...config, consoleHost: '0.0.0.0', consolePort: 0, consoleAllowNonLoopback: true },
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      service,
    );
    try {
      await staging.start();
      expect(staging.port).not.toBeNull();
    } finally {
      await staging.stop();
    }
  });
});
