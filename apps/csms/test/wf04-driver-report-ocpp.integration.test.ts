/**
 * T131 (review #139 of FE-17) — driver fault reports against the real OCPP path: frames go through
 * OcppServer.processCall (message log, replay detection, SessionsService, OcppHandlers) on real
 * Postgres. Covers what the service-level tests in wf04-driver-report cannot:
 *   - t8 from a real StopTransaction (PowerLoss / Other do not count, a normal stop does);
 *   - a session the charge point delivers late, started before the report, does not resolve it
 *     (start time from the reconciled charge point clock, not when the CSMS received it);
 *   - a driver report racing a StatusNotification Faulted: no error, one open fault, code kept.
 *
 * Needs DATABASE_URL (skipped without it); resets the schema of that database.
 */
import { Logger } from '@nestjs/common';
import type { ScheduledTask, Scheduler } from '../src/common/scheduler.js';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/db.module.js';
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
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const CP = 'T131-CP-0001';
const MINUTE = 60_000;

class ManualScheduler implements Scheduler {
  schedule(_delayMs: number, _fn: () => void): ScheduledTask {
    return { cancel: () => undefined };
  }
}

class ScriptedChargePoint implements OcppClientLike {
  readonly identity = CP;
  async call(): Promise<unknown> {
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    return undefined;
  }
}

