/**
 * FE-18 — screen 31 Charge Point Network Monitor (UC-ADM-07) over real HTTP (ConsoleServer) and
 * Postgres:
 *   GET /api/admin/v1/network/charge-points — every Operator's charge points with live connector
 *       status, the Operator and open faults; lab data (LOADTEST01) left out; operator_id filter.
 *   GET /api/admin/v1/operators — the platform's Operators (OpenAPI listOperators).
 * Admin only. The Operator route (screen 18) stays scoped to its own Operator.
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
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe18', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-18 admin network monitor (screen 31, UC-ADM-07)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const tokens: Record<string, string> = {};
  const ops: Record<string, string> = {};
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function get(path: string, token?: string, method = 'GET') {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function user(email: string, role: string) {
    return (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,$3,$4)
         RETURNING id::text AS id`,
        [email, email, role, await hashChargePointPassword(PASSWORD)],
      )
    )[0].id as string;
  }
  async function operator(key: string, taxCode: string, name: string, status = 'active') {
    ops[key] = String(
      (
        await q('INSERT INTO operators(tax_code,legal_name,status) VALUES($1,$2,$3) RETURNING id', [
          taxCode,
          name,
          status,
        ])
      )[0].id,
    );
    await q(
      `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
       VALUES($1,$2,$3,'x',10.7,106.7)`,
      [`${key.toUpperCase()}-S1`, ops[key], `Tram ${key}`],
    );
  }
  async function chargePoint(serial: string, opKey: string, online: boolean) {
    const [cp] = await q(
      `INSERT INTO charge_points(serial_number,site_id,lifecycle,is_online,last_message_at)
       SELECT $1,id,'in_service',$2,now() FROM sites WHERE site_code=$3 RETURNING id`,
      [serial, online, `${opKey.toUpperCase()}-S1`],
    );
    await q(
      `INSERT INTO connectors(charge_point_id,connector_no,status,status_changed_at)
       VALUES($1,1,'Available',now()),($1,2,'Faulted',now())`,
      [cp.id],
    );
    return String(cp.id);
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    await operator('a', '0400000181', 'An Phat EV');
    await operator('b', '0400000182', 'Binh Minh Charging', 'suspended');
    await operator('lab', 'LOADTEST01', 'Lab');
    const a1 = await chargePoint('FE18-A1', 'a', true);
    await chargePoint('FE18-B1', 'b', false);
    await chargePoint('LOAD-0001', 'lab', true);
    // Two open faults on A1 (one per connector: critical and minor) and a resolved one that does
    // not count (one open fault per connector, migration 0008).
    await q(
      `INSERT INTO fault_events(charge_point_id,connector_id,source,error_code,status,resolved_at)
       SELECT $1,c.id,'ocpp',v.code,v.st::fault_event_status,v.done
       FROM (VALUES (2,'GroundFailure','raised',NULL::timestamptz),
                    (1,'WeakSignal','acknowledged',NULL),
                    (1,'OverCurrentFailure','resolved',now())) v(no,code,st,done)
       JOIN connectors c ON c.charge_point_id=$1 AND c.connector_no=v.no`,
      [a1],
    );
    const admin = await user('admin@fe18.test', 'admin');
    await q('INSERT INTO admins(user_id) VALUES($1)', [admin]);
    const staff = await user('staff@fe18.test', 'operator_staff');
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      staff,
      ops['a'],
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
    for (const [key, email] of [
      ['admin', 'admin@fe18.test'],
      ['staff', 'staff@fe18.test'],
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

  it("lists every real Operator's charge points with Operator, connectors and open faults", async () => {
    const r = await get('/admin/v1/network/charge-points', tokens['admin']);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2); // lab charge point left out
    const [a1, b1] = r.body.items;
    expect(a1).toMatchObject({
      serial_number: 'FE18-A1',
      lifecycle: 'in_service',
      site: { site_code: 'A-S1', site_name: 'Tram a' },
      operator: { id: ops['a'], legal_name: 'An Phat EV' },
      open_faults: { total: 2, top_severity: 'critical' },
    });
    expect(a1.connectors.map((c: any) => [c.connector_no, c.status])).toEqual([
      [1, 'Available'],
      [2, 'Faulted'],
    ]);
    expect(a1.connectors[0].status_quality).toBe('fresh');
    expect(b1).toMatchObject({
      serial_number: 'FE18-B1',
      operator: { legal_name: 'Binh Minh Charging' },
      open_faults: { total: 0, top_severity: null },
    });
    expect(b1.connectors[0].status_quality).toBe('offline');
    // Detail-only fields of screen 20 are not in the list.
    expect(a1).not.toHaveProperty('firmware_version');
  });

  it('filters by operator_id and online, and pages', async () => {
    const byOp = await get(
      `/admin/v1/network/charge-points?operator_id=${ops['b']}`,
      tokens['admin'],
    );
    expect(byOp.body.items.map((c: any) => c.serial_number)).toEqual(['FE18-B1']);
    const offline = await get('/admin/v1/network/charge-points?online=false', tokens['admin']);
    expect(offline.body.items.map((c: any) => c.serial_number)).toEqual(['FE18-B1']);
    const page2 = await get('/admin/v1/network/charge-points?page=2&page_size=1', tokens['admin']);
    expect(page2.body).toMatchObject({ total: 2, page: 2, page_size: 1 });
    expect(page2.body.items).toHaveLength(1);
  });

  it('the Operator list (screen 18) stays scoped and has no admin fields', async () => {
    const r = await get('/operator/v1/charge-points', tokens['staff']);
    expect(r.body.items.map((c: any) => c.serial_number)).toEqual(['FE18-A1']);
    expect(r.body.items[0]).not.toHaveProperty('operator');
    expect(r.body.items[0]).not.toHaveProperty('open_faults');
    // An Operator cannot use operator_id to look at another Operator.
    const other = await get(`/operator/v1/charge-points?operator_id=${ops['b']}`, tokens['staff']);
    expect(other.status).toBe(400);
  });

  it('GET /admin/v1/operators lists real Operators by name, with a status filter', async () => {
    const all = await get('/admin/v1/operators', tokens['admin']);
    expect(all.body).toEqual({
      items: [
        { id: ops['a'], tax_code: '0400000181', legal_name: 'An Phat EV', status: 'active' },
        {
          id: ops['b'],
          tax_code: '0400000182',
          legal_name: 'Binh Minh Charging',
          status: 'suspended',
        },
      ],
      total: 2,
      page: 1,
      page_size: 50,
    });
    const active = await get('/admin/v1/operators?status=active', tokens['admin']);
    expect(active.body.items.map((o: any) => o.legal_name)).toEqual(['An Phat EV']);
  });

  it('400 invalid_input for bad queries on both routes', async () => {
    for (const path of [
      '/admin/v1/network/charge-points?operator_id=abc',
      '/admin/v1/network/charge-points?online=yes',
      '/admin/v1/network/charge-points?x=1',
      '/admin/v1/network/charge-points?page_size=101',
      '/admin/v1/operators?status=locked',
      '/admin/v1/operators?q=a',
      '/admin/v1/operators?page=1&page=2',
    ]) {
      const r = await get(path, tokens['admin']);
      expect([path, r.status, r.body.error]).toEqual([path, 400, 'invalid_input']);
    }
  });

  it('admin only: 401 without a token, 403 for operator staff, 405 for POST', async () => {
    for (const path of ['/admin/v1/network/charge-points', '/admin/v1/operators']) {
      expect((await get(path)).status).toBe(401);
      expect((await get(path, tokens['staff'])).status).toBe(403);
      expect((await get(path, tokens['admin'], 'POST')).status).toBe(405);
    }
  });
});
