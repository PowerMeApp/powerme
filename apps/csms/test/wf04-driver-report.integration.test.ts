/**
 * FE-17 — driver fault report (UC-CHG-05, BR-P42, STM-6 t8) on real Postgres, plus the Driver API
 * route over HTTP (ConsoleServer, dev header auth). Rules: WF-04-PLAN Q75–Q81 (11/11/2026).
 *
 * Report 5: TC-F05-01 report visible to the owning Operator; TC-F05-02 repeated reports from
 * different drivers label the connector and hide it; TC-F05-03 one report while the connector is
 * abnormal is enough, and a report joins an open fault.
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
  async function session(no: 1 | 2, startedAt: Date, energyWh: number, reason: string | null) {
    txNo += 1;
    await q(
      `INSERT INTO sessions(transaction_no,charge_point_id,connector_id,connector_no,id_tag,origin,payment_mode,
        status,meter_start_wh,meter_stop_wh,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,stop_reason)
       VALUES($1,$2,$3,$4,$9,'rfid','unattributed','closed',1000,$5,$6,$6,$7,$7,$8)`,
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
      new DriverChargingService(db, registry, new ChargeSettlementService(db, policy), policy),
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
    expect(await openEvents()).toHaveLength(1);
    expect(await session(1, after, 5000, 'Local')).toBe('resolved');
    expect(await openEvents()).toEqual([]);
    const reports = await q('SELECT cleared_at FROM fault_reports WHERE fault_event_id=$1', [
      event.id,
    ]);
    expect(reports.every((r: any) => r.cleared_at !== null)).toBe(true);
    expect(await listedConnectors()).toEqual([1, 2]);
  });

  it('Q76: Preparing does not resolve a driver-report fault, Available does; operator close clears the label too', async () => {
    const status = (st: string) =>
      faults.onConnectorStatus({
        chargePointId: cp,
        connectorNo: 1,
        status: st,
        errorCode: 'NoError',
        receivedAt: new Date(Date.now() + 1000),
      });
    await report(drivers[0]!);
    await report(drivers[1]!);
    expect((await status('Preparing')).kind).toBe('none');
    expect((await status('Available')).kind).toBe('resolved');

    await report(drivers[0]!, 2);
    await report(drivers[1]!, 2);
    const [event] = await openEvents();
    await faults.acknowledge(Number(event.id), null);
    await faults.close(Number(event.id), null);
    const [r] = await q(
      'SELECT count(*) FILTER (WHERE cleared_at IS NULL)::int AS open FROM fault_reports WHERE fault_event_id=$1',
      [event.id],
    );
    expect(r.open).toBe(0);
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
