/**
 * T108a — revenue routes over real HTTP (ConsoleServer) and Postgres:
 *   GET /api/operator/v1/revenue[.csv], GET /api/admin/v1/revenue[.csv]
 * RolesGuard and Operator scope (BR-P16, contract §2.2a / §2.3), parameters (§3.7, RevenueBadRequest),
 * CSV (K9: BOM, RFC 4180, TOTAL, generated_at, CSV injection). Report numbers: fe16-revenue-report.
 * Needs DATABASE_URL; resets its schema. Data: helpers/revenue-fixture.ts.
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
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import {
  buildRevenueFixture,
  OPERATOR_A_NOVEMBER,
  SITE_A1_NAME,
  SITE_A2_NAME,
} from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe16', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb16', audience: 'app' };
const NOV = 'from=2026-11-01&to=2026-11-30';

/** RFC 4180 parser for the test: quoted cells, doubled quotes, CRLF line ends. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') (row.push(cell), (cell = ''));
    else if (ch === '\r' && text[i + 1] === '\n') {
      (row.push(cell), rows.push(row), (row = []), (cell = ''), i++);
    } else cell += ch;
  }
  return rows;
}

describeDb('T108a revenue routes (UC-OPS-09, UC-ADM-10; BR-P16, K9)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  let ids: Record<string, string>;
  const tokens: Record<string, string> = {};
  async function call(path: string, token?: string) {
    const r = await fetch(`${base}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // Node's Buffer keeps the BOM; Response.text() would strip it.
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = bytes.toString('utf8');
    const json = r.headers.get('content-type')?.startsWith('application/json');
    return {
      status: r.status,
      headers: r.headers,
      bytes,
      text,
      body: json ? JSON.parse(text) : null,
    };
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    ids = (await buildRevenueFixture(db, await hashChargePointPassword(PASSWORD))).ids;
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
      new ConsoleCommands(db, registry, new FaultService(db, config)),
      db,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    for (const key of ['admin', 'staffa', 'staffb', 'staffa2']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${key}@fe16.test`, password: PASSWORD }),
      });
      tokens[key] = ((await r.json()) as any).access_token;
    }
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('401 without a token (also with a query), 403 for a driver, a suspended staff or the wrong role', async () => {
    expect((await call(`/operator/v1/revenue?${NOV}`)).status).toBe(401);
    expect((await call(`/admin/v1/revenue.csv?${NOV}`)).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const driver = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ids['driver']!)
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
    expect((await call(`/operator/v1/revenue?${NOV}`, driver)).status).toBe(403);
    expect((await call(`/admin/v1/revenue?${NOV}`, tokens['staffa'])).status).toBe(403);
    expect((await call(`/operator/v1/revenue?${NOV}`, tokens['admin'])).status).toBe(403);
    await db.$client.query("UPDATE users SET account_status='suspended' WHERE id=$1", [
      ids['staffA2'],
    ]);
    const locked = await call(`/operator/v1/revenue?${NOV}`, tokens['staffa2']);
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe('account_locked');
  });

  it('scopes the operator route to the token’s Operator, from the DB', async () => {
    const a = await call(`/operator/v1/revenue?${NOV}&group_by=site`, tokens['staffa']);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toBe('no-store');
    expect(a.body.operator_id).toBe(ids['opA']);
    expect(a.body.totals).toEqual(OPERATOR_A_NOVEMBER);
    expect(a.body.rows.map((r: any) => r.site_id).sort()).toEqual(
      [ids['siteA1'], ids['siteA2']].sort(),
    );
    const b = await call(`/operator/v1/revenue?${NOV}`, tokens['staffb']);
    expect(b.body.rows.map((r: any) => r.charge_point_id)).toEqual([ids['cpB1']]);
    // A site of Operator B under staff A: an empty report, as if the site did not exist.
    const foreign = await call(
      `/operator/v1/revenue?${NOV}&site_id=${ids['siteB1']}`,
      tokens['staffa'],
    );
    expect(foreign.status).toBe(200);
    expect(foreign.body.rows).toEqual([]);
    expect(foreign.body.totals.csms_billed_session_count).toBe(0);
    // operator_id is an admin parameter; on the operator route it is an unknown parameter.
    const op = await call(
      `/operator/v1/revenue?${NOV}&operator_id=${ids['opB']}`,
      tokens['staffa'],
    );
    expect(op.status).toBe(400);
    expect(op.body.error).toBe('invalid_input');
  });

  it('gives the admin the whole platform, and operator_id=A equals what staff A sees', async () => {
    const all = await call(`/admin/v1/revenue?${NOV}`, tokens['admin']);
    expect(all.body.group_by).toBe('operator');
    expect(all.body.operator_id).toBeNull();
    expect(all.body.rows.map((r: any) => r.key)).toEqual([ids['opA'], ids['opB']]);
    const adminA = await call(
      `/admin/v1/revenue?${NOV}&operator_id=${ids['opA']}`,
      tokens['admin'],
    );
    const staffA = await call(`/operator/v1/revenue?${NOV}`, tokens['staffa']);
    expect(adminA.body.totals).toEqual(staffA.body.totals);
    expect(adminA.body.unsettled).toEqual(staffA.body.unsettled);
    expect(adminA.body.pending_reconciliation).toEqual(staffA.body.pending_reconciliation);
    expect(adminA.body.operator_id).toBe(ids['opA']);
  });

  it.each([
    ['to=2026-11-30', 'invalid_input'],
    ['from=2026-11-01', 'invalid_input'],
    ['from=2026-13-01&to=2026-12-31', 'invalid_input'],
    ['from=2026-02-30&to=2026-03-01', 'invalid_input'],
    ['from=1/11/2026&to=2026-11-30', 'invalid_input'],
    ['from=2026-12-01&to=2026-11-30', 'invalid_period'],
    ['from=2026-01-01&to=2027-01-02', 'invalid_period'],
    [`${NOV}&group_by=operator`, 'invalid_input'],
    [`${NOV}&group_by=foo`, 'invalid_input'],
    [`${NOV}&page=1`, 'invalid_input'],
    [`${NOV}&from=2026-11-02`, 'invalid_input'],
    [`${NOV}&site_id=abc`, 'invalid_input'],
  ])('400 on the operator route for %s', async (query, error) => {
    const r = await call(`/operator/v1/revenue?${query}`, tokens['staffa']);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(error);
  });

  it('accepts a 366-day period, rejects 367 days and admin-only parameters per surface', async () => {
    // 2027-11-30 − 2026-12-01: 365 days apart, 366 counted with both ends.
    expect(
      (await call('/operator/v1/revenue?from=2026-12-01&to=2027-11-30', tokens['staffa'])).status,
    ).toBe(200);
    expect(
      (await call('/admin/v1/revenue?from=2026-12-01&to=2027-12-02', tokens['admin'])).body.error,
    ).toBe('invalid_period');
    expect(
      (await call(`/admin/v1/revenue?${NOV}&site_id=${ids['siteA1']}`, tokens['admin'])).body.error,
    ).toBe('invalid_input');
    expect((await call(`/admin/v1/revenue.csv?${NOV}&group_by=day`, tokens['admin'])).status).toBe(
      200,
    );
  });

  it('exports the same report as CSV: BOM, header, rows in JSON order, TOTAL with generated_at', async () => {
    const path = `/operator/v1/revenue.csv?${NOV}`;
    const csv = await call(path, tokens['staffa']);
    const json = await call(path.replace('.csv', ''), tokens['staffa']);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="revenue_2026-11-01_2026-11-30.csv"',
    );
    expect(Number(csv.headers.get('content-length'))).toBe(csv.bytes.length);
    expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.text.startsWith('\uFEFF')).toBe(true);
    const [header, ...lines] = parseCsv(csv.text.slice(1));
    expect(header).toEqual([
      'key',
      'operator_id',
      'operator_name',
      'site_id',
      'site_name',
      'charge_point_id',
      'serial_number',
      'day',
      'csms_billed_session_count',
      'csms_billed_energy_wh',
      'csms_billed_revenue_vnd',
      'unattributed_session_count',
      'unattributed_energy_wh',
      'generated_at',
    ]);
    expect(lines).toHaveLength(json.body.rows.length + 1);
    const text = (v: unknown) => (v === null ? '' : String(v));
    json.body.rows.forEach((row: any, i: number) => {
      const expected = header!.map((c) =>
        c === 'generated_at'
          ? ''
          : c === 'site_name' && row[c] === SITE_A2_NAME
            ? `'${row[c]}`
            : text(row[c]),
      );
      expect(lines[i]).toEqual(expected);
    });
    const total = lines[lines.length - 1]!;
    expect(total.slice(0, 8)).toEqual(['TOTAL', '', '', '', '', '', '', '']);
    expect(total.slice(8, 13).map(Number)).toEqual(Object.values(OPERATOR_A_NOVEMBER));
    expect(total[13]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    // Cells of text with comma, quotes and Vietnamese are quoted (RFC 4180).
    expect(csv.text).toContain(`"Trạm ""Bến Thành"", Q1"`);
    expect(lines.some((l) => l[4] === SITE_A1_NAME)).toBe(true);
  });

  it('defuses a site name starting with = in the CSV (CSV injection)', async () => {
    const csv = await call(`/operator/v1/revenue.csv?${NOV}&group_by=site`, tokens['staffa']);
    const lines = parseCsv(csv.text.slice(1));
    const site = lines.find((l) => l[3] === ids['siteA2'])!;
    expect(site[4]).toBe(`'${SITE_A2_NAME}`);
    expect(csv.text).not.toMatch(/(^|,)=SUM/m);
  });

  it('names the admin CSV by period and ends with TOTAL equal to totals', async () => {
    const csv = await call(`/admin/v1/revenue.csv?from=2026-11-01&to=2026-12-01`, tokens['admin']);
    const json = await call(`/admin/v1/revenue?from=2026-11-01&to=2026-12-01`, tokens['admin']);
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="revenue_2026-11-01_2026-12-01.csv"',
    );
    const lines = parseCsv(csv.text.slice(1));
    expect(lines).toHaveLength(json.body.rows.length + 2);
    expect(lines.at(-1)!.slice(8, 13).map(Number)).toEqual(Object.values(json.body.totals));
  });
});
