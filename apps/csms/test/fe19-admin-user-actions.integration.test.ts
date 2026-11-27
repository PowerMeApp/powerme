/**
 * FE-19 — screen 28 Users & Roles (UC-ADM-01/02, BR-P16, F-13) over real HTTP (ConsoleServer) and
 * Postgres: create staff / admin accounts, read, edit, change role, lock / unlock, with the effect
 * on the next request (RolesGuard re-reads the account). Admin only. Needs DATABASE_URL.
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
const NEW_PASSWORD = 'mat-khau-ban-dau-9';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe19', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-19 admin user actions (screen 28, UC-ADM-01/02)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  let operatorId = '';
  let adminId = '';
  let driverId = '';
  let adminToken = '';
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function login(email: string, password = PASSWORD) {
    return call('POST', '/auth/v1/login', undefined, { email, password });
  }
  const staffBody = (over: Record<string, unknown> = {}) => ({
    email: 'Tech.New@FE19.test',
    full_name: '  Nguyen Ky Thuat ',
    phone_number: '0901234567',
    role: 'operator_staff',
    operator_id: operatorId,
    staff_role: 'technician',
    initial_password: NEW_PASSWORD,
    ...over,
  });

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    operatorId = String(
      (
        await q(
          "INSERT INTO operators(tax_code,legal_name) VALUES('0400000191','FE19 Operator') RETURNING id",
        )
      )[0].id,
    );
    const hash = await hashChargePointPassword(PASSWORD);
    adminId = (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash) VALUES('admin@fe19.test','Admin','admin',$1)
         RETURNING id::text AS id`,
        [hash],
      )
    )[0].id;
    await q('INSERT INTO admins(user_id) VALUES($1)', [adminId]);
    driverId = (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash) VALUES('driver@fe19.test','Driver','driver',$1)
         RETURNING id::text AS id`,
        [hash],
      )
    )[0].id;
    await q("INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())", [
      driverId,
    ]);

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
    adminToken = (await login('admin@fe19.test')).body.access_token;
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  let techId = '';

  it('POST creates operator staff (email lower-cased, phone normalised) who can then log in', async () => {
    const r = await call('POST', '/admin/v1/users', adminToken, staffBody());
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      email: 'tech.new@fe19.test',
      full_name: 'Nguyen Ky Thuat',
      phone_number: '+84901234567',
      role: 'operator_staff',
      account_status: 'active',
      operator: { id: operatorId, legal_name: 'FE19 Operator' },
      staff_role: 'technician',
      created_at: expect.any(String),
    });
    techId = r.body.id;
    const l = await login('tech.new@fe19.test', NEW_PASSWORD);
    expect(l.status).toBe(200);
    expect((await call('GET', '/operator/v1/me', l.body.access_token)).status).toBe(200);
  });

  it('POST creates an admin (with the admins row) who can use the Admin API', async () => {
    const r = await call('POST', '/admin/v1/users', adminToken, {
      email: 'admin2@fe19.test',
      full_name: 'Admin Hai',
      role: 'admin',
      initial_password: NEW_PASSWORD,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ role: 'admin', operator: null, staff_role: null });
    expect((await q('SELECT 1 FROM admins WHERE user_id=$1', [r.body.id])).length).toBe(1);
    const token = (await login('admin2@fe19.test', NEW_PASSWORD)).body.access_token;
    expect((await call('GET', '/admin/v1/me', token)).status).toBe(200);
  });

  it('POST errors: email / phone taken, unknown Operator, bad role fields or password', async () => {
    for (const [body, status, code] of [
      [staffBody({ email: 'TECH.NEW@fe19.test', phone_number: null }), 409, 'email_taken'],
      [staffBody({ email: 'x1@fe19.test' }), 409, 'phone_taken'],
      [
        staffBody({ email: 'x2@fe19.test', phone_number: null, operator_id: '999999' }),
        404,
        'operator_not_found',
      ],
      [staffBody({ email: 'x3@fe19.test', role: 'driver' }), 400, 'invalid_input'],
      [staffBody({ email: 'x4@fe19.test', staff_role: undefined }), 400, 'invalid_input'],
      [{ ...staffBody({ email: 'x5@fe19.test' }), role: 'admin' }, 400, 'invalid_input'],
      [staffBody({ email: 'x6@fe19.test', initial_password: 'short' }), 400, 'invalid_input'],
      [staffBody({ email: 'not-an-email' }), 400, 'invalid_input'],
    ] as const) {
      const r = await call('POST', '/admin/v1/users', adminToken, body);
      expect([JSON.stringify(body).slice(0, 40), r.status, r.body.error]).toEqual([
        JSON.stringify(body).slice(0, 40),
        status,
        code,
      ]);
    }
  });

  it('GET one user; 404 for an unknown id', async () => {
    expect((await call('GET', `/admin/v1/users/${techId}`, adminToken)).body.email).toBe(
      'tech.new@fe19.test',
    );
    expect((await call('GET', '/admin/v1/users/999999', adminToken)).status).toBe(404);
  });

  it('PATCH edits full name and phone (null clears it); a taken phone is 409', async () => {
    const r = await call('PATCH', `/admin/v1/users/${techId}`, adminToken, {
      full_name: 'Nguyen Van Ky Thuat',
      phone_number: null,
    });
    expect(r.body).toMatchObject({ full_name: 'Nguyen Van Ky Thuat', phone_number: null });
    await q("UPDATE users SET phone_number='+84912345678' WHERE id=$1", [driverId]);
    const taken = await call('PATCH', `/admin/v1/users/${techId}`, adminToken, {
      phone_number: '0912345678',
    });
    expect([taken.status, taken.body.error]).toEqual([409, 'phone_taken']);
    expect((await call('PATCH', `/admin/v1/users/${techId}`, adminToken, {})).status).toBe(400);
  });

  it('PUT role: staff → admin moves the role rows; drivers and own role are refused', async () => {
    const r = await call('PUT', `/admin/v1/users/${techId}/role`, adminToken, { role: 'admin' });
    expect(r.body).toMatchObject({ role: 'admin', operator: null, staff_role: null });
    expect((await q('SELECT 1 FROM operator_staff WHERE user_id=$1', [techId])).length).toBe(0);
    expect((await q('SELECT 1 FROM admins WHERE user_id=$1', [techId])).length).toBe(1);
    const back = await call('PUT', `/admin/v1/users/${techId}/role`, adminToken, {
      role: 'operator_staff',
      operator_id: operatorId,
      staff_role: 'manager',
    });
    expect(back.body).toMatchObject({ role: 'operator_staff', staff_role: 'manager' });
    for (const [id, code] of [
      [driverId, 'role_change_not_allowed'],
      [adminId, 'cannot_change_own_role'],
    ] as const) {
      const x = await call('PUT', `/admin/v1/users/${id}/role`, adminToken, { role: 'admin' });
      expect([x.status, x.body.error]).toEqual([409, code]);
    }
  });

  it('lock: the next request of that account is refused (F-13); unlock restores it', async () => {
    const token = (await login('tech.new@fe19.test', NEW_PASSWORD)).body.access_token;
    expect((await call('GET', '/operator/v1/me', token)).status).toBe(200);
    const locked = await call('POST', `/admin/v1/users/${techId}/lock`, adminToken, {
      note: 'Nghỉ việc',
    });
    expect(locked.body.account_status).toBe('suspended');
    const after = await call('GET', '/operator/v1/me', token);
    expect([after.status, after.body.error]).toEqual([403, 'account_locked']);
    expect((await login('tech.new@fe19.test', NEW_PASSWORD)).status).toBe(403);
    const again = await call('POST', `/admin/v1/users/${techId}/lock`, adminToken, { note: 'x' });
    expect([again.status, again.body.error]).toEqual([409, 'invalid_transition']);
    const unlocked = await call('POST', `/admin/v1/users/${techId}/unlock`, adminToken, {
      note: 'Quay lại',
    });
    expect(unlocked.body.account_status).toBe('active');
    expect((await login('tech.new@fe19.test', NEW_PASSWORD)).status).toBe(200);
  });

  it('lock / unlock refusals: own account, closed account, missing note', async () => {
    const self = await call('POST', `/admin/v1/users/${adminId}/lock`, adminToken, { note: 'x' });
    expect([self.status, self.body.error]).toEqual([409, 'cannot_lock_self']);
    await q("UPDATE users SET account_status='closed' WHERE id=$1", [driverId]);
    const closed = await call('POST', `/admin/v1/users/${driverId}/unlock`, adminToken, {
      note: 'x',
    });
    expect([closed.status, closed.body.error]).toEqual([409, 'invalid_transition']);
    expect((await call('POST', `/admin/v1/users/${techId}/lock`, adminToken, {})).status).toBe(400);
    expect(
      (await call('POST', `/admin/v1/users/${techId}/lock`, adminToken, { note: ' ' })).status,
    ).toBe(400);
  });

  it('admin only: 401 / 403 for operator staff; 405 for wrong methods; query on actions is 400', async () => {
    const staffToken = (await login('tech.new@fe19.test', NEW_PASSWORD)).body.access_token;
    expect((await call('POST', '/admin/v1/users', undefined, staffBody())).status).toBe(401);
    expect((await call('POST', '/admin/v1/users', staffToken, staffBody())).status).toBe(403);
    expect((await call('DELETE', `/admin/v1/users/${techId}`, adminToken)).status).toBe(405);
    expect((await call('PUT', '/admin/v1/users', adminToken, {})).status).toBe(405);
    expect((await call('GET', `/admin/v1/users/${techId}?x=1`, adminToken)).status).toBe(400);
    // The list still works.
    expect((await call('GET', '/admin/v1/users?role=operator_staff', adminToken)).status).toBe(200);
  });
});
