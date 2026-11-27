/**
 * FE-02 — GET /api/operator/v1/sites (OpenAPI listOperatorSites, UC-OPS-01, BR-P11/P16) over real
 * HTTP (ConsoleServer) and Postgres: the Charging Stations of the caller's Operator only, ordered by
 * site_code, for the station picker of screen 19. Operator staff only. Needs DATABASE_URL; resets
 * its schema.
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
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe02', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-02 GET /api/operator/v1/sites (station picker of screen 19)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const tokens: Record<string, string> = {};
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function get(search: string, token?: string, method = 'GET') {
    const r = await fetch(`${base}/api/operator/v1/sites${search}`, {
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
  async function operator(taxCode: string, name: string) {
    return String(
      (
        await q('INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id', [
          taxCode,
          name,
        ])
      )[0].id,
    );
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const mine = await operator('0400000201', 'FE02 Operator');
    const other = await operator('0400000202', 'Other Operator');
    // Inserted out of order to check ORDER BY site_code; one site has no address or coordinates.
    await q(
      `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude,vinfast_only) VALUES
         ('HCM-B',$1,'Tram B','12 Le Loi',10.776001,106.700002,true),
         ('HCM-A',$1,'Tram A',NULL,NULL,NULL,false),
         ('HN-C',$1,'Tram C','1 Trang Tien',21.024,105.857,false),
         ('OTHER-1',$2,'Tram khac','x',10.7,106.7,false)`,
      [mine, other],
    );
    const staff = await user('staff@fe02.test', 'operator_staff');
    await q(
      "INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'technician')",
      [staff, mine],
    );
    const admin = await user('admin@fe02.test', 'admin');
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
      ['staff', 'staff@fe02.test'],
      ['admin', 'admin@fe02.test'],
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

  it("lists only the caller's Operator's sites, ordered by site_code (SitePage)", async () => {
    const r = await get('', tokens['staff']);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [
        {
          id: expect.any(String),
          site_code: 'HCM-A',
          site_name: 'Tram A',
          address: null,
          vinfast_only: false,
          latitude: null,
          longitude: null,
        },
        {
          id: expect.any(String),
          site_code: 'HCM-B',
          site_name: 'Tram B',
          address: '12 Le Loi',
          vinfast_only: true,
          latitude: 10.776001,
          longitude: 106.700002,
        },
        expect.objectContaining({ site_code: 'HN-C' }),
      ],
      total: 3,
      page: 1,
      page_size: 50,
    });
  });

  it('pages with page / page_size', async () => {
    const r = await get('?page=2&page_size=2', tokens['staff']);
    expect(r.body).toMatchObject({ total: 3, page: 2, page_size: 2 });
    expect(r.body.items.map((s: any) => s.site_code)).toEqual(['HN-C']);
  });

  it('400 invalid_input for any other or repeated key and bad paging', async () => {
    for (const search of [
      '?operator_id=1',
      '?q=HCM',
      '?page=1&page=2',
      '?page=0',
      '?page_size=101',
    ]) {
      const r = await get(search, tokens['staff']);
      expect([search, r.status, r.body.error]).toEqual([search, 400, 'invalid_input']);
    }
  });

  it('operator staff only: 401 without a token, 403 for an admin, 405 for POST', async () => {
    expect((await get('')).status).toBe(401);
    expect((await get('', tokens['admin'])).status).toBe(403);
    expect((await get('', tokens['staff'], 'POST')).status).toBe(405);
  });
});
