/**
 * Integration test WF-05 through the console HTTP routes (T119, owner Trần Đức Ân, WP1).
 *
 * Same workflow as `wf05-onboarding.integration.test.ts`, but driven the way the demo and the
 * future dashboard drive it: real Postgres, the real ConsoleServer (node:http) with
 * CONSOLE_ACTOR_ADMIN_ID / CONSOLE_ACTOR_STAFF_ID, and a real OCPP-J WebSocket.
 *
 *   DS-09  POST /api/admin/charge-points (Admin, UC-ADM-03, STM-3 #1) → POST
 *          /api/operator/charge-points/onboard (staff, UC-OPS-01, STM-3 #2) → the charge point
 *          connects with the returned credential → in_service (STM-3 #3), connectors Available.
 *   DS-10  wrong password → 401 and a log line; unregistered serial → 409; plus 403 for another
 *          operator's site and for an actor without the right role.
 *
 * Report 5 IDs: the STM-3 moves exercised here are TC-STM3-01..03 (unit-tested one by one in
 * charge-point-lifecycle-policy.spec.ts); no new IDs are invented here.
 *
 * Needs DATABASE_URL (skipped without it). Uses OCPP port 19606; console on a random port.
 */
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { RPCClient } from 'ocpp-rpc';
import type { CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  admins,
  chargePoints,
  connectors,
  operators,
  operatorStaff,
  sites,
  users,
} from '../src/db/schema/index.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { ChargePointAuthService } from '../src/stations/charge-point-auth.service.js';
import { ChargePointOnboardingService } from '../src/stations/charge-point-onboarding.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const OCPP_PORT = 19606;
const SERIAL = 'SIM-0005';

const BASE_CONFIG: CsmsConfig = {
  databaseUrl: DATABASE_URL ?? '',
  ocppPort: OCPP_PORT,
  heartbeatIntervalS: 300,
  sessionStartTimeoutS: 120,
  sessionHardCapH: 24,
  replaySkewThresholdS: 5,
  meterValueSampleIntervalS: 10,
  reconcileGapFactor: 3,
  reconcileEnergyToleranceWh: 1,
  consoleEnabled: false,
  consoleHost: '127.0.0.1',
  consolePort: 0,
  ocppPublicUrl: `ws://127.0.0.1:${OCPP_PORT}/ocpp`,
  // The point of T119: the onboarded charge point must connect WITHOUT the legacy switch.
  allowLegacyNoCredential: false,
};

type ClientOptions = ConstructorParameters<typeof RPCClient>[0];

function chargePointClient(identity: string, password: string | null) {
  return new RPCClient({
    endpoint: `ws://127.0.0.1:${OCPP_PORT}/ocpp`,
    identity,
    password,
    protocols: ['ocpp1.6'],
    strictMode: true,
    reconnect: false,
  } as unknown as ClientOptions);
}

