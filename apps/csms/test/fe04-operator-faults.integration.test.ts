/**
 * FE-04a — operator fault API (UC-OPS-03, screen 21; D37–D42) on real Postgres and real HTTP.
 *
 * Proves: RolesGuard in front (401 / 403 F-13), each Operator sees and acts only on its own
 * FaultEvents (404 for another Operator's, BR-P16), the staff user is recorded as actor
 * (`acknowledged_by`, `remote_commands.requested_by`), `allowed_actions` follows STM-6, kind labels,
 * and the Reset rules of the dev console (sessions_active → force, station_offline).
 * The charge point is a scripted client; OCPP frames go through `OcppServer.processCall`.
 *
 * Needs DATABASE_URL (own test DB — the schema is dropped); otherwise skipped.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { ScheduledTask, Scheduler } from '../src/common/scheduler.js';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { faultEvents, remoteCommands } from '../src/db/schema/index.js';
import {
  type Connection,
  ConnectionRegistry,
  type OcppClientLike,
} from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe04', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };
const CP_A = 'FE04-A-0001';
const CP_B = 'FE04-B-0001';
const RESET_TIMEOUT_S = 120;

class ManualScheduler implements Scheduler {
  schedule(_delayMs: number, _fn: () => void): ScheduledTask {
    return { cancel: () => undefined };
  }
}

class ScriptedChargePoint implements OcppClientLike {
  readonly identity = CP_A;
  readonly calls: { method: string; params: unknown }[] = [];
  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

describeDb('FE-04a operator fault API (D37–D42, BR-P16)', () => {
  let db: Db;
  let ocpp: OcppServer;
  let serializer: InboundSerializer;
  let faults: FaultService;
  let consoleServer: ConsoleServer;
  let chargePoint: ScriptedChargePoint;
  let conn: Connection;
  let base = '';
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let msg = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function send(action: string, params: Record<string, unknown>) {
    msg += 1;
    return serializer.run(CP_A, () =>
      ocpp.processCall(conn, { messageId: `fe04-${msg}`, action, params }, new Date()),
    );
  }
  async function status(connectorId: number, st: string, errorCode = 'NoError') {
    await send('StatusNotification', {
      connectorId,
      errorCode,
      status: st,
      timestamp: new Date().toISOString(),
    });
  }
  async function call(method: string, path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}/api/operator/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  const list = async (who: string, s = 'open') =>
    (await call('GET', `/faults?status=${s}`, tokens[who])).body.items as any[];

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const hash = await hashChargePointPassword(PASSWORD);
    for (const op of ['A', 'B']) {
      ids[`op${op}`] = (
        await q(
          `INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id::text AS id`,
          [`020000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
        )
      )[0].id;
      ids[`site${op}`] = (
        await q(
          `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
           VALUES($1,$2,$3,'x',10.7,106.7) RETURNING id::text AS id`,
          [`FE04-${op}`, ids[`op${op}`], `Tram ${op}`],
        )
      )[0].id;
      ids[`cp${op}`] = (
        await q(
          `INSERT INTO charge_points(serial_number,site_id,model,lifecycle)
           VALUES($1,$2,'D1-120',$3) RETURNING id::text AS id`,
          [
            op === 'A' ? CP_A : CP_B,
            ids[`site${op}`],
            op === 'A' ? 'awaiting_connection' : 'in_service',
          ],
        )
      )[0].id;
      await q(`INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1),($1,2)`, [
        ids[`cp${op}`],
      ]);
    }
    for (const [key, op, role] of [
      ['staffA', 'A', 'manager'],
      ['techA', 'A', 'technician'],
      ['staffB', 'B', 'manager'],
    ] as const) {
      ids[key] = (
        await q(
          `INSERT INTO users(email,full_name,role,password_hash)
           VALUES($1,$2,'operator_staff',$3) RETURNING id::text AS id`,
          [`${key.toLowerCase()}@fe04.test`, key, hash],
        )
      )[0].id;
      await q('INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,$3)', [
        ids[key],
        ids[`op${op}`],
        role,
      ]);
    }

    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
      ocppPort: 0,
      consolePort: 0,
      faultResetTimeoutS: RESET_TIMEOUT_S,
      dashboardAuth: DASH,
      driverApi: { ...DRIVER, devAuth: false },
    };
    const sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
    faults = new FaultService(db, config, new ManualScheduler());
    serializer = new InboundSerializer();
    const registry = new ConnectionRegistry(db);
    ocpp = new OcppServer(
      config,
      registry,
      new OcppMessageLogger(db),
      serializer,
      new ReplayDetector(config.replaySkewThresholdS),
      new OcppHandlers(sessionsService, config, undefined, faults),
      sessionsService,
    );
    chargePoint = new ScriptedChargePoint();
    conn = await registry.open(CP_A, chargePoint, { openedAt: new Date() });
    consoleServer = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry, faults),
      db,
    );
    await consoleServer.start();
    base = `http://127.0.0.1:${consoleServer.port}`;

    for (const key of ['staffA', 'techA', 'staffB']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${key.toLowerCase()}@fe04.test`, password: PASSWORD }),
      });
      tokens[key] = ((await r.json()) as any).access_token;
    }

    await send('BootNotification', { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' });
    await status(1, 'Available');
    await status(2, 'Available');
    await status(1, 'Faulted', 'GroundFailure');
    await faults.raiseOffline(Number(ids['cpB']));
  });

  afterAll(async () => {
    faults?.cancelAll();
    await consoleServer?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('401 without a token, 403 for a driver token (F-13)', async () => {
    expect((await call('GET', '/faults')).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const driver = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('1')
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
    expect((await call('GET', '/faults', driver)).status).toBe(403);
  });

  it('each Operator lists only its own FaultEvents, with kind, severity and allowed_actions', async () => {
    const a = await list('staffA');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      kind: 'faulted',
      charge_point_serial: CP_A,
      station_name: 'Tram A',
      connector_no: 1,
      error_code: 'GroundFailure',
      severity: 'critical',
      status: 'raised',
      reset: null,
      charge_point_online: true,
      allowed_actions: ['acknowledge'],
    });
    expect(typeof a[0].id).toBe('string');
    const b = await list('staffB');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      kind: 'offline',
      charge_point_serial: CP_B,
      connector_no: 0,
      charge_point_online: false,
    });
    // Status filter and total are scoped to the Operator too.
    const page = async (who: string, qs: string) =>
      (await call('GET', `/faults?${qs}`, tokens[who])).body;
    expect(await page('staffA', 'status=raised')).toMatchObject({ total: 1 });
    expect(await page('staffA', 'status=acknowledged')).toMatchObject({ items: [], total: 0 });
    expect(await page('staffA', 'status=all&page=2&page_size=1')).toEqual({
      items: [],
      total: 1,
      page: 2,
      page_size: 1,
    });
    expect(await page('staffB', 'status=resolved')).toEqual({
      items: [],
      total: 0,
      page: 1,
      page_size: 50,
    });
  });

  it('acting on another Operator’s FaultEvent is 404 and changes nothing', async () => {
    const [fa] = await list('staffA');
    for (const action of ['acknowledge', 'close'])
      expect((await call('POST', `/faults/${fa.id}/${action}`, tokens['staffB'])).status).toBe(404);
    const r = await call('POST', `/faults/${fa.id}/reset`, tokens['staffB'], { type: 'Soft' });
    expect(r).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((await list('staffA'))[0].status).toBe('raised');
  });

  it('acknowledge records the technician as actor; allowed_actions becomes reset + close', async () => {
    const [fa] = await list('techA');
    const r = await call('POST', `/faults/${fa.id}/acknowledge`, tokens['techA']);
    expect(r).toEqual({ status: 200, body: { id: fa.id, status: 'acknowledged' } });
    const [row] = await db
      .select()
      .from(faultEvents)
      .where(eq(faultEvents.id, Number(fa.id)));
    expect(String(row!.acknowledgedBy)).toBe(ids['techA']);
    expect((await list('staffA'))[0].allowed_actions).toEqual(['reset', 'close']);
    expect(
      (await call('POST', `/faults/${fa.id}/acknowledge`, tokens['staffA'])).body,
    ).toMatchObject({ error: 'invalid_transition' });
  });

  it('reset: bad body 400; sessions_active lists the sessions; force sends and records the staff', async () => {
    const [fa] = await list('staffA');
    for (const body of [
      {},
      { type: 'soft' },
      { type: 'Soft', force: 'yes' },
      { type: 'Soft', x: 1 },
    ])
      expect((await call('POST', `/faults/${fa.id}/reset`, tokens['staffA'], body)).status).toBe(
        400,
      );

    const started = (await send('StartTransaction', {
      connectorId: 2,
      idTag: 'FE04TAG',
      meterStart: 0,
      timestamp: new Date().toISOString(),
    })) as { transactionId: number };
    await status(2, 'Charging');
    const refused = await call('POST', `/faults/${fa.id}/reset`, tokens['staffA'], {
      type: 'Soft',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'sessions_active' });
    expect(refused.body.sessions).toEqual([{ connector_no: 2, session_id: expect.any(String) }]);
    expect(chargePoint.calls).toHaveLength(0);

    const forced = await call('POST', `/faults/${fa.id}/reset`, tokens['staffA'], {
      type: 'Hard',
      force: true,
    });
    expect(forced.body).toMatchObject({
      fault_id: fa.id,
      reset_status: 'Accepted',
      fault_status: 'resetting',
      forced: true,
    });
    expect(chargePoint.calls).toEqual([{ method: 'Reset', params: { type: 'Hard' } }]);
    const [cmd] = await db
      .select()
      .from(remoteCommands)
      .where(eq(remoteCommands.id, Number(forced.body.command_id)));
    expect(String(cmd!.requestedBy)).toBe(ids['staffA']);
    expect(cmd!.payload).toEqual({ type: 'Hard', force: true });

    const [resetting] = await list('staffA');
    expect(resetting).toMatchObject({ status: 'resetting', allowed_actions: [] });
    expect(Date.parse(resetting.reset.deadline) - cmd!.requestedAt.getTime()).toBe(
      RESET_TIMEOUT_S * 1000,
    );

    await send('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: 0,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    });
    await status(1, 'Available');
    expect(await list('staffA')).toHaveLength(0);
    expect((await list('staffA', 'all'))[0]).toMatchObject({
      status: 'resolved',
      reset: { deadline: null },
    });
  });

  it('offline charge point: driver report attaches; reset needs acknowledge, then 409 station_offline; close clears the report', async () => {
    // A driver report on the offline charge point attaches to its open FaultEvent (Q81).
    const driver = (
      await q(
        `INSERT INTO users(email,full_name,role) VALUES('driver@fe04.test','Driver','driver') RETURNING id::text AS id`,
      )
    )[0].id;
    await q("INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())", [
      driver,
    ]);
    const [connector] = await q(
      'SELECT id FROM connectors WHERE charge_point_id=$1 AND connector_no=1',
      [ids['cpB']],
    );
    await faults.reportFromDriver(Number(driver), Number(connector.id), 'Sung khong nhan the');
    const [fb] = await list('staffB');
    expect(fb).toMatchObject({ kind: 'offline', report_count: 1 });
    const early = await call('POST', `/faults/${fb.id}/reset`, tokens['staffB'], { type: 'Soft' });
    expect(early).toMatchObject({ status: 409, body: { error: 'fault_not_acknowledged' } });
    await call('POST', `/faults/${fb.id}/acknowledge`, tokens['staffB']);
    const offline = await call('POST', `/faults/${fb.id}/reset`, tokens['staffB'], {
      type: 'Soft',
    });
    expect(offline).toMatchObject({ status: 409, body: { error: 'station_offline' } });
    const closed = await call('POST', `/faults/${fb.id}/close`, tokens['staffB']);
    expect(closed).toEqual({ status: 200, body: { id: fb.id, status: 'resolved' } });
    // Closing clears the report label and records who cleared it (BR-P42).
    const [report] = await q('SELECT cleared_by::text AS by, cleared_at FROM fault_reports');
    expect(report.by).toBe(ids['staffB']);
    expect(report.cleared_at).not.toBeNull();
    expect(await list('staffB')).toHaveLength(0);
  });

  it('pages through the server order with page/page_size and filters by one status', async () => {
    const t = tokens['staffA'];
    await status(2, 'Faulted', 'HighTemperature');
    const all = (await call('GET', '/faults?status=all&page_size=100', t)).body;
    expect(all.total).toBe(all.items.length);
    expect(all.total).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < all.total; i++) {
      const one = (await call('GET', `/faults?status=all&page=${i + 1}&page_size=1`, t)).body;
      expect(one).toMatchObject({
        total: all.total,
        page: i + 1,
        items: [{ id: all.items[i].id }],
      });
    }
    for (const s of ['raised', 'acknowledged', 'resetting', 'resolved']) {
      const r = (await call('GET', `/faults?status=${s}`, t)).body;
      expect(r.items.every((f: any) => f.status === s)).toBe(true);
      expect(r.total).toBe(all.items.filter((f: any) => f.status === s).length);
    }
  });

  it('rejects bad queries and methods', async () => {
    const t = tokens['staffA'];
    expect((await call('GET', '/faults?status=bogus', t)).status).toBe(400);
    expect((await call('GET', '/faults?status=all&x=1', t)).status).toBe(400);
    expect((await call('GET', '/faults?limit=5', t)).status).toBe(400);
    expect((await call('GET', '/faults?page_size=0', t)).status).toBe(400);
    expect((await call('GET', '/faults?page_size=101', t)).status).toBe(400);
    expect((await call('GET', '/faults?page_size=5', t)).status).toBe(200);
    expect((await call('GET', '/faults?page=0', t)).status).toBe(400);
    expect((await call('GET', '/faults?page=-1', t)).status).toBe(400);
    expect((await call('GET', '/faults?page=01', t)).status).toBe(400);
    expect((await call('GET', '/faults?page=10001', t)).status).toBe(400);
    expect((await call('GET', '/faults?status=raised&page=3', t)).status).toBe(200);
    expect((await call('GET', '/me?x=1', t)).status).toBe(400);
    expect((await call('POST', '/faults/1/acknowledge?x=1', t)).status).toBe(400);
    expect((await call('GET', '/faults/1/close', t)).status).toBe(405);
    expect((await call('POST', '/faults', t)).status).toBe(405);
    expect((await call('POST', '/faults/abc/close', t)).status).toBe(404);
    expect((await call('POST', '/faults/1/explode', t)).status).toBe(404);
  });
});
