import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
/**
 * FE-17 — driver fault report (UC-CHG-05, BR-P42, STM-6 t8) on real Postgres, plus the Driver API
 * route over HTTP (ConsoleServer, dev header auth). Rules: WF-04-PLAN Q75–Q81 (11/11/2026).
 *
 * Report 5: TC-F05-01 report visible to the owning Operator; TC-F05-02 repeated reports from
 * different drivers label the connector and hide it; TC-F05-03 one report while the connector is
 * abnormal is enough, and a report joins an open fault. T131 (review #139, D-G 14/11): no status
 * change closes a driver report, a hardware code is recorded on it, one driver opens at most one
 * fault per charge point by themselves; the OCPP path is in wf04-driver-report-ocpp.
 *
 * Needs DATABASE_URL (skipped without it); resets the schema of that database.
 */
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { DriverReportError, FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const HOUR = 3600_000;

describeDb('FE-17 driver fault report (UC-CHG-05, BR-P42, STM-6 t8)', () => {
  let db: Db;
  let faults: FaultService;
  let server: ConsoleServer;
  let base = '';
  let cp = 0;
  const conn: Record<1 | 2, number> = { 1: 0, 2: 0 };
  const drivers: number[] = [];
  const vehicles: string[] = [];
  let txNo = 1000;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  const report = (driver: number, no: 1 | 2 = 1, at = new Date(), text = 'Súng không sạc được') =>
    faults.reportFromDriver(driver, conn[no], text, at);
  const openEvents = () =>
    q("SELECT id,source,connector_id,status FROM fault_events WHERE status<>'resolved'");
  async function http(method: string, path: string, body?: unknown, driver?: number) {
    const headers: Record<string, string> = {};
    if (driver !== undefined) headers['X-Driver-Id'] = String(driver);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers,
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as any) : null };
  }
  const listedConnectors = async (extra = '') =>
    (
      await http('GET', `/stations?vehicle_id=${vehicles[0]}${extra}`, undefined, drivers[0])
    ).body.items.flatMap((s: any) => s.connectors.map((c: any) => c.connector_no));
  /** `late`: the charge point delivered it after reconnecting, its own start time `cpStartedAt`. */
  async function session(
    no: 1 | 2,
    startedAt: Date,
    energyWh: number,
    reason: string | null,
    late?: { cpStartedAt: Date },
  ) {
    txNo += 1;
    await q(
      `INSERT INTO sessions(transaction_no,charge_point_id,connector_id,connector_no,id_tag,origin,payment_mode,
        status,meter_start_wh,meter_stop_wh,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,
        stop_reason,delivered_offline)
       VALUES($1,$2,$3,$4,$9,'rfid','unattributed','closed',1000,$5,$10,$6,$7,$7,$8,$11)`,
      [
        txNo,
        cp,
        conn[no],
        no,
        1000 + energyWh,
        startedAt,
        new Date(startedAt.getTime() + 60_000),
        reason,
        `FE17-${txNo}`,
        late?.cpStartedAt ?? startedAt,
        late !== undefined,
      ],
    );
    return faults.onSessionCompleted(txNo);
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0100000017','FE17 Operator') RETURNING id",
    );
    const [site] = await q(
      `INSERT INTO sites(operator_id,site_code,site_name,latitude,longitude)
       VALUES($1,'FE17','Trạm FE17',10.776,106.700) RETURNING id`,
      [op.id],
    );
    cp = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,display_code,site_id,rated_power_kw,lifecycle,is_online,
            last_message_at,online_changed_at,current_epoch)
           VALUES('FE17-CP','FE17-CP',$1,120,'in_service',true,now(),now()-interval '1 minute',1) RETURNING id`,
          [site.id],
        )
      )[0].id,
    );
    for (const no of [1, 2] as const)
      conn[no] = Number(
        (
          await q(
            `INSERT INTO connectors(charge_point_id,connector_no,max_power_kw,status,status_changed_at)
             VALUES($1,$2,120,'Available',now()) RETURNING id`,
            [cp, no],
          )
        )[0].id,
      );
    const [model] = await q(
      "INSERT INTO vehicle_models(brand,model_name,battery_capacity_kwh,rated_range_km,max_dc_kw) VALUES('T','FE17',60,400,100) RETURNING id",
    );
    for (const i of [1, 2, 3]) {
      const [u] = await q(
        "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id",
        [`fe17-${i}@example.invalid`, `Tài xế ${i}`],
      );
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'v1',now())",
        [u.id],
      );
      const [v] = await q(
        'INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,$3) RETURNING id::text AS id',
        [u.id, model.id, `FE17-${i}`],
      );
      drivers.push(Number(u.id));
      vehicles.push(v.id);
    }
    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
      consolePort: 0,
      driverApi: { devAuth: true },
    };
    faults = new FaultService(db, config);
    const registry = new ConnectionRegistry(db);
    const policy = loadChargePolicy({});
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry, faults),
      db,
      new DriverChargingService(
        db,
        registry,
        new ChargeSettlementService(
          db,
          new CreditLedgerService(db),
          new LoyaltyService(policy),
          policy,
        ),
        policy,
      ),
      undefined, // onboarding
      undefined, // topUps (T32)
      faults,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });
  beforeEach(async () => {
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await q('TRUNCATE sessions CASCADE');
    await q(
      "UPDATE connectors SET status='Available',status_changed_at=now() WHERE charge_point_id=$1",
      [cp],
    );
    await q('UPDATE charge_points SET is_online=true,last_message_at=now() WHERE id=$1', [cp]);
  });
  afterAll(async () => {
    faults?.cancelAll();
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('TC-F05-01: one report is stored and waits; a second driver raises a driver_report fault the Operator sees with both texts', async () => {
    const first = await report(drivers[0]!, 1, new Date(), 'Cắm vào không nhận xe');
    expect(first).toMatchObject({ faultEventId: null, reportedIssue: false });
    expect(await openEvents()).toEqual([]);

    const second = await report(drivers[1]!, 1, new Date(), 'Báo lỗi ngay khi bắt đầu');
    expect(second.reportedIssue).toBe(true);
    const [event] = await openEvents();
    expect(event).toMatchObject({ source: 'driver_report', status: 'raised' });
    expect(Number(event.connector_id)).toBe(conn[1]);
    expect(second.faultEventId).toBe(Number(event.id));

    const listed = (await faults.list('open', 20)).find((f) => f.id === Number(event.id));
    expect(listed).toMatchObject({ source: 'driver_report', reportCount: 2, connectorNo: 1 });
    expect((await faults.reportsOf(Number(event.id))).map((r) => r.description)).toEqual([
      'Cắm vào không nhận xe',
      'Báo lỗi ngay khi bắt đầu',
    ]);
  });

  it('TC-F05-02: the labelled connector is hidden from search (normal and smart) and the QR lookup shows reported_issue', async () => {
    expect(await listedConnectors()).toEqual([1, 2]);
    await report(drivers[0]!);
    await report(drivers[1]!);
    expect(await listedConnectors()).toEqual([2]);
    expect(
      await listedConnectors('&sort=smart&soc_percent=40&latitude=10.77&longitude=106.69'),
    ).toEqual([2]);
    const qr = await http(
      'GET',
      `/connectors/by-code/FE17-CP/1?vehicle_id=${vehicles[0]}`,
      undefined,
      drivers[0],
    );
    expect([qr.status, qr.body.reported_issue]).toEqual([200, true]);
    const other = await http(
      'GET',
      `/connectors/by-code/FE17-CP/2?vehicle_id=${vehicles[0]}`,
      undefined,
      drivers[0],
    );
    expect(other.body.reported_issue).toBe(false);
  });

  it('BR-P42: the same driver counts once, a second driver after 2 h does not label, and a repeat within 60 s is refused', async () => {
    const t0 = new Date(Date.now() - 5 * HOUR);
    await report(drivers[0]!, 1, t0);
    await expect(report(drivers[0]!, 1, new Date(t0.getTime() + 30_000))).rejects.toEqual(
      new DriverReportError('duplicate_report'),
    );
    expect((await report(drivers[0]!, 1, new Date(t0.getTime() + 10 * 60_000))).reportedIssue).toBe(
      false,
    );
    expect(
      (await report(drivers[1]!, 1, new Date(t0.getTime() + 2 * HOUR + 15 * 60_000))).reportedIssue,
    ).toBe(false);
    expect(await openEvents()).toEqual([]);
    expect((await q('SELECT count(*)::int AS n FROM fault_reports'))[0].n).toBe(3);
  });

  it('TC-F05-03: one report is enough while the connector is Unavailable or the charge point Offline, and joins an open fault', async () => {
    await q("UPDATE connectors SET status='Unavailable' WHERE id=$1", [conn[1]]);
    expect((await report(drivers[0]!, 1)).reportedIssue).toBe(true);
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await q("UPDATE connectors SET status='Available'");

    await q("UPDATE charge_points SET last_message_at=now()-interval '1 hour' WHERE id=$1", [cp]);
    expect((await report(drivers[0]!, 2)).reportedIssue).toBe(true);
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await q('UPDATE charge_points SET last_message_at=now() WHERE id=$1', [cp]);

    const faulted = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 1,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      receivedAt: new Date(),
    });
    expect(faulted.kind).toBe('raised');
    const joined = await report(drivers[2]!, 1);
    expect(joined.faultEventId).toBe((faulted as { faultId: number }).faultId);
    expect(await openEvents()).toHaveLength(1);
  });

  it('Q79: a fault opening on the connector picks up waiting reports from the last 2 h only', async () => {
    const now = Date.now();
    await report(drivers[0]!, 1, new Date(now - 3 * HOUR), 'Cũ, quá 2 giờ');
    await report(drivers[1]!, 1, new Date(now - 30 * 60_000), 'Mới trong 2 giờ');
    const raised = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 1,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      receivedAt: new Date(now),
    });
    const attached = await faults.reportsOf((raised as { faultId: number }).faultId);
    expect(attached.map((r) => r.description)).toEqual(['Mới trong 2 giờ']);
  });

  it('t8 / Q77: a normal session after the report resolves it and clears the label; EmergencyStop or 0 Wh does not', async () => {
    await report(drivers[0]!);
    await report(drivers[1]!);
    const [event] = await openEvents();
    const after = new Date(Date.now() + 1000);
    expect(await session(1, after, 0, null)).toBe('none');
    expect(await session(1, after, 5000, 'EmergencyStop')).toBe('none');
    expect(await session(2, after, 5000, null)).toBe('none'); // other connector
    expect(await session(1, new Date(Date.now() - HOUR), 5000, 'Local')).toBe('none'); // started before
    // T131: received after the report, but sent late by the charge point and its clock is not
    // verified → start time unknown, no t8 (the Operator closes it).
    expect(
      await session(1, after, 5000, 'Local', { cpStartedAt: new Date(Date.now() - HOUR) }),
    ).toBe('none');
    expect(await openEvents()).toHaveLength(1);
    expect(await session(1, after, 5000, 'Local')).toBe('resolved');
    expect(await openEvents()).toEqual([]);
    const reports = await q('SELECT cleared_at FROM fault_reports WHERE fault_event_id=$1', [
      event.id,
    ]);
    expect(reports.every((r: any) => r.cleared_at !== null)).toBe(true);
    expect(await listedConnectors()).toEqual([1, 2]);
  });

  it('T131 / D-G: no status change resolves a driver report, a hardware code is recorded, operator close clears the label', async () => {
    const status = (st: string, errorCode = 'NoError') =>
      faults.onConnectorStatus({
        chargePointId: cp,
        connectorNo: 1,
        status: st,
        errorCode,
        receivedAt: new Date(Date.now() + 1000),
      });
    await report(drivers[0]!);
    await report(drivers[1]!);
    // Reboot (Unavailable → Available), plug-in, and plain Available: the label stays.
    for (const st of ['Unavailable', 'Available', 'Preparing', 'Available'])
      expect((await status(st)).kind).toBe('none');
    const [event] = await openEvents();
    expect(event).toMatchObject({ source: 'driver_report', status: 'raised' });

    // A real hardware fault during the report: recorded once (first code kept), still one fault.
    expect(await status('Faulted', 'GroundFailure')).toEqual({
      kind: 'attached',
      faultId: Number(event.id),
      errorCode: 'GroundFailure',
    });
    expect(await status('Faulted', 'HighTemperature')).toEqual({
      kind: 'attached',
      faultId: Number(event.id),
    });
    expect(await openEvents()).toHaveLength(1);
    const listed = (await faults.list('open', 20)).find((f) => f.id === Number(event.id));
    expect(listed).toMatchObject({
      source: 'driver_report',
      errorCode: 'GroundFailure',
      severity: 'critical',
    });
    expect((await status('Available')).kind).toBe('none');

    await faults.acknowledge(Number(event.id), null);
    await faults.close(Number(event.id), null);
    const [r] = await q(
      'SELECT count(*) FILTER (WHERE cleared_at IS NULL)::int AS open FROM fault_reports WHERE fault_event_id=$1',
      [event.id],
    );
    expect(r.open).toBe(0);
    expect(await openEvents()).toEqual([]);
  });

  it('T131: one driver alone opens at most one fault per charge point in 2 h; a second driver still labels', async () => {
    await q("UPDATE charge_points SET last_message_at=now()-interval '1 hour' WHERE id=$1", [cp]);
    expect((await report(drivers[0]!, 1)).reportedIssue).toBe(true);
    const second = await report(drivers[0]!, 2);
    expect(second).toMatchObject({ faultEventId: null, reportedIssue: false });
    expect(await openEvents()).toHaveLength(1);
    // The waiting report still counts for BR-P42's two different drivers.
    expect((await report(drivers[1]!, 2)).reportedIssue).toBe(true);
    const events = await openEvents();
    expect(events.map((e: any) => Number(e.connector_id)).sort()).toEqual(
      [conn[1], conn[2]].sort(),
    );
    // A fault another driver took part in does not count against this driver.
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await report(drivers[0]!, 1, new Date(Date.now() - 10 * 60_000));
    await report(drivers[1]!, 1, new Date(Date.now() - 9 * 60_000));
    expect((await report(drivers[0]!, 2)).reportedIssue).toBe(true);
  });

  it('T141 / D-X: an OCPP fault closing on Available hands its reports to a driver_report fault; only Operator close clears the label', async () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
    const status = (st: string, errorCode = 'NoError', offsetMs = 1000) =>
      faults.onConnectorStatus({
        chargePointId: cp,
        connectorNo: 1,
        status: st,
        errorCode,
        receivedAt: at(offsetMs),
      });
    const qrIssue = async () =>
      (
        await http(
          'GET',
          `/connectors/by-code/FE17-CP/1?vehicle_id=${vehicles[0]}`,
          undefined,
          drivers[0],
        )
      ).body.reported_issue;
    const ocpp = await status('Faulted', 'GroundFailure', 0);
    const ocppId = (ocpp as { faultId: number }).faultId;
    expect((await report(drivers[0]!, 1)).faultEventId).toBe(ocppId); // one driver joins it
    expect(await qrIssue()).toBe(true);

    const closed = await status('Available');
    expect(closed).toMatchObject({ kind: 'resolved', faultId: ocppId });
    const [event] = await openEvents();
    expect(event).toMatchObject({ source: 'driver_report', status: 'raised' });
    expect(Number(event.connector_id)).toBe(conn[1]);
    expect(closed).toMatchObject({
      handedOver: [{ toFaultId: Number(event.id), reports: 1, created: true }],
    });
    const [r] = await q('SELECT fault_event_id::text AS f, cleared_at FROM fault_reports');
    expect([r.f, r.cleared_at]).toEqual([event.id, null]);
    expect(await qrIssue()).toBe(true); // label kept (BR-P42, D-X)
    expect(await listedConnectors()).toEqual([2]); // still hidden

    // No later status closes it (D-G); the Operator does, and records who cleared it.
    expect((await status('Available', 'NoError', 2000)).kind).toBe('none');
    const [staff] = await q(
      "INSERT INTO users(email,full_name,role) VALUES('t141-staff@example.invalid','Staff','operator_staff') RETURNING id",
    );
    await q(
      "INSERT INTO operator_staff(user_id,operator_id,staff_role) SELECT $1,operator_id,'technician' FROM sites LIMIT 1",
      [staff.id],
    );
    await faults.acknowledge(Number(event.id), Number(staff.id));
    await faults.close(Number(event.id), Number(staff.id));
    const [after] = await q('SELECT cleared_at, cleared_by::text AS by FROM fault_reports');
    expect(after.cleared_at).not.toBeNull();
    expect(after.by).toBe(String(staff.id));
    expect(await qrIssue()).toBe(false);
    expect(await listedConnectors()).toEqual([1, 2]);
  });

  it('T141: an Offline fault closing on reconnect hands reports on each connector to its own driver_report fault', async () => {
    const offline = await faults.raiseOffline(cp, new Date(Date.now() - 1000));
    const offlineId = (offline as { faultId: number }).faultId;
    expect((await report(drivers[0]!, 1)).faultEventId).toBe(offlineId);
    expect((await report(drivers[1]!, 2)).faultEventId).toBe(offlineId);
    // The charge point talks again after the fault was raised.
    await q(
      "UPDATE charge_points SET is_online=true,last_message_at=now()+interval '1 second' WHERE id=$1",
      [cp],
    );
    expect(await faults.resolveOffline(offlineId, new Date(Date.now() + 2000))).toBe('resolved');
    const events = await openEvents();
    expect(events.map((e: any) => [e.source, Number(e.connector_id)]).sort()).toEqual(
      [
        ['driver_report', conn[1]],
        ['driver_report', conn[2]],
      ].sort(),
    );
    const reports = await q(
      'SELECT connector_id::text AS c, fault_event_id::text AS f, cleared_at FROM fault_reports ORDER BY connector_id',
    );
    for (const r of reports) {
      expect(r.cleared_at).toBeNull();
      expect(events.find((e: any) => e.connector_id === r.c)?.id).toBe(r.f);
    }
  });

  it('T159: a fault created by hand-over does not count toward the one-driver limit (ADR-0019 §6, BR-P42)', async () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
    // Driver 0 reports connector 1 while it is Faulted: the report joins the OCPP fault.
    await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 1,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      receivedAt: at(0),
    });
    expect((await report(drivers[0]!, 1)).reportedIssue).toBe(true);
    // The OCPP fault closes on Available: the report moves to a new driver_report fault.
    const closed = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 1,
      status: 'Available',
      errorCode: 'NoError',
      receivedAt: at(1000),
    });
    expect(closed).toMatchObject({ handedOver: [{ reports: 1, created: true }] });
    // The charge point goes Offline; driver 0 alone may still open one fault on connector 2,
    // because the hand-over fault was not opened by the driver.
    await q("UPDATE charge_points SET last_message_at=now()-interval '1 hour' WHERE id=$1", [cp]);
    expect((await report(drivers[0]!, 2)).reportedIssue).toBe(true);
    expect((await openEvents()).map((e: any) => Number(e.connector_id)).sort()).toEqual(
      [conn[1], conn[2]].sort(),
    );
  });

  it('T141: reports join a fault already open on the connector; a fault without reports closes as before', async () => {
    // Whole charge point Faulted (connector 0) with a report on connector 1, while connector 1
    // has its own open fault: the report joins that fault, no new one.
    const cpFault = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 0,
      status: 'Faulted',
      errorCode: 'PowerMeterFailure',
      receivedAt: new Date(Date.now() - 2000),
    });
    const cpFaultId = (cpFault as { faultId: number }).faultId;
    const [own] = await q(
      `INSERT INTO fault_events(charge_point_id,connector_id,source,error_code,status,raised_at)
       VALUES($1,$2,'ocpp','GroundFailure','raised',now()) RETURNING id::text AS id`,
      [cp, conn[1]],
    );
    await q(
      `INSERT INTO fault_reports(driver_id,connector_id,description,reported_at,fault_event_id)
       VALUES($1,$2,'Báo khi cả trụ lỗi',now(),$3)`,
      [drivers[0], conn[1], cpFaultId],
    );
    const closed = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 0,
      status: 'Available',
      errorCode: 'NoError',
      receivedAt: new Date(Date.now() + 1000),
    });
    expect(closed).toMatchObject({
      kind: 'resolved',
      handedOver: [{ toFaultId: Number(own.id), reports: 1, created: false }],
    });
    expect((await openEvents()).map((e: any) => e.id)).toEqual([own.id]);

    // An OCPP fault with no reports: resolved, no handover, nothing new.
    await q('DELETE FROM fault_reports');
    await q('DELETE FROM fault_events');
    await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 2,
      status: 'Faulted',
      errorCode: 'GroundFailure',
      receivedAt: new Date(Date.now() - 1000),
    });
    const plain = await faults.onConnectorStatus({
      chargePointId: cp,
      connectorNo: 2,
      status: 'Available',
      errorCode: 'NoError',
      receivedAt: new Date(Date.now() + 1000),
    });
    expect(plain.kind).toBe('resolved');
    expect(plain).not.toHaveProperty('handedOver');
    expect(await openEvents()).toEqual([]);
  });

  it('POST /connectors/{id}/fault-reports: 201, validation, 401, 404, 409, 405', async () => {
    const path = `/connectors/${conn[2]}/fault-reports`;
    const created = await http(
      'POST',
      path,
      { description: '  Màn hình báo lỗi E21  ' },
      drivers[2],
    );
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      report_id: expect.stringMatching(/^[1-9][0-9]*$/),
      report_no: expect.stringMatching(/^[1-9][0-9]*$/),
      connector_id: String(conn[2]),
      reported_at: expect.any(String),
      fault_event_id: null,
      reported_issue: false,
    });
    expect((await q('SELECT description FROM fault_reports'))[0].description).toBe(
      'Màn hình báo lỗi E21',
    );
    expect(
      (await http('POST', path, { description: 'Lần hai ngay sau' }, drivers[2])).body,
    ).toEqual({
      error: 'duplicate_report',
      detail: 'duplicate_report',
    });
    for (const [body, status] of [
      [{ description: 'ab' }, 400],
      [{ description: 'x'.repeat(501) }, 400],
      [{ description: 'Hợp lệ nhưng thừa trường', category: 'x' }, 400],
      ['not json', 400],
    ] as const)
      expect(
        (await http('POST', `/connectors/${conn[1]}/fault-reports`, body, drivers[0])).status,
      ).toBe(status);
    const wrongType = await fetch(`${base}/api/driver/v1${path}`, {
      method: 'POST',
      headers: { 'X-Driver-Id': String(drivers[0]), 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(wrongType.status).toBe(415);
    expect((await http('POST', path, { description: 'Không đăng nhập' })).status).toBe(401);
    expect(
      (
        await http(
          'POST',
          '/connectors/999999/fault-reports',
          { description: 'Không có súng này' },
          drivers[0],
        )
      ).status,
    ).toBe(404);
    expect((await http('GET', path, undefined, drivers[0])).status).toBe(405);
  });
});
