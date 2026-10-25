/**
 * Integration test WF-05 "Onboard a pillar and bring it into service" (owner Trần Đức Ân, WP1).
 *
 * Runs the whole workflow against a real Postgres and a REAL OCPP-J WebSocket:
 *   SD-5a  Admin registers the serial (STM-3 #1) → operator staff onboards it onto their own site
 *          (STM-3 #2): 403 for another operator's site, 409 for an unknown or already onboarded
 *          serial, 400 for bad connectors; success returns the credential once.
 *   SD-5b  The pillar connects with Basic auth: wrong password → 401, not onboarded → 403;
 *          right password → BootNotification Accepted, lifecycle in_service (STM-3 #3),
 *          StatusNotification Available on both connectors (STM-2 Unavailable → Available).
 *
 * Needs DATABASE_URL like the WF-03 test (skipped without it). Uses OCPP port 19605.
 */
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { RPCClient } from 'ocpp-rpc';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
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
import { PillarAuthService } from '../src/stations/pillar-auth.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import {
  OnboardingError,
  PillarOnboardingService,
} from '../src/stations/pillar-onboarding.service.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const OCPP_PORT = 19605;
const SERIAL = 'RH24D1-00077';

const CONFIG: CsmsConfig = {
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
};

async function expectOnboardingError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OnboardingError);
  expect((err as OnboardingError).code).toBe(code);
  expect((err as OnboardingError).status).toBe(status);
}

/** ocpp-rpc's typings mark every option as required; the runtime fills the defaults. */
type ClientOptions = ConstructorParameters<typeof RPCClient>[0];

function pillarClient(identity: string, password: string | null) {
  const options = {
    endpoint: `ws://127.0.0.1:${OCPP_PORT}/ocpp`,
    identity,
    password,
    protocols: ['ocpp1.6'],
    strictMode: true,
    reconnect: false,
  } as unknown as ClientOptions;
  return new RPCClient(options);
}

