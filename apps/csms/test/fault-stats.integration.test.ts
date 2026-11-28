/**
 * Fault statistics routes for the home pages over real HTTP (ConsoleServer) and Postgres:
 *   GET /api/operator/v1/faults/stats?from=&to=
 *   GET /api/admin/v1/faults/stats?from=&to=&operator_id=
 * Vietnam days, severity from the error code, kinds, resolved count and mean time to resolve, top
 * charge points, Operator scope (BR-P16) and parameters. Needs DATABASE_URL; resets its schema.
 * Operators, stations, charge points and accounts: helpers/revenue-fixture.ts.
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
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import { buildRevenueFixture } from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe16', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb16', audience: 'app' };
const NOV = 'from=2026-11-01&to=2026-11-30';

describeDb('Fault statistics routes (home page charts; BR-P16)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  let ids: Record<string, string>;
  const tokens: Record<string, string> = {};
  async function call(path: string, token?: string) {
    const r = await fetch(`${base}/api${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    ids = (await buildRevenueFixture(db, await hashChargePointPassword(PASSWORD))).ids;
    const fault = (
      cp: string,
      source: 'ocpp' | 'driver_report',
      code: string | null,
      raisedAt: string,
      resolvedAfterS: number | null,
    ) =>
      db.$client.query(
        `INSERT INTO fault_events(charge_point_id,source,error_code,status,raised_at,resolved_at)
         VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(secs => $6::int))`,
        [
          ids[`cp${cp}`],
          source,
          code,
          resolvedAfterS === null ? 'raised' : 'resolved',
          raisedAt,
          resolvedAfterS,
        ],
      );
    // 04/11 23:30 in Vietnam (still the 4th), critical, resolved after 1 h.
    await fault('A1', 'ocpp', 'GroundFailure', '2026-11-04T16:30:00Z', 3600);
    // 05/11 00:30 in Vietnam: the next day, major, still open.
    await fault('A1', 'ocpp', 'HighTemperature', '2026-11-04T17:30:00Z', null);
    // Offline alert (major), resolved after 30 min.
    await fault('A2', 'ocpp', 'Offline', '2026-11-05T03:00:00Z', 1800);
    // Driver report without a code → OtherError (minor).
    await fault('A3', 'driver_report', null, '2026-11-10T03:00:00Z', null);
    // 31/10 23:59 in Vietnam: before the period.
    await fault('A1', 'ocpp', 'EVCommunicationError', '2026-10-31T16:59:00Z', 60);
    // Operator B.
    await fault('B1', 'ocpp', 'GroundFailure', '2026-11-06T03:00:00Z', null);

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
    for (const key of ['admin', 'staffa', 'staffb']) {
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

  it('401 without a token, 403 on the other surface', async () => {
    expect((await call(`/operator/v1/faults/stats?${NOV}`)).status).toBe(401);
    expect((await call(`/admin/v1/faults/stats?${NOV}`, tokens['staffa'])).status).toBe(403);
    expect((await call(`/operator/v1/faults/stats?${NOV}`, tokens['admin'])).status).toBe(403);
  });

  it('operator: only its own charge points, by Vietnam day, severity and kind', async () => {
    const { status, body } = await call(`/operator/v1/faults/stats?${NOV}`, tokens['staffa']);
    expect(status).toBe(200);
    expect(body.totals).toEqual({
      raised: 4,
      resolved: 2,
      by_severity: { critical: 1, major: 2, minor: 1, none: 0 },
      by_kind: { faulted: 2, offline: 1, driver_report: 1 },
      mean_time_to_resolve_s: 2700,
    });
    expect(body.days).toEqual([
      { day: '2026-11-04', critical: 1, major: 0, minor: 0, none: 0, total: 1 },
      { day: '2026-11-05', critical: 0, major: 2, minor: 0, none: 0, total: 2 },
      { day: '2026-11-10', critical: 0, major: 0, minor: 1, none: 0, total: 1 },
    ]);
    expect(body.top_charge_points.map((c: any) => [c.serial_number, c.count])).toEqual([
      ['FE16-A1', 2],
      ['FE16-A2', 1],
      ['FE16-A3', 1],
    ]);
    expect(body.top_charge_points[0].charge_point_id).toBe(ids['cpA1']);

    const b = await call(`/operator/v1/faults/stats?${NOV}`, tokens['staffb']);
    expect(b.body.totals.raised).toBe(1);
    expect(b.body.top_charge_points.map((c: any) => c.serial_number)).toEqual(['FE16-B1']);
  });

  it('admin: every Operator, or one with operator_id', async () => {
    const all = await call(`/admin/v1/faults/stats?${NOV}`, tokens['admin']);
    expect(all.status).toBe(200);
    expect(all.body.totals.raised).toBe(5);
    expect(all.body.totals.by_severity.critical).toBe(2);
    const b = await call(
      `/admin/v1/faults/stats?${NOV}&operator_id=${ids['opB']}`,
      tokens['admin'],
    );
    expect(b.body.totals.raised).toBe(1);
    const oct = await call(`/admin/v1/faults/stats?from=2026-10-01&to=2026-10-31`, tokens['admin']);
    expect(oct.body.totals).toMatchObject({ raised: 1, resolved: 1, mean_time_to_resolve_s: 60 });
  });

  it('an empty period has zero totals and no days', async () => {
    const { body } = await call(
      `/operator/v1/faults/stats?from=2026-12-01&to=2026-12-31`,
      tokens['staffa'],
    );
    expect(body.totals.raised).toBe(0);
    expect(body.totals.mean_time_to_resolve_s).toBeNull();
    expect(body.days).toEqual([]);
    expect(body.top_charge_points).toEqual([]);
  });

  it('400 on bad parameters', async () => {
    const bad = async (q: string, surface = 'operator', who = 'staffa') =>
      (await call(`/${surface}/v1/faults/stats?${q}`, tokens[who])).body.error;
    expect(await bad('from=2026-11-01')).toBe('invalid_input');
    expect(await bad('from=2026-11-31&to=2026-12-01')).toBe('invalid_input');
    expect(await bad('from=2026-11-30&to=2026-11-01')).toBe('invalid_period');
    expect(await bad('from=2025-01-01&to=2026-11-01')).toBe('invalid_period');
    expect(await bad(`${NOV}&operator_id=${ids['opB']}`)).toBe('invalid_input');
    expect(await bad(`${NOV}&operator_id=abc`, 'admin', 'admin')).toBe('invalid_input');
  });
});