describeDb('WF-05 through the console HTTP routes (T119, DS-09 / DS-10)', () => {
  let db: Db;
  let ocpp: OcppServer;
  let registry: ConnectionRegistry;
  const consoles: ConsoleServer[] = [];
  const clients: RPCClient[] = [];
  const warnings: string[] = [];
  let base = '';
  let adminId = 0;
  let staffId = 0;
  let siteAId = 0;
  let siteBId = 0;
  let password = '';

  async function startConsole(actors: { admin: number; staff: number }): Promise<string> {
    const config: CsmsConfig = {
      ...BASE_CONFIG,
      consoleActorAdminId: actors.admin,
      consoleActorStaffId: actors.staff,
    };
    const server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      undefined,
      undefined,
      new ChargePointOnboardingService(db, config),
    );
    await server.start();
    consoles.push(server);
    return `http://127.0.0.1:${String(server.port)}`;
  }

  const post = (b: string, path: string, body: unknown) =>
    fetch(`${b}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    Logger.overrideLogger({
      log: () => undefined,
      error: () => undefined,
      warn: (m: unknown) => void warnings.push(String(m)),
    });
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);

    const [opA, opB] = await db
      .insert(operators)
      .values([
        { taxCode: '0300000011', legalName: 'Operator A' },
        { taxCode: '0300000012', legalName: 'Operator B' },
      ])
      .returning({ id: operators.id });
    const [sA, sB] = await db
      .insert(sites)
      .values([
        { siteCode: 'HCM-DEMO-01', operatorId: opA!.id, siteName: 'Site A' },
        { siteCode: 'HN-B-01', operatorId: opB!.id, siteName: 'Site B' },
      ])
      .returning({ id: sites.id });
    siteAId = sA!.id;
    siteBId = sB!.id;
    const [admin, staff] = await db
      .insert(users)
      .values([
        { email: 'admin.demo@powerme.test', fullName: 'Admin Demo', role: 'admin' },
        { email: 'staff.demo@powerme.test', fullName: 'Staff Demo', role: 'operator_staff' },
      ])
      .returning({ id: users.id });
    adminId = admin!.id;
    staffId = staff!.id;
    await db.insert(admins).values({ userId: adminId });
    await db
      .insert(operatorStaff)
      .values({ userId: staffId, operatorId: opA!.id, staffRole: 'manager' });

    registry = new ConnectionRegistry(db);
    const sessions = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, BASE_CONFIG),
      BASE_CONFIG,
    );
    ocpp = new OcppServer(
      BASE_CONFIG,
      registry,
      new OcppMessageLogger(db),
      new InboundSerializer(),
      new ReplayDetector(BASE_CONFIG.replaySkewThresholdS),
      new OcppHandlers(sessions, BASE_CONFIG),
      sessions,
      new ChargePointAuthService(db, BASE_CONFIG),
    );
    await ocpp.start();
    base = await startConsole({ admin: adminId, staff: staffId });
  });

  afterAll(async () => {
    for (const c of clients) await c.close({ force: true }).catch(() => undefined);
    for (const s of consoles) await s.stop();
    await ocpp?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['error']);
  });

  it('TC-F14-04 the service role check still runs: an actor that is not an Admin gets 403 forbidden_role', async () => {
    // Admin id pointed at the staff user → registerDevice refuses it.
    const wrongActor = await startConsole({ admin: staffId, staff: staffId });
    const res = await post(wrongActor, '/api/admin/charge-points', { serial_number: SERIAL });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('forbidden_role');
  });

  it('TC-F09-05 DS-10: onboarding a serial that is not in the registry → 409 serial_not_registered', async () => {
    const res = await post(base, '/api/operator/charge-points/onboard', {
      serial_number: SERIAL,
      site_id: siteAId,
      connectors: [{ connector_no: 1 }, { connector_no: 2 }],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('serial_not_registered');
  });

  it('TC-F14-04 DS-09 step 1: Admin registers the serial → 201 registered (STM-3 #1, TC-STM3-01)', async () => {
    const res = await post(base, '/api/admin/charge-points', {
      serial_number: SERIAL,
      model: 'D1-120',
      rated_power_kw: 120,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { serial_number: string; lifecycle: string };
    expect(body).toMatchObject({ serial_number: SERIAL, lifecycle: 'registered' });
  });

  it("TC-F09-05 another operator's site → 403 site_of_other_operator", async () => {
    const res = await post(base, '/api/operator/charge-points/onboard', {
      serial_number: SERIAL,
      site_id: siteBId,
      connectors: [{ connector_no: 1 }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('site_of_other_operator');
  });

  it('TC-F09-04 DS-09 step 2: staff onboards it → 201 with the credential once, no-store (STM-3 #2, TC-STM3-02)', async () => {
    const res = await post(base, '/api/operator/charge-points/onboard', {
      serial_number: SERIAL,
      site_id: siteAId,
      connectors: [{ connector_no: 1 }, { connector_no: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      display_code: 'PM-D1-HCM-0001',
      lifecycle: 'awaiting_connection',
      ocpp_url: `ws://127.0.0.1:${OCPP_PORT}/ocpp/${SERIAL}`,
      identity: SERIAL,
    });
    expect(typeof body['password']).toBe('string');
    password = body['password'] as string;
    expect(password.length).toBeGreaterThanOrEqual(16);

    const [cp] = await db
      .select({ lifecycle: chargePoints.lifecycle, hash: chargePoints.basicAuthPasswordHash })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.lifecycle).toBe('awaiting_connection');
    expect(cp?.hash).toBeTruthy();
    expect(cp?.hash).not.toContain(password);

    const again = await post(base, '/api/operator/charge-points/onboard', {
      serial_number: SERIAL,
      site_id: siteAId,
      connectors: [{ connector_no: 1 }],
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('already_onboarded');
  });

  it('TC-F09-07 the password never reaches the log', () => {
    expect(warnings.join('\n')).not.toContain(password);
  });

  it('TC-F09-07 DS-10: the wrong password → 401 and a log line; the charge point stays awaiting_connection', async () => {
    const wrong = chargePointClient(SERIAL, 'wrong-password-123456');
    clients.push(wrong);
    await expect(wrong.connect()).rejects.toThrow(/Unauthorized/);
    expect(warnings.some((w) => w.includes(SERIAL) && w.includes('401'))).toBe(true);
    const [cp] = await db
      .select({ lifecycle: chargePoints.lifecycle })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.lifecycle).toBe('awaiting_connection');
  });

  it('DS-09 step 3: the returned credential connects → in_service, 2 connectors Available (TC-STM3-03)', async () => {
    const c = chargePointClient(SERIAL, password);
    clients.push(c);
    c.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    await c.connect();
    const boot = (await c.call('BootNotification', {
      chargePointVendor: 'Ruihua',
      chargePointModel: 'D1-120',
      chargePointSerialNumber: SERIAL,
    })) as { status: string };
    expect(boot.status).toBe('Accepted');
    for (const connectorId of [1, 2]) {
      await c.call('StatusNotification', {
        connectorId,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: new Date().toISOString(),
      });
    }

    const [cp] = await db
      .select({ id: chargePoints.id, lifecycle: chargePoints.lifecycle })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.lifecycle).toBe('in_service');
    const cons = await db
      .select({ no: connectors.connectorNo, status: connectors.status })
      .from(connectors)
      .where(eq(connectors.chargePointId, cp!.id))
      .orderBy(asc(connectors.connectorNo));
    expect(cons).toEqual([
      { no: 1, status: 'Available' },
      { no: 2, status: 'Available' },
    ]);
  });
});
