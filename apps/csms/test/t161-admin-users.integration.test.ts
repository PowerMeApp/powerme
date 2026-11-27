/**
 * T161 — driver search for screen 30 (RFID Cards, UC-ADM-04) over real HTTP (ConsoleServer) and
 * Postgres: GET /api/admin/v1/users (contract §3.8, OpenAPI listUsers) finds accounts by name, email or
 * phone (BE-30 normalisation), filtered by role, account_status and operator_id. Admin only. Needs DATABASE_URL; resets its
 * schema.
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
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 't161', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('T161 GET /api/admin/v1/users (driver picker of screen 30)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let operatorId = '';
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function get(search: string, token?: string, method = 'GET') {
    const r = await fetch(`${base}/api/admin/v1/users${search}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function user(
    email: string,
    role: string,
    name = email,
    phone: string | null = null,
    status = 'active',
  ) {
    return (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash,account_status,phone_number)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text AS id`,
        [email, name, role, await hashChargePointPassword(PASSWORD), status, phone],
      )
    )[0].id as string;
  }
  async function driver(key: string, name: string, phone: string | null, status = 'active') {
    const id = await user(`${key}@t161.test`, 'driver', name, phone, status);
    await q("INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())", [
      id,
    ]);
    ids[key] = id;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0400000161','T161 Operator') RETURNING id",
    );
    const admin = await user('admin@t161.test', 'admin', 'Nguyen Admin');
    await q('INSERT INTO admins(user_id) VALUES($1)', [admin]);
    operatorId = String(op.id);
    const staff = await user('staff@t161.test', 'operator_staff', 'Nguyen Staff');
    ids['staff'] = staff;
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      staff,
      op.id,
    ]);
    await driver('lan', 'Nguyen Thi Lan', '+84901234567');
    await driver('minh', 'Tran Minh', '+84912345678');
    await driver('khoa', 'Nguyen Van Khoa', null, 'suspended');
    await driver('pct', '100% Pin', null);

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
      ['admin', 'admin@t161.test'],
      ['staff', 'staff@t161.test'],
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

  const account = (key: string, over: Record<string, unknown> = {}) => ({
    id: ids[key],
    email: `${key}@t161.test`,
    phone_number: null,
    role: 'driver',
    account_status: 'active',
    operator: null,
    staff_role: null,
    created_at: expect.any(String),
    ...over,
  });

  it('driver picker: role=driver, name contains q (case-insensitive), newest first', async () => {
    const r = await get('?role=driver&q=nguyen', tokens['admin']);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [
        account('khoa', { full_name: 'Nguyen Van Khoa', account_status: 'suspended' }),
        account('lan', { full_name: 'Nguyen Thi Lan', phone_number: '+84901234567' }),
      ],
      total: 2,
      page: 1,
      page_size: 50,
    });
  });

  it('account_status=active leaves out locked and closed accounts', async () => {
    const r = await get('?role=driver&account_status=active&q=nguyen', tokens['admin']);
    expect(r.body.items.map((d: any) => d.id)).toEqual([ids['lan']]);
    expect(r.body.total).toBe(1);
  });

  it('without role: staff carry their Operator and staff_role; operator_id filters staff', async () => {
    const all = await get('?q=nguyen', tokens['admin']);
    expect(all.body.total).toBe(4); // admin, staff, khoa, lan
    const staff = await get(`?operator_id=${operatorId}`, tokens['admin']);
    expect(staff.body.items).toEqual([
      {
        id: ids['staff'],
        email: 'staff@t161.test',
        full_name: 'Nguyen Staff',
        phone_number: null,
        role: 'operator_staff',
        account_status: 'active',
        operator: { id: operatorId, legal_name: 'T161 Operator' },
        staff_role: 'manager',
        created_at: expect.any(String),
      },
    ]);
  });

  it('finds by email and by phone in any BE-30 form', async () => {
    expect((await get('?role=driver&q=MINH%40T161', tokens['admin'])).body.items[0].id).toBe(
      ids['minh'],
    );
    for (const phone of ['0901234567', '%2B84%20901%20234%20567', '84901234567']) {
      const r = await get(`?role=driver&q=${phone}`, tokens['admin']);
      expect(r.body.items.map((d: any) => d.id)).toEqual([ids['lan']]);
    }
  });

  it('% and _ are plain characters, not wildcards', async () => {
    const pct = await get('?role=driver&q=0%25', tokens['admin']);
    expect(pct.body.items.map((d: any) => d.id)).toEqual([ids['pct']]);
    expect((await get('?role=driver&q=__', tokens['admin'])).body.total).toBe(0);
  });

  it('pages with page / page_size', async () => {
    const r = await get('?role=driver&page=2&page_size=3', tokens['admin']);
    expect(r.body).toMatchObject({ total: 4, page: 2, page_size: 3 });
    expect(r.body.items).toHaveLength(1);
  });

  it('400 invalid_input for a bad query (values, q length, unknown or repeated key, paging)', async () => {
    for (const search of [
      '?role=owner',
      '?account_status=locked',
      '?status=active',
      '?operator_id=abc',
      '?q=n',
      `?q=${'x'.repeat(101)}`,
      '?q=nguyen&q=lan',
      '?page_size=101',
      '?page=0',
    ]) {
      const r = await get(search, tokens['admin']);
      expect([search, r.status, r.body.error]).toEqual([search, 400, 'invalid_input']);
    }
  });

  it('admin only: 401 without a token, 403 for operator staff, 405 for POST', async () => {
    expect((await get('?role=driver&q=nguyen')).status).toBe(401);
    expect((await get('?role=driver&q=nguyen', tokens['staff'])).status).toBe(403);
    expect((await get('?role=driver&q=nguyen', tokens['admin'], 'POST')).status).toBe(405);
  });
});
