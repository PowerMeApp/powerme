import { createServer, request, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { createDb, type Db } from '../src/db/db.module.js';
import { createDriverListener } from '../src/driver/driver.http.js';
import type { DriverApiConfig } from '../src/driver/driver-auth.js';
import { RoadDiscovery } from '../src/driver/road-discovery.js';
import { VietmapAdapter } from '../src/driver/vietmap.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { loadConfig } from '../src/config.js';
import { migrate } from './helpers/apply-migrations.js';
import { addRoadSite, seedRoadFixture } from './helpers/discovery-fixture.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const endpoints = ['me', 'stations', 'connector', 'autocomplete', 'place', 'route'] as const;
type Endpoint = (typeof endpoints)[number];

(url ? describe : describe.skip)('MB03 brief smart search and per-endpoint risk matrix', () => {
  let db: Db, server: Server, base: string, token: string;
  let fixture: Awaited<ReturnType<typeof seedRoadFixture>>;
  let calls = 0;
  let fault = '';
  const secret = randomBytes(32);
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;
  const address = {
    ref_id: 'auto:test',
    display: 'Synthetic',
    name: 'Synthetic',
    address: 'Synthetic',
  };
  const paths = (kind: Endpoint) =>
    ({
      me: '/me',
      stations: `/stations?vehicle_id=${fixture.vehicle}`,
      connector: `/connectors/by-code/ROAD0/1?vehicle_id=${fixture.vehicle}`,
      autocomplete: `/places/autocomplete?vehicle_id=${fixture.vehicle}&location_consent=true&q=Synthetic`,
      place: `/places/resolve?vehicle_id=${fixture.vehicle}&location_consent=true&ref_id=auto:test`,
      route: `/stations/${fixture.sites[0]!.id}/route?vehicle_id=${fixture.vehicle}&location_consent=true&latitude=0&longitude=0`,
    })[kind];
  const search = (extra = '') =>
    `/stations?vehicle_id=${fixture.vehicle}&latitude=0&longitude=0${extra}`;
  async function jwt(overrides: JWTPayload = {}, alg = 'HS256', key = secret) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: fixture.driver,
      role: 'driver',
      iss: 'smart-test',
      aud: 'driver-test',
      iat: now,
      exp: now + 600,
      ...overrides,
    })
      .setProtectedHeader({ alg, typ: 'JWT' })
      .sign(key);
  }
  async function get(path: string, auth: string | null = token, method = 'GET', extra = {}) {
    const r = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...extra },
    });
    return {
      status: r.status,
      headers: r.headers,
      body: r.status === 204 ? null : ((await r.json()) as any),
    };
  }
  async function distance(index: number, km: number) {
    await q('UPDATE sites SET latitude=0,longitude=$2 WHERE id=$1', [
      fixture.sites[index]!.id,
      ((km / 6371) * 180) / Math.PI,
    ]);
  }
  const network: typeof fetch = async (input, options) => {
    calls++;
    const u = new URL(String(input));
    expect(options?.redirect).toBe('error');
    if (/^\d+$/.test(fault))
      return new Response('synthetic-private-key', { status: Number(fault) });
    if (fault === 'network') throw new Error('synthetic-private-key in URL');
    if (fault === 'timeout')
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new Error('synthetic-private-key')),
        ),
      );
    if (fault === 'json') return new Response('{broken');
    if (fault === 'oversize') return new Response('x'.repeat(524289));
    if (fault === 'schema') return Response.json({ unknown: true });
    if (u.pathname.endsWith('/autocomplete/v4')) return Response.json([address]);
    if (u.pathname.endsWith('/place/v4'))
      return Response.json({ ...address, lat: fault === 'nullcoords' ? null : 0, lng: 0 });
    if (fault === 'no_route') return Response.json({ code: 'ZERO_RESULTS' });
    return Response.json({
      code: 'OK',
      paths: [
        {
          distance: 1234,
          time: 49999,
          points_encoded: false,
          points: {
            type: 'LineString',
            coordinates:
              fault === 'geometry'
                ? [
                    [0, 91],
                    [1, 1],
                  ]
                : [
                    [0, 0],
                    [0.1, 0],
                  ],
          },
        },
      ],
    });
  };
  beforeAll(async () => {
    if (
      !url ||
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw new Error('Dedicated new loopback database required');
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS t"))[0]?.t)
      throw new Error('Never reset existing DB');
    await migrate(db.$client);
    fixture = await seedRoadFixture(db);
    const config = loadConfig({ DATABASE_URL: url });
    const policy = loadChargePolicy({});
    const service = new DriverChargingService(
      db,
      new ConnectionRegistry(db),
      new ChargeSettlementService(db, policy),
      policy,
      config,
    );
    token = await jwt();
    server = createServer((req, res) => listener(req, res));
    let listener = createDriverListener(
      db,
      service,
      { devAuth: false, secret, issuer: 'smart-test', audience: 'driver-test' },
      new RoadDiscovery(db, new VietmapAdapter('synthetic-private-key', network, 30)),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Missing bound port');
    base = `http://127.0.0.1:${bound.port}`;
    resetListener = (overrides = {}) => {
      listener = createDriverListener(
        db,
        service,
        { devAuth: false, secret, issuer: 'smart-test', audience: 'driver-test', ...overrides },
        new RoadDiscovery(db, new VietmapAdapter('synthetic-private-key', network, 30)),
      );
    };
  });
  let resetListener: (overrides?: Partial<DriverApiConfig>) => void;
  beforeEach(async () => {
    calls = 0;
    fault = '';
    resetListener();
    await q(
      "UPDATE vehicle_models SET connector_type='ccs2',battery_capacity_kwh=87,rated_range_km=300,max_dc_kw=120 WHERE id=$1",
      [fixture.model],
    );
    for (let i = 0; i < 3; i++) {
      const s = fixture.sites[i]!;
      await distance(i, [4, 9, 14][i]!);
      await q('UPDATE sites SET vinfast_only=false WHERE id=$1', [s.id]);
      await q(
        "UPDATE charge_points SET is_online=true,last_message_at=now(),online_changed_at=now()-interval '1 minute',rated_power_kw=120 WHERE id=$1",
        [s.cp],
      );
      await q(
        "UPDATE connectors SET connector_type='ccs2',status='Available',status_changed_at=now(),max_power_kw=$2 WHERE id=$1",
        [s.connector, [30, 120, 60][i]],
      );
      await q(
        "UPDATE tariff_periods SET price_per_kwh_vnd=5000,effective_from='2000-01-01',effective_to=NULL WHERE operator_id=$1",
        [s.operator],
      );
    }
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.$client.end();
  });

  it('B6.1 no SoC preserves legacy distance search with no_soc', async () => {
    const a = await get(search());
    expect(a.status).toBe(200);
    expect(a.body.smart_unavailable_reason).toBe('no_soc');
    expect(a.body.estimate).toBeNull();
    expect(a.body.items.map((s: any) => s.site_id)).toEqual(fixture.sites.map((s) => s.id));
    expect(a.body.items[0].est_total_min).toBeNull();
    expect((await get(search('&target_soc_percent=70'))).status).toBe(200);
  });
  it('B6.2 labels road 20/30/40 km ok tight risky with one 0.75 range factor', async () => {
    for (let i = 0; i < 3; i++) await distance(i, [20, 30, 40][i]! / 1.3);
    const a = await get(search('&soc_percent=15'));
    expect(a.body.estimate.est_range_km).toBeCloseTo(33.75);
    expect(a.body.items.map((s: any) => s.reach)).toEqual(['ok', 'tight', 'risky']);
  });
  it('B6.3 farther free 120 kW beats nearby busy 30 kW by total completion time', async () => {
    await q("UPDATE connectors SET status='Charging' WHERE id=$1", [fixture.sites[0]!.connector]);
    const a = await get(search('&soc_percent=15'));
    expect(a.body.items[0].site_id).toBe(fixture.sites[1]!.id);
    const slow = a.body.items.find((s: any) => s.site_id === fixture.sites[0]!.id);
    expect(slow.est_wait_min).toBe(30);
    expect(a.body.items[0].est_wait_min).toBe(0);
    expect(a.body.items[0].est_energy_kwh).toBeCloseTo(56.55);
  });
  it('B6.4 missing capacity or range falls back to legacy distance ordering', async () => {
    for (const field of ['battery_capacity_kwh', 'rated_range_km']) {
      await q('UPDATE vehicle_models SET battery_capacity_kwh=87,rated_range_km=300 WHERE id=$1', [
        fixture.model,
      ]);
      await q(`UPDATE vehicle_models SET ${field}=NULL WHERE id=$1`, [fixture.model]);
      const a = await get(search('&soc_percent=15'));
      expect(a.body.smart_unavailable_reason).toBe('missing_vehicle_specs');
      expect(a.body.items[0].site_id).toBe(fixture.sites[0]!.id);
      expect(a.body.estimate).toBeNull();
    }
  });
  it('B6.5 all risky and zero SoC keep a bounded nearest fallback; explicit radius stays exact', async () => {
    for (const soc of ['0', '0.001']) {
      const a = await get(search(`&soc_percent=${soc}`));
      expect(a.status).toBe(200);
      expect(a.body.items).toHaveLength(3);
      expect(a.body.items.every((s: any) => s.reach === 'risky')).toBe(true);
      expect((await get(search(`&soc_percent=${soc}&radius_km=1`))).body.items).toEqual([]);
    }
  });
  it.each(['90', '-1', '80', 'NaN', 'Infinity', '1e3', ''])(
    'B6.6 rejects invalid SoC %s with invalid_search',
    async (soc) => {
      const a = await get(search(`&soc_percent=${soc}`));
      expect(a.status).toBe(400);
      expect(a.body.error).toBe('invalid_search');
    },
  );
  it('B6.7 vehicle max DC caps 120 kW connector to 50 kW', async () => {
    await q('UPDATE vehicle_models SET max_dc_kw=50 WHERE id=$1', [fixture.model]);
    const a = await get(search('&soc_percent=15'));
    const s = a.body.items.find((s: any) => s.site_id === fixture.sites[1]!.id);
    expect(s.est_charge_min).toBeCloseTo((56.55 / (50 * 0.85)) * 60);
  });
  it('accepts 79.99 SoC and validates optional target even without SoC', async () => {
    expect((await get(search('&soc_percent=79.99'))).status).toBe(200);
    for (const extra of [
      '&soc_percent=20&target_soc_percent=20',
      '&soc_percent=20&target_soc_percent=19',
      '&target_soc_percent=81',
      '&target_soc_percent=0',
      '&target_soc_percent=NaN',
      '&target_soc_percent=Infinity',
    ])
      expect((await get(search(extra))).body.error).toBe('invalid_search');
  });
  it('missing GPS smart fallback sorts by name; explicit distance without GPS remains invalid', async () => {
    const a = await get(paths('stations') + '&soc_percent=15&sort=smart');
    expect(a.status).toBe(200);
    expect(a.body.smart_unavailable_reason).toBe('no_location');
    expect(a.body.items.every((s: any) => s.distance_m === null && s.reach === null)).toBe(true);
    expect((await get(paths('stations') + '&sort=distance')).body.error).toBe('invalid_search');
  });
  it('connector null power falls back to pillar; missing max DC is allowed; all absent power stays unknown', async () => {
    await q('UPDATE vehicle_models SET max_dc_kw=NULL WHERE id=$1', [fixture.model]);
    const s = fixture.sites[1]!;
    await q('UPDATE connectors SET max_power_kw=NULL WHERE id=$1', [s.connector]);
    let a = await get(search('&soc_percent=15'));
    expect(a.body.items.find((x: any) => x.site_id === s.id).est_charge_min).toBeCloseTo(
      (56.55 / (120 * 0.85)) * 60,
    );
    await q('UPDATE charge_points SET rated_power_kw=NULL WHERE id=$1', [s.cp]);
    a = await get(search('&soc_percent=15'));
    expect(a.body.items.at(-1)).toMatchObject({
      site_id: s.id,
      est_charge_min: null,
      est_total_min: null,
    });
  });
  it('uses compatible connector with minimum total time rather than earliest free connector', async () => {
    const s = fixture.sites[0]!;
    await q("UPDATE connectors SET status='Charging',max_power_kw=120 WHERE id=$1", [s.connector]);
    const second = (
      await q(
        "INSERT INTO connectors(charge_point_id,connector_no,max_power_kw,status,status_changed_at) VALUES($1,2,10,'Available',now()) RETURNING id",
        [s.cp],
      )
    )[0]!.id;
    try {
      const a = await get(search('&soc_percent=15'));
      expect(a.body.items.find((x: any) => x.site_id === s.id).best_connector_id).toBe(s.connector);
    } finally {
      await q('DELETE FROM connectors WHERE id=$1', [second]);
    }
  });
  it('smart ranking precedes pagination and stable ties have no duplicate or missing sites', async () => {
    for (let i = 0; i < 3; i++) {
      await distance(i, 9);
      await q('UPDATE connectors SET max_power_kw=120 WHERE id=$1', [fixture.sites[i]!.connector]);
    }
    const all = (await get(search('&soc_percent=15'))).body.items.map((s: any) => s.site_id);
    const pages = [];
    for (let page = 1; page <= 3; page++)
      pages.push(
        (await get(search(`&soc_percent=15&page_size=1&page=${page}`))).body.items[0].site_id,
      );
    expect(pages).toEqual(all);
    expect(new Set(pages).size).toBe(3);
    expect((await get(search('&soc_percent=15&page=4&page_size=1'))).body.items).toEqual([]);
    expect((await get(search('&soc_percent=15&sort=distance'))).body.items[0].site_id).toBe(
      fixture.sites[0]!.id,
    );
    expect(
      (await get(search('&soc_percent=15&sort=name'))).body.items.map((s: any) => s.site_id),
    ).toEqual(fixture.sites.map((s) => s.id));
  });
  it('unknown offline unavailable sort last without estimates; freeing soon waits five minutes', async () => {
    await q('UPDATE connectors SET status_changed_at=NULL WHERE id=$1', [
      fixture.sites[0]!.connector,
    ]);
    await q("UPDATE connectors SET status='Finishing' WHERE id=$1", [fixture.sites[1]!.connector]);
    await q('UPDATE charge_points SET is_online=false WHERE id=$1', [fixture.sites[2]!.cp]);
    const a = await get(search('&soc_percent=15'));
    expect(a.body.items[0]).toMatchObject({ site_id: fixture.sites[1]!.id, est_wait_min: 5 });
    for (const s of a.body.items.slice(1))
      expect(s).toMatchObject({ est_total_min: null, est_energy_kwh: null, est_wait_min: null });
    expect(
      a.body.items
        .slice(1)
        .flatMap((s: any) => s.connectors)
        .every((c: any) => !c.available_now),
    ).toBe(true);
    await q("UPDATE connectors SET status='Unavailable' WHERE id=$1", [
      fixture.sites[0]!.connector,
    ]);
    expect(
      (await get(search('&soc_percent=15'))).body.items.find(
        (s: any) => s.site_id === fixture.sites[0]!.id,
      ).est_charge_min,
    ).toBeNull();
  });
  it('implicit nearest fallback considers usable fourth station before closer offline stations', async () => {
    for (const s of fixture.sites)
      await q('UPDATE charge_points SET is_online=false WHERE id=$1', [s.cp]);
    const extra = await addRoadSite(db, 4);
    await q('UPDATE sites SET latitude=0,longitude=1 WHERE id=$1', [extra.id]);
    const a = await get(search('&soc_percent=0'));
    expect(a.body.items[0].site_id).toBe(extra.id);
    await q("UPDATE charge_points SET lifecycle='disabled' WHERE id=$1", [extra.cp]);
  });
  it('cost uses current ICT effective maximum tariff; zero is distinct from missing and unsafe bigint', async () => {
    const op = fixture.sites[1]!.operator;
    await q('UPDATE tariff_periods SET price_per_kwh_vnd=0 WHERE operator_id=$1', [op]);
    const cost = async () =>
      (await get(search('&soc_percent=15'))).body.items.find((s: any) => s.operator_id === op)
        .est_cost_vnd_max;
    expect(await cost()).toBe(0);
    await q(
      "UPDATE tariff_periods SET effective_to=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-1 WHERE operator_id=$1",
      [op],
    );
    expect(await cost()).toBeNull();
    await q(
      "UPDATE tariff_periods SET effective_from=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+1,effective_to=NULL WHERE operator_id=$1",
      [op],
    );
    expect(await cost()).toBeNull();
    await q(
      "UPDATE tariff_periods SET effective_from=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,effective_to=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,price_per_kwh_vnd=6001 WHERE operator_id=$1",
      [op],
    );
    expect(await cost()).toBe(Math.ceil(56.55 * 6001));
    await q('UPDATE tariff_periods SET price_per_kwh_vnd=9007199254740993 WHERE operator_id=$1', [
      op,
    ]);
    expect(await cost()).toBeNull();
  });
  it('empty text matches and SQL metacharacters stay literal; invalid pagination and partial GPS fail', async () => {
    expect((await get(search('&q=%27%20OR%201%3D1--'))).body.total).toBe(0);
    expect((await get(search('&q=%25'))).body.total).toBe(0);
    for (const extra of [
      '&page=0',
      '&page=100001',
      '&page_size=101',
      '&radius_km=0',
      '&latitude=91',
      '&longitude=181',
    ])
      expect((await get(search(extra))).status).toBe(400);
    expect((await get(paths('stations') + '&latitude=0')).status).toBe(400);
    for (const point of ['latitude=-90&longitude=-180', 'latitude=90&longitude=180'])
      expect((await get(paths('stations') + '&' + point)).status).toBe(200);
  });
  it('retired advanced suggestions route returns 404', async () => {
    expect((await get('/stations/suggestions?vehicle_id=' + fixture.vehicle)).status).toBe(404);
  });

  it('missing JWT configuration fails unavailable and internal DB faults are sanitized', async () => {
    resetListener({ secret: undefined });
    expect(await get(paths('stations'))).toMatchObject({
      status: 503,
      body: { error: 'auth_unavailable' },
    });
    resetListener();
    const query = jest.spyOn(db.$client, 'query').mockImplementationOnce(() => {
      throw new Error('synthetic-private-db-credential');
    });
    try {
      const result = await get(paths('stations'));
      expect(result.status).toBe(500);
      expect(result.body.error).toBe('internal_error');
      expect(JSON.stringify(result.body)).not.toMatch(/synthetic-private|credential|stack/i);
      expect(calls).toBe(0);
    } finally {
      query.mockRestore();
    }
  });

  it('rejects an otherwise valid signed JWT exceeding the 8192-character header bound', async () => {
    const oversized = await jwt({ padding: 'x'.repeat(7000) });
    expect(`Bearer ${oversized}`.length).toBeGreaterThan(8192);
    const result = await get(paths('autocomplete'), oversized);
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toBe('Bearer');
    expect(calls).toBe(0);
  });

  it.each(endpoints)('%s rejects the JWT failure matrix before route execution', async (kind) => {
    const now = Math.floor(Date.now() / 1000);
    const invalid: (string | null)[] = [
      null,
      'bad',
      await jwt({ exp: now - 1 }),
      await jwt({ iss: 'wrong' }),
      await jwt({ aud: 'wrong' }),
      await jwt({ nbf: now + 60 }),
      await jwt({ iat: now + 60 }),
      await jwt({}, 'HS384'),
      await jwt({}, 'HS256', randomBytes(32)),
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`,
    ];
    for (const auth of invalid) expect((await get(paths(kind), auth)).status).toBe(401);
    expect(calls).toBe(0);
  });
  it.each(endpoints)(
    '%s enforces DB role active state methods CORS and duplicate authorization',
    async (kind) => {
      for (const change of ["role='admin'", "account_status='suspended'"]) {
        await q(`UPDATE users SET ${change} WHERE id=$1`, [fixture.driver]);
        try {
          expect((await get(paths(kind))).status).toBe(403);
        } finally {
          await q("UPDATE users SET role='driver',account_status='active' WHERE id=$1", [
            fixture.driver,
          ]);
        }
      }
      expect((await get(paths(kind), token, 'POST')).status).toBe(405);
      expect(
        (await get(paths(kind), token, 'GET', { Origin: 'https://untrusted.invalid' })).status,
      ).toBe(403);
      const preflight = await get(paths(kind), null, 'OPTIONS', {
        Origin: 'http://localhost:4200',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:4200');
      const code = await new Promise<number>((resolve) => {
        const r = request(
          `${base}/api/driver/v1${paths(kind)}`,
          {
            headers: [
              'Host',
              new URL(base).host,
              'Authorization',
              `Bearer ${token}`,
              'Authorization',
              `Bearer ${token}`,
            ],
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        r.end();
      });
      expect(code).toBe(401);
      expect(calls).toBe(0);
    },
  );
  it.each(endpoints)('%s rejects unknown repeated or malformed query input', async (kind) => {
    const path = paths(kind),
      sep = path.includes('?') ? '&' : '?';
    expect((await get(path + sep + 'unexpected=1')).status).toBe(400);
    if (kind !== 'me') {
      expect((await get(path + '&vehicle_id=' + fixture.vehicle)).status).toBe(400);
      for (const id of ['0', '01', '-1', '1e3', '9223372036854775808'])
        expect(
          (await get(path.replace(`vehicle_id=${fixture.vehicle}`, `vehicle_id=${id}`))).status,
        ).toBe(400);
    }
  });
  it.each(endpoints.filter((e) => e !== 'me'))(
    '%s rejects other-owned and nonexistent vehicles before provider cache hits',
    async (kind) => {
      expect((await get(paths(kind))).status).toBe(200);
      const count = calls;
      for (const id of [fixture.otherVehicle, '9223372036854775807'])
        expect(
          (await get(paths(kind).replace(`vehicle_id=${fixture.vehicle}`, `vehicle_id=${id}`)))
            .status,
        ).toBe(404);
      expect(calls).toBe(count);
    },
  );
  it('me returns no private fields and an empty vehicle list for an owned vehicle-free driver', async () => {
    const a = await get('/me', await jwt({ sub: fixture.other }));
    expect(Object.keys(a.body).sort()).toEqual([
      'account_status',
      'full_name',
      'role',
      'user_id',
      'vehicles',
    ]);
    const empty = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('empty@example.invalid','Empty','driver') RETURNING id",
      )
    )[0]!.id;
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'synthetic',now())",
      [empty],
    );
    expect((await get('/me', await jwt({ sub: empty }))).body.vehicles).toEqual([]);
  });
  it('connector rejects bad reference encoding and incompatible vehicles', async () => {
    for (const code of ['bad%2Fcode', 'bad%5Ccode', 'bad%00code', 'bad%ZZ'])
      expect((await get(paths('connector').replace('ROAD0', code))).status).toBe(400);
    for (const no of ['0', '3', '01'])
      expect((await get(paths('connector').replace('/1?', `/${no}?`))).status).toBe(400);
    await q("UPDATE vehicle_models SET connector_type='chademo' WHERE id=$1", [fixture.model]);
    expect((await get(paths('connector'))).status).toBe(404);
    expect((await get(paths('route'))).status).toBe(404);
    expect((await get(search('&soc_percent=15'))).body.items).toEqual([]);
    await q("UPDATE vehicle_models SET connector_type='ccs2' WHERE id=$1", [fixture.model]);
  });
  it('address endpoints validate consent text focus and reference format', async () => {
    for (const text of ['', 'x', '%00x', 'x'.repeat(121)])
      expect((await get(paths('autocomplete').replace('q=Synthetic', `q=${text}`))).status).toBe(
        400,
      );
    for (const kind of ['autocomplete', 'place', 'route'] as const)
      expect(
        (await get(paths(kind).replace('location_consent=true', 'location_consent=false'))).status,
      ).toBe(400);
    expect((await get(paths('autocomplete') + '&latitude=0')).status).toBe(400);
    expect((await get(paths('autocomplete') + '&latitude=0&longitude=0')).status).toBe(200);
    for (const ref of ['https://evil.invalid', 'auto:', 'auto:%00'])
      expect((await get(paths('place').replace('auto:test', ref))).status).toBe(400);
  });
  it.each(['autocomplete', 'place', 'route'] as const)(
    '%s sanitizes provider faults and never caches failed responses',
    async (kind) => {
      for (const failure of [
        '401',
        '403',
        '423',
        '429',
        '500',
        'network',
        'timeout',
        'json',
        'oversize',
        'schema',
        ...(kind === 'route' ? ['no_route', 'geometry'] : kind === 'place' ? ['nullcoords'] : []),
      ]) {
        fault = failure;
        const before = calls;
        const a = await get(paths(kind));
        expect(a.status).toBe(503);
        expect(JSON.stringify(a.body)).not.toMatch(/synthetic-private-key|https:|apikey/i);
        expect(calls).toBe(before + 1);
      }
      fault = '';
      expect((await get(paths(kind))).status).toBe(200);
    },
  );
  it('route uses canonical DB destination and real road units even when station is offline', async () => {
    await q('UPDATE charge_points SET is_online=false WHERE id=$1', [fixture.sites[0]!.cp]);
    const a = await get(paths('route'));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      distance_m: 1234,
      duration_s: 50,
      quality: 'provider_estimate',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.1, 0],
        ],
      },
    });
    expect((await get(paths('route') + '&destination=https://evil.invalid')).status).toBe(400);
    expect((await get(paths('route').replace('&latitude=0', ''))).status).toBe(400);
    await q('UPDATE sites SET latitude=NULL WHERE id=$1', [fixture.sites[0]!.id]);
    expect((await get(paths('route'))).body.error).toBe('station_location_unavailable');
  });
  it('cached provider responses recheck vehicle and station ownership compatibility and visibility', async () => {
    for (const kind of ['autocomplete', 'place', 'route'] as const) {
      expect((await get(paths(kind))).status).toBe(200);
      expect((await get(paths(kind))).body.cached).toBe(true);
    }
    await q('UPDATE vehicles SET driver_id=$2 WHERE id=$1', [fixture.vehicle, fixture.other]);
    try {
      for (const kind of ['autocomplete', 'place', 'route'] as const)
        expect((await get(paths(kind))).status).toBe(404);
    } finally {
      await q('UPDATE vehicles SET driver_id=$2 WHERE id=$1', [fixture.vehicle, fixture.driver]);
    }
    await q('UPDATE sites SET vinfast_only=true WHERE id=$1', [fixture.sites[0]!.id]);
    expect((await get(paths('route'))).status).toBe(404);
    expect((await get(paths('route') + '&include_vinfast_only=true')).status).toBe(200);
  });
  it('provider miss budget returns Retry-After while cache hits remain available', async () => {
    for (let i = 0; i < 30; i++) expect((await get(paths('autocomplete') + i)).status).toBe(200);
    const a = await get(paths('autocomplete') + 'overflow');
    expect(a.status).toBe(429);
    expect(a.headers.get('retry-after')).toBe('60');
    expect((await get(paths('autocomplete') + '0')).body.cached).toBe(true);
  });
});
