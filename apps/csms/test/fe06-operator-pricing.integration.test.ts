/**
 * FE-06 — screen 24 Pricing & Promotions (UC-OPS-06/07, BR-P02) over real HTTP (ConsoleServer) and
 * Postgres: tariff schedule per Operator (3 bands, full-day coverage, never editing a schedule that
 * has started) and promotion CRUD (stored only, K6). Operator staff only, scoped to their Operator.
 * Needs DATABASE_URL; resets its schema.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe06', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

const SEED = [
  { band: 'off_peak', time_start: '00:00', time_end: '06:00', price_per_kwh_vnd: 2800 },
  { band: 'normal', time_start: '06:00', time_end: '17:00', price_per_kwh_vnd: 3800 },
  { band: 'peak', time_start: '17:00', time_end: '22:00', price_per_kwh_vnd: 5500 },
  { band: 'off_peak', time_start: '22:00', time_end: '24:00', price_per_kwh_vnd: 2800 },
];
const NEW = [
  { band: 'off_peak', time_start: '00:00', time_end: '08:00', price_per_kwh_vnd: 3000 },
  { band: 'peak', time_start: '08:00', time_end: '20:00', price_per_kwh_vnd: 6000 },
  { band: 'normal', time_start: '20:00', time_end: '24:00', price_per_kwh_vnd: 4000 },
];

describeDb('FE-06 operator pricing (screen 24, UC-OPS-06/07)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  let today = '';
  let tomorrow = '';
  let yesterday = '';
  const tokens: Record<string, string> = {};
  const ops: Record<string, string> = {};
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const r = await fetch(`${base}/api/operator/v1${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function staff(email: string, operatorKey: string) {
    const id = (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,'operator_staff',$3)
         RETURNING id::text AS id`,
        [email, email, await hashChargePointPassword(PASSWORD)],
      )
    )[0].id;
    await q(
      "INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'technician')",
      [id, ops[operatorKey]],
    );
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    for (const [key, tax] of [
      ['a', '0400000061'],
      ['b', '0400000062'],
    ] as const)
      ops[key] = String(
        (
          await q('INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id', [
            tax,
            tax,
          ])
        )[0].id,
      );
    for (const p of SEED)
      await q(
        `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
         VALUES($1,$2,$3::time,$4::time,$5,DATE '2026-01-01')`,
        [ops['a'], p.band, p.time_start, p.time_end, p.price_per_kwh_vnd],
      );
    const [d] = await q(
      `SELECT to_char(t,'YYYY-MM-DD') AS today,to_char(t+1,'YYYY-MM-DD') AS tomorrow,
         to_char(t-1,'YYYY-MM-DD') AS yesterday
       FROM (SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS t) x`,
    );
    ({ today, tomorrow, yesterday } = d);
    await staff('a@fe06.test', 'a');
    await staff('b@fe06.test', 'b');
    const admin = (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash) VALUES('admin@fe06.test','A','admin',$1)
         RETURNING id`,
        [await hashChargePointPassword(PASSWORD)],
      )
    )[0].id;
    await q('INSERT INTO admins(user_id) VALUES($1)', [admin]);

    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
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
    for (const [key, email] of [
      ['a', 'a@fe06.test'],
      ['b', 'b@fe06.test'],
      ['admin', 'admin@fe06.test'],
    ] as const) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      tokens[key] = ((await r.json()) as any).access_token;
    }
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  describe('tariffs', () => {
    it('GET shows the schedule in force (24:00 as end of day) and no upcoming one', async () => {
      const r = await call('GET', '/tariffs', tokens['a']);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        current: { effective_from: '2026-01-01', effective_to: null, periods: SEED },
        upcoming: [],
      });
      // Another Operator has no schedule.
      expect((await call('GET', '/tariffs', tokens['b'])).body).toEqual({
        current: null,
        upcoming: [],
      });
    });

    it('400 for a gap, an overlap, a past date or a bad shape; nothing changes', async () => {
      for (const [periods, code] of [
        [NEW.slice(0, 2), 'tariff_gap_or_overlap'], // ends at 20:00
        [[NEW[0], { ...NEW[1], time_start: '07:00' }, NEW[2]], 'tariff_gap_or_overlap'],
        [[{ ...NEW[0], time_start: '01:00' }, NEW[1], NEW[2]], 'tariff_gap_or_overlap'],
        [[{ ...NEW[0], band: 'sharp' }, NEW[1], NEW[2]], 'invalid_input'],
        [[{ ...NEW[0], price_per_kwh_vnd: -1 }, NEW[1], NEW[2]], 'invalid_input'],
        [[{ ...NEW[0], time_end: '25:00' }, NEW[1], NEW[2]], 'invalid_input'],
      ] as const) {
        const r = await call('PUT', '/tariffs', tokens['a'], { effective_from: tomorrow, periods });
        expect([r.status, r.body.error]).toEqual([400, code]);
      }
      const past = await call('PUT', '/tariffs', tokens['a'], {
        effective_from: yesterday,
        periods: NEW,
      });
      expect([past.status, past.body.error]).toEqual([400, 'effective_from_in_past']);
      expect((await q('SELECT count(*)::int AS n FROM tariff_periods'))[0].n).toBe(SEED.length);
    });

    it('PUT from tomorrow closes the current schedule today and leaves its rows otherwise as they were', async () => {
      const before = await q(
        `SELECT id,band,time_start,time_end,price_per_kwh_vnd FROM tariff_periods ORDER BY id`,
      );
      const r = await call('PUT', '/tariffs', tokens['a'], {
        effective_from: tomorrow,
        periods: NEW,
      });
      expect(r.status).toBe(200);
      expect(r.body.current).toEqual({
        effective_from: '2026-01-01',
        effective_to: today,
        periods: SEED,
      });
      expect(r.body.upcoming).toEqual([
        { effective_from: tomorrow, effective_to: null, periods: NEW },
      ]);
      const old = await q(
        `SELECT id,band,time_start,time_end,price_per_kwh_vnd FROM tariff_periods
         WHERE effective_from=DATE '2026-01-01' ORDER BY id`,
      );
      expect(old).toEqual(before);
      // GET on tomorrow sees the new schedule as current.
      const atTomorrow = await call('GET', `/tariffs?at=${tomorrow}`, tokens['a']);
      expect(atTomorrow.body.current.periods).toEqual(NEW);
    });

    it('a second PUT for the same day replaces the upcoming schedule; the same PUT twice is idempotent', async () => {
      const cheaper = NEW.map((p) => ({ ...p, price_per_kwh_vnd: p.price_per_kwh_vnd - 500 }));
      for (let i = 0; i < 2; i += 1) {
        const r = await call('PUT', '/tariffs', tokens['a'], {
          effective_from: tomorrow,
          periods: cheaper,
        });
        expect(r.body.upcoming).toEqual([
          { effective_from: tomorrow, effective_to: null, periods: cheaper },
        ]);
      }
      expect(
        (
          await q(
            "SELECT count(*)::int AS n FROM tariff_periods WHERE effective_from > DATE '2026-01-01'",
          )
        )[0].n,
      ).toBe(NEW.length);
    });

    it('400 for unknown query or body keys', async () => {
      expect((await call('GET', '/tariffs?at=2026-13-01', tokens['a'])).status).toBe(400);
      expect((await call('GET', '/tariffs?x=1', tokens['a'])).status).toBe(400);
      const r = await call('PUT', '/tariffs', tokens['a'], {
        effective_from: tomorrow,
        periods: NEW,
        operator_id: ops['b'],
      });
      expect([r.status, r.body.error]).toEqual([400, 'invalid_input']);
    });
  });

  describe('promotions', () => {
    const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    let id = '';

    it('POST creates a promotion; the code is unique across the platform', async () => {
      const r = await call('POST', '/promotions', tokens['a'], {
        promotion_code: 'TET2027',
        discount_type: 'percent',
        discount_value: 10,
        valid_from: later(-1),
        valid_to: later(30),
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        promotion_code: 'TET2027',
        discount_type: 'percent',
        discount_value: 10,
        active: true,
      });
      id = r.body.id;
      const dup = await call('POST', '/promotions', tokens['b'], {
        promotion_code: 'TET2027',
        discount_type: 'fixed_vnd',
        discount_value: 5000,
        valid_from: later(1),
        valid_to: later(2),
      });
      expect([dup.status, dup.body.error]).toEqual([409, 'promotion_code_taken']);
    });

    it('400 for a bad code, percent above 100 or valid_to before valid_from', async () => {
      for (const body of [
        { promotion_code: 'tet', discount_type: 'percent', discount_value: 5 },
        { promotion_code: 'OK-1', discount_type: 'percent', discount_value: 101 },
        {
          promotion_code: 'OK-2',
          discount_type: 'percent',
          discount_value: 5,
          valid_to: later(-2),
        },
      ]) {
        const r = await call('POST', '/promotions', tokens['a'], {
          valid_from: later(-1),
          valid_to: later(1),
          ...body,
        });
        expect([r.status, r.body.error]).toEqual([400, 'invalid_input']);
      }
    });

    it('GET lists the Operator’s promotions with an active filter; others cannot see them', async () => {
      await call('POST', '/promotions', tokens['a'], {
        promotion_code: 'SOON',
        discount_type: 'fixed_vnd',
        discount_value: 20000,
        valid_from: later(5),
        valid_to: later(10),
      });
      const all = await call('GET', '/promotions', tokens['a']);
      expect(all.body.items.map((p: any) => p.promotion_code)).toEqual(['SOON', 'TET2027']);
      const active = await call('GET', '/promotions?active=true', tokens['a']);
      expect(active.body.items.map((p: any) => p.promotion_code)).toEqual(['TET2027']);
      expect((await call('GET', '/promotions', tokens['b'])).body.total).toBe(0);
      expect(
        (await call('PATCH', `/promotions/${id}`, tokens['b'], { discount_value: 1 })).status,
      ).toBe(404);
    });

    it('PATCH changes value or dates, never the code', async () => {
      const r = await call('PATCH', `/promotions/${id}`, tokens['a'], { discount_value: 15 });
      expect(r.body).toMatchObject({ promotion_code: 'TET2027', discount_value: 15 });
      const code = await call('PATCH', `/promotions/${id}`, tokens['a'], { promotion_code: 'NEW' });
      expect([code.status, code.body.error]).toEqual([400, 'invalid_input']);
    });

    it('deactivate ends it now; an ended promotion cannot be edited or ended again', async () => {
      const r = await call('POST', `/promotions/${id}/deactivate`, tokens['a'], {});
      expect(r.status).toBe(200);
      expect(r.body.active).toBe(false);
      expect(new Date(r.body.valid_to).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      for (const [method, path, body] of [
        ['POST', `/promotions/${id}/deactivate`, {}],
        ['PATCH', `/promotions/${id}`, { discount_value: 20 }],
      ] as const) {
        const again = await call(method, path, tokens['a'], body);
        expect([again.status, again.body.error]).toEqual([409, 'promotion_expired']);
      }
    });

    it('a promotion that has not started yet can be ended too', async () => {
      const soon = (await call('GET', '/promotions', tokens['a'])).body.items.find(
        (p: any) => p.promotion_code === 'SOON',
      );
      const r = await call('POST', `/promotions/${soon.id}/deactivate`, tokens['a'], {});
      expect(r.status).toBe(200);
      expect(r.body.active).toBe(false);
    });
  });

  it('operator staff only: 401 without a token, 403 for an admin, 405 for a wrong method', async () => {
    expect((await call('GET', '/tariffs')).status).toBe(401);
    expect((await call('GET', '/tariffs', tokens['admin'])).status).toBe(403);
    expect((await call('GET', '/promotions', tokens['admin'])).status).toBe(403);
    expect((await call('DELETE', '/tariffs', tokens['a'])).status).toBe(405);
    expect((await call('GET', '/promotions/1/deactivate', tokens['a'])).status).toBe(405);
  });
});
