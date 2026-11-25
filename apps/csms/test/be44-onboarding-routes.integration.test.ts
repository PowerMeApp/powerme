/**
 * BE-44 — WF-05 behind RolesGuard (UC-ADM-03, UC-OPS-01; ADR-0018) on real Postgres and real HTTP:
 *   POST/GET /api/admin/v1/charge-points  (admin)           → ChargePointOnboardingService.registerDevice
 *   POST /api/operator/v1/charge-points/onboard  (operator_staff) → ChargePointOnboardingService.onboard
 *
 * Proves: 401 without a token, 403 for a token of another surface (staff / driver on admin, admin /
 * driver on operator), 201 on success with the JWT principal as actor (not CONSOLE_ACTOR_*, which is
 * left unset here), 409 serial_not_registered / already_onboarded / serial_already_registered, the
 * password only in the one onboard response (never in the registry list, a repeat call or the log),
 * and 403 site_of_other_operator for another Operator's site (BR-P16 scoping from the DB).
 * The console routes keep their own test (wf05-onboarding-http).
 *
 * Needs DATABASE_URL (own test DB — the schema is dropped); otherwise skipped.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { ChargePointOnboardingService } from '../src/stations/charge-point-onboarding.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'be44', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'be44d', audience: 'app' };
const SERIAL = 'BE44-0001';
const REGISTER = '/api/admin/v1/charge-points';
const ONBOARD = '/api/operator/v1/charge-points/onboard';

describeDb('BE-44 onboarding and registry routes behind RolesGuard', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const logs: string[] = [];
  let password = '';
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, body: text ? JSON.parse(text) : null };
  }
  const onboardBody = (siteKey: string) => ({
    serial_number: SERIAL,
    site_id: Number(ids[siteKey]),
    connectors: [
      { connector_no: 1 },
      { connector_no: 2, connector_type: 'ccs2', max_power_kw: 60 },
    ],
  });

  beforeAll(async () => {
    const keep = (m: unknown) => void logs.push(String(m));
    Logger.overrideLogger({ log: keep, warn: keep, error: keep });
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const hash = await hashChargePointPassword(PASSWORD);
    for (const op of ['A', 'B']) {
      ids[`op${op}`] = (
        await q(
          `INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id::text AS id`,
          [`040000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
        )
      )[0].id;
      ids[`site${op}`] = (
        await q(
          `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
           VALUES($1,$2,$3,'x',10.7,106.7) RETURNING id::text AS id`,
          [`HCM-BE44-${op}`, ids[`op${op}`], `Tram ${op}`],
        )
      )[0].id;
    }
    for (const [key, role] of [
      ['admin', 'admin'],
      ['staffa', 'operator_staff'],
      ['techa', 'operator_staff'],
      ['staffb', 'operator_staff'],
      ['driver', 'driver'],
    ] as const) {
      ids[key] = (
        await q(
          `INSERT INTO users(email,full_name,role,password_hash)
           VALUES($1,$2,$3,$4) RETURNING id::text AS id`,
          [`${key}@be44.test`, key, role, hash],
        )
      )[0].id;
    }
    await q('INSERT INTO admins(user_id) VALUES($1)', [ids['admin']]);
    for (const [key, op, staffRole] of [
      ['staffa', 'A', 'manager'],
      ['techa', 'A', 'technician'],
      ['staffb', 'B', 'manager'],
    ] as const)
      await q('INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,$3)', [
        ids[key],
        ids[`op${op}`],
        staffRole,
      ]);

    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
      ocppPort: 0,
      consolePort: 0,
      ocppPublicUrl: 'ws://127.0.0.1:19644/ocpp',
      dashboardAuth: DASH,
      driverApi: { ...DRIVER, devAuth: false },
    };
    // No CONSOLE_ACTOR_*: the JWT routes must not depend on it.
    delete (config as { consoleActorAdminId?: number }).consoleActorAdminId;
    delete (config as { consoleActorStaffId?: number }).consoleActorStaffId;
    const registry = new ConnectionRegistry(db);
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      undefined,
      new ChargePointOnboardingService(db, config),
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    for (const key of ['admin', 'staffa', 'techa', 'staffb']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${key}@be44.test`, password: PASSWORD }),
      });
      tokens[key] = ((await r.json()) as any).access_token;
    }
    const now = Math.floor(Date.now() / 1000);
    tokens['driver'] = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ids['driver']!)
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
  });

  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('401 without a token (before body and query checks), 403 for the wrong surface', async () => {
    expect((await call('POST', REGISTER, undefined, { serial_number: SERIAL })).status).toBe(401);
    expect((await call('GET', `${REGISTER}?page=x`)).status).toBe(401);
    expect((await call('POST', ONBOARD, undefined, onboardBody('siteA'))).status).toBe(401);
    for (const who of ['staffa', 'techa', 'driver']) {
      expect((await call('POST', REGISTER, tokens[who], { serial_number: SERIAL })).status).toBe(
        403,
      );
      expect((await call('GET', REGISTER, tokens[who])).status).toBe(403);
    }
    for (const who of ['admin', 'driver'])
      expect((await call('POST', ONBOARD, tokens[who], onboardBody('siteA'))).status).toBe(403);
    expect(Number((await q('SELECT count(*) AS n FROM charge_points'))[0].n)).toBe(0);
  });

  it('405 / 400 / 415 on bad method, query or body; the service is not reached', async () => {
    const put = await call('PUT', REGISTER, tokens['admin'], {});
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST, OPTIONS');
    expect((await call('GET', ONBOARD, tokens['staffa'])).status).toBe(405);
    expect((await call('POST', `${ONBOARD}?x=1`, tokens['staffa'], {})).status).toBe(400);
    const bad = await call('POST', REGISTER, tokens['admin'], { serial_number: 'a:b' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_input');
    const extra = await call('POST', ONBOARD, tokens['staffa'], {
      ...onboardBody('siteA'),
      staff_user_id: 1,
    });
    expect(extra.status).toBe(400);
    const r = await fetch(`${base}${REGISTER}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens['admin']}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(r.status).toBe(415);
    for (const query of ['page=0', 'page_size=101', 'lifecycle=nope', 'q=x'])
      expect((await call('GET', `${REGISTER}?${query}`, tokens['admin'])).status).toBe(400);
  });

  it('409 serial_not_registered before the Admin step', async () => {
    const r = await call('POST', ONBOARD, tokens['staffa'], onboardBody('siteA'));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('serial_not_registered');
  });

  it('201 Admin registers the serial (actor from the token), 409 on a second register', async () => {
    const r = await call('POST', REGISTER, tokens['admin'], {
      serial_number: SERIAL,
      model: 'D1-120',
      rated_power_kw: 120,
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({
      serial_number: SERIAL,
      model: 'D1-120',
      rated_power_kw: 120,
      lifecycle: 'registered',
      display_code: null,
      is_online: false,
      operator: null,
      site: null,
    });
    expect(r.body.id).toMatch(/^[1-9][0-9]*$/);
    expect(logs.some((l) => l.includes(`by admin ${ids['admin']}`))).toBe(true);
    const again = await call('POST', REGISTER, tokens['admin'], { serial_number: SERIAL });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('serial_already_registered');
  });

  it("403 site_of_other_operator: staff of Operator B cannot onboard onto Operator A's site", async () => {
    const r = await call('POST', ONBOARD, tokens['staffb'], onboardBody('siteA'));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('site_of_other_operator');
    const missing = await call('POST', ONBOARD, tokens['staffa'], {
      ...onboardBody('siteA'),
      site_id: 999999,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('site_not_found');
    expect((await q('SELECT lifecycle FROM charge_points'))[0].lifecycle).toBe('registered');
  });

  it('201 staff onboards onto its own site; the credential is returned once and only hashed', async () => {
    const r = await call('POST', ONBOARD, tokens['techa'], onboardBody('siteA'));
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({
      display_code: 'PM-D1-HCM-0001',
      lifecycle: 'awaiting_connection',
      ocpp_url: `ws://127.0.0.1:19644/ocpp/${SERIAL}`,
      identity: SERIAL,
    });
    expect(r.body.charge_point_id).toMatch(/^[1-9][0-9]*$/);
    password = r.body.password;
    expect(password).toHaveLength(24);
    expect(logs.some((l) => l.includes(`by staff ${ids['techa']}`))).toBe(true);
    const [cp] = await q(
      'SELECT basic_auth_password_hash AS h, site_id::text AS s FROM charge_points',
    );
    expect(cp.s).toBe(ids['siteA']);
    expect(cp.h).toMatch(/^scrypt\$/);
    expect(cp.h).not.toContain(password);

    const again = await call('POST', ONBOARD, tokens['staffa'], onboardBody('siteA'));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_onboarded');
    expect(again.text).not.toContain(password);
  });

  it('GET registry: paged, filtered by lifecycle, with Operator and site, never the credential', async () => {
    await call('POST', REGISTER, tokens['admin'], { serial_number: 'BE44-0002' });
    const all = await call('GET', REGISTER, tokens['admin']);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 2, page: 1, page_size: 50 });
    expect(all.body.items.map((i: any) => i.serial_number)).toEqual(['BE44-0002', SERIAL]);
    expect(all.body.items[1]).toMatchObject({
      lifecycle: 'awaiting_connection',
      operator: { id: ids['opA'], legal_name: 'Operator A' },
      site: { id: ids['siteA'], site_code: 'HCM-BE44-A', site_name: 'Tram A' },
    });
    expect(all.text).not.toContain(password);
    expect(all.text).not.toContain('scrypt');
    const page2 = await call('GET', `${REGISTER}?page=2&page_size=1`, tokens['admin']);
    expect(page2.body).toMatchObject({ total: 2, page: 2, page_size: 1 });
    expect(page2.body.items.map((i: any) => i.serial_number)).toEqual([SERIAL]);
    const reg = await call('GET', `${REGISTER}?lifecycle=registered`, tokens['admin']);
    expect(reg.body.total).toBe(1);
    expect(reg.body.items[0].serial_number).toBe('BE44-0002');
  });

  it('the password never reaches the log', () => {
    expect(password).not.toBe('');
    expect(logs.join('\n')).not.toContain(password);
  });
});
