/**
 * FE-01a — dashboard login and RolesGuard over real HTTP (ConsoleServer) and Postgres, ADR-0018.
 * Report 5 (F-13): TC-F13-01 wrong role → 403 on every surface; TC-F13-02 a locked account
 * cannot log in; TC-F13-03 locking stops a live token. Needs DATABASE_URL; resets its schema.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { createOperatorApiListener } from '../src/operator-api/operator-api.http.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const WRONG = 'sai-mat-khau-123';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe01', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-01a dashboard login and RolesGuard (F-13, ADR-0018)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const ids: Record<string, string> = {};
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function login(email: string, password = PASSWORD) {
    const r = await fetch(`${base}/api/auth/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  }
  async function get(path: string, token?: string) {
    const r = await fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  const sign = (claims: Record<string, unknown>, key: typeof DASH, ttl = 3600) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(claims['sub']))
      .setIssuer(key.issuer)
      .setAudience(key.audience)
      .setIssuedAt(ttl < 0 ? now - 7200 : now)
      .setExpirationTime(now + ttl)
      .sign(key.secret);
  };

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    for (const op of ['A', 'B'])
      ids[`op${op}`] = (
        await q(
          `INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id::text AS id`,
          [`010000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
        )
      )[0].id;
    const hash = await hashChargePointPassword(PASSWORD);
    for (const [key, role, ext] of [
      ['staff', 'operator_staff', 'A'],
      ['tech', 'operator_staff', 'A'],
      ['staffb', 'operator_staff', 'B'],
      ['limit', 'operator_staff', 'A'],
      ['nostaff', 'operator_staff', ''],
      ['admin', 'admin', 'admin'],
      ['driver', 'driver', 'driver'],
    ] as const) {
      const id = (
        await q(
          `INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id::text AS id`,
          [`${key}@fe01.test`, `User ${key}`, role, hash],
        )
      )[0].id;
      ids[key] = id;
      if (ext === 'admin') await q('INSERT INTO admins(user_id) VALUES($1)', [id]);
      else if (ext === 'driver')
        await q(
          "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())",
          [id],
        );
      else if (ext)
        await q('INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,$3)', [
          id,
          ids[`op${ext}`],
          key === 'tech' ? 'technician' : 'manager',
        ]);
    }
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
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('logs staff and admin in with an 8 h token carrying role and Operator; no hash leaks', async () => {
    const staff = await login('STAFF@fe01.test');
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ token_type: 'Bearer', expires_in: 28800 });
    expect(staff.body.user).toEqual({
      user_id: ids['staff'],
      email: 'staff@fe01.test',
      full_name: 'User staff',
      role: 'operator_staff',
      operator_id: ids['opA'],
      operator_name: 'Operator A',
      staff_role: 'manager',
    });
    const claims = JSON.parse(
      Buffer.from(staff.body.access_token.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({ sub: ids['staff'], role: 'operator_staff' });
    expect(claims.exp - claims.iat).toBe(28800);
    expect(JSON.stringify(staff.body)).not.toContain('scrypt$');
    const admin = await login('admin@fe01.test');
    expect(admin.body.user).toEqual({
      user_id: ids['admin'],
      email: 'admin@fe01.test',
      full_name: 'User admin',
      role: 'admin',
    });
  });

  it('answers the same 401 for a wrong password, unknown email, driver, and staff without Operator', async () => {
    for (const [email, password] of [
      ['staff@fe01.test', WRONG],
      ['nobody@fe01.test', PASSWORD],
      ['driver@fe01.test', PASSWORD],
      ['nostaff@fe01.test', PASSWORD],
    ] as const) {
      const r = await login(email, password);
      expect([email, r.status, r.body.error]).toEqual([email, 401, 'invalid_credentials']);
    }
  });

  it('TC-F13-02: a locked account or inactive Operator cannot log in, told only after the password matched', async () => {
    await q("UPDATE users SET account_status='suspended' WHERE id=$1", [ids['tech']]);
    expect((await login('tech@fe01.test')).body).toMatchObject({ error: 'account_locked' });
    expect((await login('tech@fe01.test', WRONG)).status).toBe(401);
    await q("UPDATE users SET account_status='active' WHERE id=$1", [ids['tech']]);
    await q("UPDATE operators SET status='suspended' WHERE id=$1", [ids['opB']]);
    expect((await login('staffb@fe01.test')).body).toMatchObject({ error: 'operator_inactive' });
    await q("UPDATE operators SET status='active' WHERE id=$1", [ids['opB']]);
  });

  it('locks email + IP after 5 failed logins with 429 and Retry-After, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login('limit@fe01.test', WRONG)).status).toBe(401);
    const locked = await login('limit@fe01.test');
    expect([locked.status, locked.body.error]).toEqual([429, 'too_many_attempts']);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('accepts only POST JSON with email + password, CORS for localhost only, console untouched', async () => {
    const url = `${base}/api/auth/v1/login`;
    expect((await fetch(url, { method: 'POST', body: 'x' })).status).toBe(415);
    expect((await fetch(url)).status).toBe(405);
    expect((await get('/api/auth/v1/logout')).status).toBe(404);
    const extra = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'staff@fe01.test', password: PASSWORD, role: 'admin' }),
    });
    expect(extra.status).toBe(400);
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/admin/stations`)).status).toBe(200);
  });

  it('answers 503 auth_unavailable on every surface when DASHBOARD_JWT_* is not set', async () => {
    const bare = createServer(createOperatorApiListener(db, {}));
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${url}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'staff@fe01.test', password: PASSWORD }),
      });
      expect([r.status, ((await r.json()) as any).error]).toEqual([503, 'auth_unavailable']);
      expect((await fetch(`${url}/api/admin/v1/me`)).status).toBe(503);
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }
  });

  it('TC-F13-01: a valid token of the wrong role gets 403 on every surface; none or bad gets 401', async () => {
    const tokens = {
      staff: (await login('tech@fe01.test')).body.access_token as string,
      admin: (await login('admin@fe01.test')).body.access_token as string,
      driver: await sign({ sub: ids['driver'], role: 'driver' }, DRIVER, 900),
    };
    const bad = [
      undefined,
      'not.a.jwt',
      await sign({ sub: ids['tech'], role: 'operator_staff', operator_id: ids['opA'] }, DASH, -60),
      await sign({ sub: ids['admin'], role: 'admin' }, { ...DASH, secret: randomBytes(32) }),
    ];
    for (const [path, expected] of [
      ['/api/operator/v1/me', { staff: 200, admin: 403, driver: 403 }],
      ['/api/admin/v1/me', { staff: 403, admin: 200, driver: 403 }],
      ['/api/operator/v1/x', { staff: 404, admin: 403, driver: 403 }],
      ['/api/admin/v1/x', { staff: 403, admin: 404, driver: 403 }],
    ] as const) {
      for (const [who, status] of Object.entries(expected))
        expect([path, who, (await get(path, tokens[who as 'staff'])).status]).toEqual([
          path,
          who,
          status,
        ]);
      for (const token of bad) expect([path, (await get(path, token)).status]).toEqual([path, 401]);
    }
    const me = await get('/api/operator/v1/me', tokens.staff);
    expect(me.body).toMatchObject({ role: 'operator_staff', operator_id: ids['opA'] });
  });

  it('TC-F13-03: locking the account or its Operator, or moving the staff, stops a live token', async () => {
    const token = (await login('staffb@fe01.test')).body.access_token as string;
    const me = () => get('/api/operator/v1/me', token);
    expect((await me()).status).toBe(200);
    await q("UPDATE users SET account_status='closed' WHERE id=$1", [ids['staffb']]);
    expect((await me()).body).toMatchObject({ error: 'account_locked' });
    await q("UPDATE users SET account_status='active' WHERE id=$1", [ids['staffb']]);
    await q("UPDATE operators SET status='suspended' WHERE id=$1", [ids['opB']]);
    expect((await me()).body).toMatchObject({ error: 'operator_inactive' });
    await q("UPDATE operators SET status='active' WHERE id=$1", [ids['opB']]);
    await q('UPDATE operator_staff SET operator_id=$2 WHERE user_id=$1', [
      ids['staffb'],
      ids['opA'],
    ]);
    expect((await me()).status).toBe(401);
  });
});
