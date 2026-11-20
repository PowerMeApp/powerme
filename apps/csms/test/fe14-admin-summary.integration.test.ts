/**
 * FE-14 — Admin platform overview (screen 27, UC-ADM-07) over real HTTP (ConsoleServer) and
 * Postgres: GET /api/admin/v1/summary counts every user, charge point, RFID card and open billing
 * exception of the platform (no Operator scope), billing in the terms of UC-ADM-08. Admin only.
 * Needs DATABASE_URL; resets its schema.
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
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe14', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-14 admin platform summary (screen 27, UC-ADM-07)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const tokens: Record<string, string> = {};
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function get(path: string, token?: string, method = 'GET') {
    const r = await fetch(`${base}/api/admin/v1${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function user(email: string, role: string, status = 'active') {
    return (
      await q(
        `INSERT INTO users(email,full_name,role,password_hash,account_status)
         VALUES($1,$5,$2,$3,$4) RETURNING id::text AS id`,
        [email, role, await hashChargePointPassword(PASSWORD), status, email],
      )
    )[0].id as string;
  }
  /** A top-up; `late` = a late payment on it, `lateRefunded` = that late payment already refunded. */
  async function topUp(account: string, status: string, late = false, lateRefunded = false) {
    seq += 1;
    return (
      await q(
        `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,status,
           idempotency_key,expires_at,late_gateway_ref,late_paid_at,late_amount_vnd,late_refunded_at)
         VALUES($1,$2,100000,100000,$3,$8,now()+interval '15 minutes',$4,$5,$6,$7) RETURNING id::text AS id`,
        [
          `FE14-${seq}`,
          account,
          status,
          late ? `LATE-${seq}` : null,
          late ? new Date() : null,
          late ? 100000 : null,
          lateRefunded ? new Date(Date.now() + 1000) : null,
          `FE14-KEY-${seq}`,
        ],
      )
    )[0].id as string;
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0400000001','FE14 Operator') RETURNING id",
    );
    const [site] = await q(
      `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
       VALUES('FE14',$1,'Tram FE14','x',10.7,106.7) RETURNING id`,
      [op.id],
    );
    const admin = await user('admin@fe14.test', 'admin');
    await q('INSERT INTO admins(user_id) VALUES($1)', [admin]);
    const staff = await user('staff@fe14.test', 'operator_staff');
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      staff,
      op.id,
    ]);
    const drivers: string[] = [];
    for (const [i, status] of ['active', 'active', 'suspended'].entries()) {
      const d = await user(`driver${i}@fe14.test`, 'driver', status);
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())",
        [d],
      );
      drivers.push(d);
    }
    // Charge points: registered (no site), in service online, in service silent 1 h (offline),
    // awaiting connection, decommissioned.
    for (const [serial, lifecycle, online, silentS, withSite] of [
      ['FE14-REG', 'registered', false, null, false],
      ['FE14-ON', 'in_service', true, 10, true],
      ['FE14-SILENT', 'in_service', true, 3600, true],
      ['FE14-NEW', 'awaiting_connection', false, null, true],
      ['FE14-OLD', 'decommissioned', false, null, true],
    ] as const)
      await q(
        `INSERT INTO charge_points(serial_number,site_id,lifecycle,is_online,last_message_at)
         VALUES($1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE now()-($5::int*interval '1 second') END)`,
        [serial, withSite ? site.id : null, lifecycle, online, silentS],
      );
    for (const [i, status] of ['active', 'active', 'blocked', 'unlinked'].entries())
      await q(
        `INSERT INTO rfid_cards(card_identifier,card_kind,driver_id,status)
         VALUES($1,'online',$2,$3)`,
        [`FE14-CARD-${i}`, status === 'unlinked' ? null : drivers[0], status],
      );
    const account = (
      await q('INSERT INTO credit_accounts(driver_id) VALUES($1) RETURNING id::text AS id', [
        drivers[0],
      ])
    )[0].id as string;
    await topUp(account, 'expired', true); // late payment to refund → counts
    await topUp(account, 'expired', true, true); // already refunded → does not count
    const credited = await topUp(account, 'credited', true); // second payment on credited (T116)
    const other = await topUp(account, 'credited');
    await q(
      `INSERT INTO e_invoices(top_up_id,amount_vnd,vat_amount_vnd,status,invoice_no,issued_at) VALUES
         ($1,100000,8000,'needs_review',NULL,NULL),($2,100000,8000,'issued','FE14-INV-1',now())`,
      [credited, other],
    );
    await q(
      `INSERT INTO refunds(top_up_id,kind,amount_vnd,status,completed_at,gateway_refund_no) VALUES
         ($1,'account_closure',5000,'failed',NULL,NULL),
         ($2,'account_closure',5000,'done',now(),'FE14-REFUND-1')`,
      [credited, other],
    );

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
      ['admin', 'admin@fe14.test'],
      ['staff', 'staff@fe14.test'],
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

  it('counts the whole platform: users, charge points, RFID cards, open billing exceptions', async () => {
    const r = await get('/summary', tokens['admin']);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      users: { driver: 3, operator_staff: 1, admin: 1, suspended: 1 },
      charge_points: {
        by_lifecycle: {
          registered: 1,
          in_service: 2,
          awaiting_connection: 1,
          decommissioned: 1,
        },
        online: 1,
      },
      rfid_cards: { active: 2, blocked: 1, unlinked: 1 },
      billing_exceptions: { late_payments: 2, invoices_needs_review: 1, failed_refunds: 1 },
    });
  });

  it('admin only: no token 401, staff 403, driver 403; no query, GET only', async () => {
    expect((await get('/summary')).status).toBe(401);
    expect((await get('/summary', tokens['staff'])).status).toBe(403);
    const now = Math.floor(Date.now() / 1000);
    const driver = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('1')
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
    expect((await get('/summary', driver)).status).toBe(403);
    expect((await get('/summary?x=1', tokens['admin'])).status).toBe(400);
    expect((await get('/summary', tokens['admin'], 'POST')).status).toBe(405);
    expect((await get('/me', tokens['admin'])).status).toBe(200);
  });
});