describeDb('T131 driver reports on the real OCPP path (review #139)', () => {
  let db: Db;
  let ocpp: OcppServer;
  let serializer: InboundSerializer;
  let faults: FaultService;
  let conn: Connection;
  let cpId = 0;
  const connectorId: Record<1 | 2, number> = { 1: 0, 2: 0 };
  const drivers: number[] = [];
  let msg = 0;
  let meter = 10_000;
  let tag = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function send(action: string, params: Record<string, unknown>) {
    msg += 1;
    return serializer.run(CP, () =>
      ocpp.processCall(conn, { messageId: `t131-${msg}`, action, params }, new Date()),
    ) as Promise<any>;
  }
  const status = (connector: 1 | 2, st: string, errorCode = 'NoError') =>
    send('StatusNotification', {
      connectorId: connector,
      errorCode,
      status: st,
      timestamp: new Date().toISOString(),
    });
  /** A whole session on the connector; `at` = the charge point's own start time. */
  async function charge(connector: 1 | 2, reason: string, at = new Date()) {
    tag += 1;
    meter += 1000;
    const started = await send('StartTransaction', {
      connectorId: connector,
      idTag: `T131-${tag}`,
      meterStart: meter,
      timestamp: at.toISOString(),
    });
    meter += 2500;
    await send('StopTransaction', {
      transactionId: started.transactionId,
      meterStop: meter,
      timestamp: new Date(at.getTime() + MINUTE).toISOString(),
      reason,
    });
  }
  const report = (driver: number, no: 1 | 2) =>
    faults.reportFromDriver(driver, connectorId[no], 'Súng không sạc được', new Date());
  const openOn = (no: 1 | 2) =>
    q(
      "SELECT id,source,error_code FROM fault_events WHERE connector_id=$1 AND status<>'resolved'",
      [connectorId[no]],
    );

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0100000131','T131 Operator') RETURNING id",
    );
    const [site] = await q(
      `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
       VALUES('T131',$1,'Trạm T131','x',10.7,106.7) RETURNING id`,
      [op.id],
    );
    cpId = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,site_id,model,lifecycle)
           VALUES($1,$2,'D1-120','awaiting_connection') RETURNING id`,
          [CP, site.id],
        )
      )[0].id,
    );
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1),($1,2)', [cpId]);
    for (const no of [1, 2] as const)
      connectorId[no] = Number(
        (
          await q('SELECT id FROM connectors WHERE charge_point_id=$1 AND connector_no=$2', [
            cpId,
            no,
          ])
        )[0].id,
      );
    for (const i of [1, 2, 3]) {
      const [u] = await q(
        "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id",
        [`t131-${i}@example.invalid`, `Tài xế ${i}`],
      );
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())",
        [u.id],
      );
      drivers.push(Number(u.id));
    }

    const config: CsmsConfig = { ...loadConfig({ DATABASE_URL }), ocppPort: 0, consolePort: 0 };
    const sessions = new SessionsService(
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
      new OcppHandlers(sessions, config, undefined, faults),
      sessions,
    );
    // Connected 2 h ago, so a late frame from 1 h ago still falls inside this connection.
    conn = await registry.open(CP, new ScriptedChargePoint(), {
      openedAt: new Date(Date.now() - 2 * 60 * MINUTE),
    });
    await send('BootNotification', { chargePointVendor: 'Ruihua', chargePointModel: 'D1-120' });
  });
  beforeEach(async () => {
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await status(1, 'Available');
    await status(2, 'Available');
  });
  afterAll(async () => {
    faults?.cancelAll();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('t8 from a real StopTransaction: PowerLoss and Other keep the label, a normal stop clears it', async () => {
    await report(drivers[0]!, 2);
    await report(drivers[1]!, 2);
    expect(await openOn(2)).toHaveLength(1);
    await charge(2, 'PowerLoss');
    await charge(2, 'Other');
    await status(2, 'Available');
    expect(await openOn(2)).toHaveLength(1);
    await charge(2, 'Local');
    expect(await openOn(2)).toEqual([]);
    const [r] = await q(
      'SELECT count(*) FILTER (WHERE cleared_at IS NULL)::int AS n FROM fault_reports',
    );
    expect(r.n).toBe(0);
  });

  it('a session the charge point delivers late, started before the report, does not clear it', async () => {
    await report(drivers[0]!, 1);
    await report(drivers[1]!, 1);
    // Charged 60 min ago while the uplink was down; StartTransaction / StopTransaction arrive now.
    await charge(1, 'Local', new Date(Date.now() - 60 * MINUTE));
    const [s] = await q(
      'SELECT delivered_offline FROM sessions WHERE connector_id=$1 ORDER BY id DESC LIMIT 1',
      [connectorId[1]],
    );
    expect(s.delivered_offline).toBe(true);
    expect(await openOn(1)).toHaveLength(1);
  });

  it('a report racing StatusNotification Faulted: no error, one open fault, the code is never lost', async () => {
    for (let round = 0; round < 6; round++) {
      await q('DELETE FROM fault_reports');
      await q('DELETE FROM fault_events');
      await status(1, 'Available');
      await faults.reportFromDriver(
        drivers[0]!,
        connectorId[1],
        'Báo trước',
        new Date(Date.now() - 5 * MINUTE),
      );
      const racers = [() => report(drivers[1]!, 1), () => status(1, 'Faulted', 'GroundFailure')];
      if (round % 2) racers.reverse();
      await Promise.all(racers.map((run) => run()));
      const open = await openOn(1);
      expect(open).toHaveLength(1);
      expect(open[0].error_code).toBe('GroundFailure');
      const [r] = await q(
        'SELECT count(*) FILTER (WHERE fault_event_id IS NULL)::int AS waiting FROM fault_reports',
      );
      expect(r.waiting).toBe(0);
    }
  });

  it('both fault writers wait on the connector row lock (FOR NO KEY UPDATE); foreign-key inserts do not', async () => {
    const holder = await db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM connectors WHERE id=$1 FOR NO KEY UPDATE', [
        connectorId[1],
      ]);
      let ocppDone = false;
      let reportDone = false;
      const ocppCall = faults
        .onConnectorStatus({
          chargePointId: cpId,
          connectorNo: 1,
          status: 'Faulted',
          errorCode: 'GroundFailure',
          receivedAt: new Date(),
        })
        .then(() => (ocppDone = true));
      const reportCall = report(drivers[2]!, 1).then(() => (reportDone = true));
      // A row referencing the connector (KEY SHARE) is not blocked by NO KEY UPDATE.
      await q(
        "INSERT INTO fault_reports(driver_id,connector_id,description,reported_at) VALUES($1,$2,'FK ok',now()-interval '3 hours')",
        [drivers[0], connectorId[1]],
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect([ocppDone, reportDone]).toEqual([false, false]);
      await holder.query('COMMIT');
      await Promise.all([ocppCall, reportCall]);
      expect(await openOn(1)).toHaveLength(1);
    } finally {
      holder.release();
    }
  });
});