describeDb('WF-05 — onboard a pillar and bring it into service (SD-5a, SD-5b)', () => {
  let db: Db;
  let onboarding: PillarOnboardingService;
  let server: OcppServer;
  let adminId: number;
  let staffAId: number;
  let driverId: number;
  let siteAId: number;
  let siteBId: number;
  let password = '';
  const clients: RPCClient[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    // Clean DB, then apply 0000 → 0001 in order (same helper as the WF-03 test; the code writes 0001's `replayed` column).
    await resetAndMigrate(db.$client);

    const [opA, opB] = await db
      .insert(operators)
      .values([
        { taxCode: '0300000001', legalName: 'Operator A' },
        { taxCode: '0300000002', legalName: 'Operator B' },
      ])
      .returning({ id: operators.id });
    const [sA, sB] = await db
      .insert(sites)
      .values([
        { siteCode: 'HCM-A-01', operatorId: opA!.id, siteName: 'Site A' },
        { siteCode: 'HN-B-01', operatorId: opB!.id, siteName: 'Site B' },
      ])
      .returning({ id: sites.id });
    siteAId = sA!.id;
    siteBId = sB!.id;
    const [admin, staffA, driver] = await db
      .insert(users)
      .values([
        { email: 'admin@powerme.test', fullName: 'Admin', role: 'admin' },
        { email: 'staff.a@powerme.test', fullName: 'Staff A', role: 'operator_staff' },
        { email: 'driver@powerme.test', fullName: 'Driver', role: 'driver' },
      ])
      .returning({ id: users.id });
    adminId = admin!.id;
    staffAId = staffA!.id;
    driverId = driver!.id;
    await db
      .insert(operatorStaff)
      .values({ userId: staffAId, operatorId: opA!.id, staffRole: 'manager' });

    onboarding = new PillarOnboardingService(db, CONFIG);
    const sessions = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    server = new OcppServer(
      CONFIG,
      new ConnectionRegistry(db),
      new OcppMessageLogger(db),
      new InboundSerializer(),
      new ReplayDetector(CONFIG.replaySkewThresholdS),
      new OcppHandlers(sessions, CONFIG),
      sessions,
      new PillarAuthService(db, CONFIG),
    );
    await server.start();
  });

  afterAll(async () => {
    for (const c of clients) await c.close({ force: true }).catch(() => undefined);
    await server?.stop();
    await db?.$client.end();
  });

  // ---- SD-5a: registry + onboarding ------------------------------------------------------

  it('only an Admin can register a serial; it starts as registered (STM-3 #1)', async () => {
    await expectOnboardingError(
      onboarding.registerDevice(staffAId, { serialNumber: SERIAL }),
      'forbidden_role',
      403,
    );
    const res = await onboarding.registerDevice(adminId, { serialNumber: SERIAL, model: 'D1-120' });
    expect(res.lifecycle).toBe('registered');
    await expectOnboardingError(
      onboarding.registerDevice(adminId, { serialNumber: SERIAL }),
      'serial_already_registered',
      409,
    );
  });

  it('a registered but not onboarded pillar cannot connect (403)', async () => {
    const c = pillarClient(SERIAL, 'anything-anything-1');
    clients.push(c);
    await expect(c.connect()).rejects.toThrow(/Forbidden/); // HTTP 403;
  });

  it('rejects: not operator staff (403), site of another operator (403), unknown serial (409), bad connectors (400)', async () => {
    const ok = { serialNumber: SERIAL, siteId: siteAId, connectors: [{ connectorNo: 1 }] };
    await expectOnboardingError(onboarding.onboard(driverId, ok), 'forbidden_role', 403);
    await expectOnboardingError(
      onboarding.onboard(staffAId, { ...ok, siteId: siteBId }),
      'site_of_other_operator',
      403,
    );
    await expectOnboardingError(
      onboarding.onboard(staffAId, { ...ok, siteId: 999999 }),
      'site_not_found',
      404,
    );
    await expectOnboardingError(
      onboarding.onboard(staffAId, { ...ok, serialNumber: 'NOT-IN-REGISTRY' }),
      'serial_not_registered',
      409,
    );
    await expectOnboardingError(
      onboarding.onboard(staffAId, {
        ...ok,
        connectors: [{ connectorNo: 1 }, { connectorNo: 1 }],
      }),
      'invalid_input',
      400,
    );
    await expectOnboardingError(
      onboarding.onboard(staffAId, { ...ok, connectors: [{ connectorNo: 3 }] }),
      'invalid_input',
      400,
    );
    const [cp] = await db
      .select({ lifecycle: chargePoints.lifecycle, siteId: chargePoints.siteId })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp).toEqual({ lifecycle: 'registered', siteId: null }); // nothing written
  });

  it("onboards onto the operator's own site → awaiting_connection, 2 connectors Unavailable, credential once (STM-3 #2)", async () => {
    const res = await onboarding.onboard(staffAId, {
      serialNumber: SERIAL,
      siteId: siteAId,
      connectors: [
        { connectorNo: 1, maxPowerKw: 60 },
        { connectorNo: 2, maxPowerKw: 60 },
      ],
    });
    expect(res.lifecycle).toBe('awaiting_connection');
    expect(res.displayCode).toBe('PM-D1-HCM-0001');
    expect(res.ocppUrl).toBe(`ws://127.0.0.1:${OCPP_PORT}/ocpp/${SERIAL}`);
    expect(res.identity).toBe(SERIAL);
    expect(res.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    password = res.password;

    const [cp] = await db.select().from(chargePoints).where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.siteId).toBe(siteAId);
    expect(cp?.basicAuthPasswordHash).toMatch(/^scrypt\$/);
    expect(cp?.basicAuthPasswordHash).not.toContain(password);
    const cons = await db
      .select({ no: connectors.connectorNo, status: connectors.status })
      .from(connectors)
      .where(eq(connectors.chargePointId, cp!.id))
      .orderBy(asc(connectors.connectorNo));
    expect(cons).toEqual([
      { no: 1, status: 'Unavailable' },
      { no: 2, status: 'Unavailable' },
    ]);
  });

  it('cannot onboard the same pillar twice (409)', async () => {
    await expectOnboardingError(
      onboarding.onboard(staffAId, {
        serialNumber: SERIAL,
        siteId: siteAId,
        connectors: [{ connectorNo: 1 }],
      }),
      'already_onboarded',
      409,
    );
  });

  it('pillars onboarded at the same time in one province get distinct display codes', async () => {
    const serials = [78, 79, 80, 81, 82, 83].map((n) => `RH24D1-000${n}`);
    for (const s of serials) {
      await onboarding.registerDevice(adminId, { serialNumber: s, model: 'D1-120' });
    }
    const results = await Promise.all(
      serials.map((s) =>
        onboarding.onboard(staffAId, {
          serialNumber: s,
          siteId: siteAId,
          connectors: [{ connectorNo: 1 }],
        }),
      ),
    );
    expect(results.map((r) => r.displayCode).sort()).toEqual(
      [2, 3, 4, 5, 6, 7].map((n) => `PM-D1-HCM-000${n}`),
    );
  });

  // ---- Review of PR #33, decision 2: pillar with no credential on file ----------------------

  it('a pillar with no credential on file: 401 by default, accepted only with ALLOW_LEGACY_NO_CREDENTIAL', async () => {
    await db
      .insert(chargePoints)
      .values({ serialNumber: 'LEGACY-SEED-0001', lifecycle: 'in_service' });

    const strict = await new PillarAuthService(db, {
      ...CONFIG,
      allowLegacyNoCredential: false,
    }).verify('LEGACY-SEED-0001', undefined);
    expect(strict).toMatchObject({ ok: false, status: 401 });

    const defaulted = await new PillarAuthService(db, CONFIG).verify('LEGACY-SEED-0001', undefined);
    expect(defaulted).toMatchObject({ ok: false, status: 401 }); // the test CONFIG leaves it off

    const legacy = await new PillarAuthService(db, {
      ...CONFIG,
      allowLegacyNoCredential: true,
    }).verify('LEGACY-SEED-0001', undefined);
    expect(legacy).toMatchObject({ ok: true, credentialChecked: false });
  });

  // ---- SD-5b: first connection -----------------------------------------------------------

  it('wrong or missing credential → 401, pillar stays awaiting_connection', async () => {
    const wrong = pillarClient(SERIAL, 'wrong-password-123456');
    const none = pillarClient(SERIAL, null);
    clients.push(wrong, none);
    await expect(wrong.connect()).rejects.toThrow(/Unauthorized/); // HTTP 401;
    await expect(none.connect()).rejects.toThrow(/Unauthorized/); // HTTP 401;
    const [cp] = await db
      .select({ lifecycle: chargePoints.lifecycle })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.lifecycle).toBe('awaiting_connection');
  });

  it('right credential → Boot Accepted, in_service (STM-3 #3), connectors Available (STM-2)', async () => {
    const c = pillarClient(SERIAL, password);
    clients.push(c);
    c.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    await c.connect();

    const boot = (await c.call('BootNotification', {
      chargePointVendor: 'Ruihua',
      chargePointModel: 'D1-120',
      chargePointSerialNumber: SERIAL,
      firmwareVersion: '4.0.4.22',
    })) as { status: string; interval: number };
    expect(boot.status).toBe('Accepted');
    expect(boot.interval).toBe(300);

    for (const connectorId of [1, 2]) {
      await c.call('StatusNotification', {
        connectorId,
        errorCode: 'NoError',
        status: 'Available',
        timestamp: new Date().toISOString(),
      });
    }

    const [cp] = await db
      .select({
        id: chargePoints.id,
        lifecycle: chargePoints.lifecycle,
        epoch: chargePoints.currentEpoch,
      })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, SERIAL));
    expect(cp?.lifecycle).toBe('in_service');
    expect(cp?.epoch).toBe(1);
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
