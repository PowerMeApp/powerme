/**
 * T108b — Admin transaction routes over real HTTP (ConsoleServer) and Postgres:
 *   GET /api/admin/v1/transactions, GET /api/admin/v1/transactions.csv
 * RolesGuard (admin only), parameters (TransactionsBadRequest; no paging on the CSV), CSV (§4.1, K9:
 * BOM, header, every cell = the JSON in UTC+7, TOTAL line, CSV injection, headers, null cells).
 * Numbers and the row cap: fe16-transactions. Needs DATABASE_URL; resets its schema.
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
import { TRANSACTION_COLUMNS } from '../src/operator-api/transactions-csv.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import { buildRevenueFixture, SITE_A1_NAME, SITE_A2_NAME } from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe16', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb16', audience: 'app' };
const NOV = 'from=2026-11-01&to=2026-11-30';
const TIME_COLUMNS = new Set(['started_at', 'stopped_at', 'period_at']);

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

/** What the CSV cell of a JSON value must read after RFC 4180 unquoting. */
function expectedCell(column: string, value: unknown): string {
  if (value === null) return '';
  if (TIME_COLUMNS.has(column)) {
    // UTC+7 with offset, computed here independently of the implementation.
    const t = new Date(Date.parse(value as string) + 7 * 3_600_000);
    return `${t.toISOString().slice(0, 19)}+07:00`;
  }
  const text = String(value);
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

describeDb('T108b admin transaction routes (UC-ADM-10; K9, K10)', () => {
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
  const admin = (path: string) => call(path, tokens['admin']);

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
    for (const key of ['admin', 'staffa']) {
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

  it('401 without a token (also with a query), 403 for staff and driver tokens', async () => {
    expect((await call(`/admin/v1/transactions?${NOV}`)).status).toBe(401);
    expect((await call(`/admin/v1/transactions.csv?${NOV}`)).status).toBe(401);
    expect((await call('/admin/v1/transactions')).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const driver = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ids['driver']!)
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
    for (const token of [tokens['staffa'], driver]) {
      expect((await call(`/admin/v1/transactions?${NOV}`, token)).status).toBe(403);
      expect((await call(`/admin/v1/transactions.csv?${NOV}`, token)).status).toBe(403);
    }
    // No operator route for transactions (with a query it is 400 first, §2.2a).
    expect((await call('/operator/v1/transactions', tokens['staffa'])).status).toBe(404);
  });

  it('200 JSON with paging and Operator filter', async () => {
    const r = await admin(
      `/admin/v1/transactions?${NOV}&operator_id=${ids['opA']}&page_size=2&page=2`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({ page: 2, page_size: 2, total: 11, currency: 'VND' });
    expect(r.body.items).toHaveLength(2);
    expect(Object.keys(r.body)).toEqual(
      expect.arrayContaining(['totals', 'pending_reconciliation', 'unsettled', 'generated_at']),
    );
    const d = await admin(`/admin/v1/transactions?${NOV}`);
    expect(d.body).toMatchObject({ page: 1, page_size: 50, total: 15 });
  });

  it.each([
    ['to=2026-11-30', 'invalid_input'],
    ['from=2026-11-01', 'invalid_input'],
    ['from=2026-02-30&to=2026-03-01', 'invalid_input'],
    ['from=1/11/2026&to=2026-11-30', 'invalid_input'],
    ['from=2026-12-01&to=2026-11-30', 'invalid_period'],
    ['from=2026-01-01&to=2027-01-02', 'invalid_period'],
    [`${NOV}&kind=revenue`, 'invalid_input'],
    [`${NOV}&origin=cash`, 'invalid_input'],
    [`${NOV}&operator_id=abc`, 'invalid_input'],
    [`${NOV}&site_id=0`, 'invalid_input'],
    [`${NOV}&charge_point_id=-1`, 'invalid_input'],
    [`${NOV}&group_by=site`, 'invalid_input'],
    [`${NOV}&from=2026-11-02`, 'invalid_input'],
    [`${NOV}&kind=csms_billed&kind=unsettled`, 'invalid_input'],
    [`${NOV}&page=0`, 'invalid_input'],
    [`${NOV}&page=10001`, 'invalid_input'],
    [`${NOV}&page_size=101`, 'invalid_input'],
    [`${NOV}&page_size=0`, 'invalid_input'],
    [`${NOV}&page=01`, 'invalid_input'],
  ])('400 on the JSON route for %s', async (query, error) => {
    const r = await admin(`/admin/v1/transactions?${query}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error, detail: error });
  });

  it.each([
    [`${NOV}&page=1`, 'invalid_input'],
    [`${NOV}&page_size=50`, 'invalid_input'],
    [`${NOV}&origin=cash`, 'invalid_input'],
    ['from=2026-12-01&to=2026-11-30', 'invalid_period'],
  ])('400 JSON (no CSV body) on the CSV route for %s', async (query, error) => {
    const r = await admin(`/admin/v1/transactions.csv?${query}`);
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.body.error).toBe(error);
  });

  it('CSV: BOM, header, one line per JSON row in the same order, cells equal in UTC+7, TOTAL', async () => {
    const json = await admin(`/admin/v1/transactions?${NOV}&page_size=100`);
    const csv = await admin(`/admin/v1/transactions.csv?${NOV}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="transactions_2026-11-01_2026-11-30.csv"',
    );
    expect(csv.headers.get('cache-control')).toBe('no-store');
    expect(Number(csv.headers.get('content-length'))).toBe(csv.bytes.length);
    expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.text.endsWith('\r\n')).toBe(true);

    const lines = parseCsv(csv.text.slice(1));
    const header = [...TRANSACTION_COLUMNS, 'generated_at'];
    expect(lines[0]).toEqual(header);
    expect(header).toHaveLength(25);
    expect(lines).toHaveLength(json.body.total + 2);
    json.body.items.forEach((item: Record<string, unknown>, i: number) => {
      const line = lines[i + 1]!;
      expect(line).toHaveLength(header.length);
      expect(line.slice(0, 24)).toEqual(TRANSACTION_COLUMNS.map((c) => expectedCell(c, item[c])));
      expect(line[24]).toBe('');
    });

    const total = lines.at(-1)!;
    const at = (c: string) => total[header.indexOf(c)];
    expect(at('session_id')).toBe('TOTAL');
    expect(at('amount_vnd')).toBe(String(json.body.totals.csms_billed_revenue_vnd));
    const energy = json.body.items.reduce((s: number, r: any) => s + (r.energy_wh ?? 0), 0);
    expect(at('energy_wh')).toBe(String(energy));
    expect(at('generated_at')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    const filled = header.filter((c) => at(c) !== '');
    expect(filled).toEqual(['session_id', 'energy_wh', 'amount_vnd', 'generated_at']);

    // A known row in Vietnam time, and the user-typed names.
    const billed4 = lines.find((l) => l[0] === ids['A.billed4'])!;
    expect(billed4[header.indexOf('started_at')]).toBe('2026-11-01T07:00:00+07:00');
    expect(billed4[header.indexOf('period_at')]).toBe('2026-11-10T10:00:00+07:00');
    expect(billed4[header.indexOf('site_name')]).toBe(SITE_A1_NAME);
    expect(billed4[header.indexOf('delivered_offline')]).toBe('true');
    const card = lines.find((l) => l[0] === ids['A.billedCard'])!;
    expect(card[header.indexOf('site_name')]).toBe(`'${SITE_A2_NAME}`);
    // Raw text: comma / quotes are quoted RFC 4180 style, injection guard in front.
    expect(csv.text).toContain('"Trạm ""Bến Thành"", Q1"');
    expect(csv.text).toContain(`,'=SUM(A1),`);
  });

  it('CSV with a null meter reading: empty cells, no shifted columns, TOTAL skips null (§4.1)', async () => {
    const q = `from=2026-10-01&to=2026-10-31&operator_id=${ids['opA']}`;
    const json = await admin(`/admin/v1/transactions?${q}`);
    const csv = await admin(`/admin/v1/transactions.csv?${q}`);
    expect(csv.headers.get('content-disposition')).toBe(
      'attachment; filename="transactions_2026-10-01_2026-10-31.csv"',
    );
    const lines = parseCsv(csv.text.slice(1));
    const header = lines[0]!;
    expect(lines).toHaveLength(json.body.total + 2);
    expect(lines).toHaveLength(4);
    const row = lines.find((l) => l[0] === ids['A.oct.nullEnergy'])!;
    expect(row).toHaveLength(header.length);
    expect(row[header.indexOf('energy_wh')]).toBe('');
    expect(row[header.indexOf('stopped_at')]).toBe('');
    expect(row[header.indexOf('amount_vnd')]).toBe('8000');
    expect(row[header.indexOf('period_at')]).toBe('2026-10-15T10:00:00+07:00');
    expect(row[header.indexOf('delivered_offline')]).toBe('false');
    const total = lines.at(-1)!;
    expect(total).toHaveLength(header.length);
    expect(total[header.indexOf('energy_wh')]).toBe('1200');
    expect(total[header.indexOf('amount_vnd')]).toBe('14000');
  });
});
