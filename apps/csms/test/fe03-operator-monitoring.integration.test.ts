/**
 * FE-03 — operator charge point monitoring (screens 17 and 18) over real HTTP (ConsoleServer) and
 * Postgres: GET /api/operator/v1/charge-points and /summary, scoped to the token's Operator
 * (BR-P16), with OPERATOR-DASHBOARD-PLAN D19–D25 (raw status, Offline override, stale rule,
 * decommissioned hidden). Needs DATABASE_URL; resets its schema.
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

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe03', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'mb03', audience: 'app' };

describeDb('FE-03 operator monitoring (screens 17, 18; BR-P16, D19–D25)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let txNo = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  async function get(path: string, token?: string) {
    const r = await fetch(`${base}/api/operator/v1${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  /** A charge point of Operator `op` with connectors in the given raw statuses. */
  async function chargePoint(
    key: string,
    op: 'A' | 'B',
    lifecycle: string,
    silentS: number | null,
    online: boolean,
    statuses: string[],
  ) {
    ids[key] = (
      await q(
        `INSERT INTO charge_points(serial_number,display_code,site_id,model,lifecycle,is_online,
           last_message_at,online_changed_at)
         VALUES($1,$1,$2,'D1-120',$3,$4,
           CASE WHEN $5::int IS NULL THEN NULL ELSE now()-($5::int*interval '1 second') END,
           now()-interval '1 hour') RETURNING id::text AS id`,
        [key, ids[`site${op}`], lifecycle, online, silentS],
      )
    )[0].id;
    for (const [i, st] of statuses.entries())
      ids[`${key}c${i + 1}`] = (
        await q(
          `INSERT INTO connectors(charge_point_id,connector_no,connector_type,max_power_kw,status,status_changed_at)
           VALUES($1,$2,'ccs2',60,$3,now()-interval '30 minutes') RETURNING id::text AS id`,
          [ids[key], i + 1, st],
        )
      )[0].id;
  }
  async function session(cp: string, connector: string, status: string, paymentMode: string) {
    txNo += 1;
    const stopped = status !== 'active';
    await q(
      `INSERT INTO sessions(transaction_no,charge_point_id,connector_id,connector_no,id_tag,origin,payment_mode,
         status,meter_start_wh,meter_stop_wh,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at)
       VALUES($1,$2,$3,$9,$4,'rfid',$5,$6,0,$7,now(),now(),$8,$8)`,
      [
        txNo,
        ids[cp],
        ids[connector],
        `FE03-${txNo}`,
        paymentMode,
        status,
        stopped ? 1000 : null,
        stopped ? new Date() : null,
        Number(connector.slice(-1)),
      ],
    );
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const hash = await hashChargePointPassword(PASSWORD);
    for (const op of ['A', 'B'] as const) {
      ids[`op${op}`] = (
        await q(
          'INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id::text AS id',
          [`030000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
        )
      )[0].id;
      ids[`site${op}`] = (
        await q(
          `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
           VALUES($1,$2,$3,'x',10.7,106.7) RETURNING id::text AS id`,
          [`FE03-${op}`, ids[`op${op}`], `Tram ${op}`],
        )
      )[0].id;
      const user = (
        await q(
          `INSERT INTO users(email,full_name,role,password_hash)
           VALUES($1,$2,'operator_staff',$3) RETURNING id::text AS id`,
          [`staff${op.toLowerCase()}@fe03.test`, `Staff ${op}`, hash],
        )
      )[0].id;
      await q(
        "INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'technician')",
        [user, ids[`op${op}`]],
      );
    }
    // Operator A: fresh (Available + Charging), stale (silent 700 s > 2 × 300 s), offline (socket
    // closed), a new one never connected, and a decommissioned one. Operator B: one fresh.
    await chargePoint('A-FRESH', 'A', 'in_service', 10, true, ['Available', 'Charging']);
    await chargePoint('A-STALE', 'A', 'in_service', 700, true, ['Faulted', 'Finishing']);
    await chargePoint('A-OFF', 'A', 'in_service', 30, false, ['Available', 'Available']);
    await chargePoint('A-NEW', 'A', 'awaiting_connection', null, false, ['Unavailable']);
    await chargePoint('A-OLD', 'A', 'decommissioned', null, false, ['Unavailable']);
    await chargePoint('B-FRESH', 'B', 'in_service', 10, true, ['Available']);
    await q(
      `INSERT INTO connector_status_events(charge_point_id,connector_no,connector_id,status,error_code,received_at)
       VALUES($1,1,$2,'Faulted','GroundFailure',now())`,
      [ids['A-STALE'], ids['A-STALEc1']],
    );
    await q(
      `INSERT INTO fault_events(charge_point_id,connector_id,source,error_code,status,raised_at)
       VALUES($1,$2,'ocpp','GroundFailure','raised',now()),($3,NULL,'ocpp','Offline','acknowledged',now()),
             ($4,$5,'ocpp','GroundFailure','raised',now())`,
      [ids['A-STALE'], ids['A-STALEc1'], ids['A-OFF'], ids['B-FRESH'], ids['B-FRESHc1']],
    );
    await session('A-FRESH', 'A-FRESHc2', 'active', 'csms_billed');
    await session('A-FRESH', 'A-FRESHc1', 'review', 'csms_billed');
    await session('A-FRESH', 'A-FRESHc1', 'closed', 'unattributed');

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
    for (const op of ['a', 'b']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `staff${op}@fe03.test`, password: PASSWORD }),
      });
      tokens[op] = ((await r.json()) as any).access_token;
    }
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('401 without a token, 403 for a driver token', async () => {
    expect((await get('/charge-points')).status).toBe(401);
    expect((await get('/summary')).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const driver = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('1')
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
    expect((await get('/charge-points', driver)).status).toBe(403);
  });

  it('lists only the Operator’s charge points with raw status, quality, error code and session', async () => {
    const a = (await get('/charge-points', tokens['a'])).body;
    expect(a).toMatchObject({ total: 4, page: 1, page_size: 50 });
    expect(a.items.map((c: any) => c.serial_number)).toEqual([
      'A-FRESH',
      'A-NEW',
      'A-OFF',
      'A-STALE',
    ]);
    const [fresh, fresh2] = a.items[0].connectors;
    expect(a.items[0]).toMatchObject({
      id: ids['A-FRESH'],
      lifecycle: 'in_service',
      connected: false,
      is_online: true,
      site: { id: ids['siteA'], site_code: 'FE03-A', site_name: 'Tram A' },
    });
    expect(fresh).toMatchObject({
      connector_id: ids['A-FRESHc1'],
      connector_no: 1,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status: 'Available',
      status_quality: 'fresh',
      error_code: null,
      active_session_id: null,
    });
    expect(fresh2).toMatchObject({ status: 'Charging', active_session_id: expect.any(String) });
    expect(typeof fresh.status_updated_at).toBe('string');
    const stale = a.items[3].connectors;
    expect(stale.map((c: any) => [c.status, c.status_quality, c.error_code])).toEqual([
      ['Faulted', 'stale', 'GroundFailure'],
      ['Finishing', 'stale', null],
    ]);
    expect(a.items[2].connectors.map((c: any) => [c.status, c.status_quality])).toEqual([
      ['Available', 'offline'],
      ['Available', 'offline'],
    ]);
    expect(a.items[1].connectors[0].status_quality).toBe('offline');
    const b = (await get('/charge-points', tokens['b'])).body;
    expect(b.items.map((c: any) => c.serial_number)).toEqual(['B-FRESH']);
  });

  it('filters by site, lifecycle and online, and pages in the same order', async () => {
    const t = tokens['a'];
    const names = async (qs: string) =>
      (await get(`/charge-points?${qs}`, t)).body.items.map((c: any) => c.serial_number);
    expect(await names('online=true')).toEqual(['A-FRESH', 'A-STALE']);
    expect(await names('online=false')).toEqual(['A-NEW', 'A-OFF']);
    expect(await names('lifecycle=decommissioned')).toEqual(['A-OLD']);
    expect(await names('lifecycle=awaiting_connection')).toEqual(['A-NEW']);
    expect(await names(`site_id=${ids['siteB']}`)).toEqual([]);
    const page2 = (await get('/charge-points?page=2&page_size=3', t)).body;
    expect(page2).toMatchObject({ total: 4, page: 2, page_size: 3 });
    expect(page2.items.map((c: any) => c.serial_number)).toEqual(['A-STALE']);
    expect((await get('/charge-points?page=9&page_size=3', t)).body).toEqual({
      items: [],
      total: 4,
      page: 9,
      page_size: 3,
    });
  });

  it('charge_point_q and site_q search separately, case- and accent-insensitive, or by exact id (FE-07)', async () => {
    const t = tokens['a'];
    const names = async (qs: string) =>
      (await get(`/charge-points?${qs}`, t)).body.items.map((c: any) => c.serial_number);
    const all = ['A-FRESH', 'A-NEW', 'A-OFF', 'A-STALE'];
    // Charge point: code / serial or exact id — not the station.
    expect(await names('charge_point_q=a-fresh')).toEqual(['A-FRESH']);
    expect(await names('charge_point_q=%20A-STALE%20')).toEqual(['A-STALE']);
    expect(await names(`charge_point_q=${ids['A-OFF']}`)).toContain('A-OFF');
    expect(await names('charge_point_q=fe03-a')).toEqual([]);
    // Station: code / name (site A: FE03-A / "Tram A") or exact id — not the charge point.
    expect(await names('site_q=fe03-a')).toEqual(all);
    expect(await names(`site_q=${encodeURIComponent('Trạm A')}`)).toEqual(all);
    expect(await names(`site_q=${ids['siteA']}`)).toEqual(all);
    expect(await names('site_q=a-fresh')).toEqual([]);
    // Both must match; with the other filters; scoped to the token's Operator.
    expect(await names('charge_point_q=a-o&site_q=tram%20a')).toEqual(['A-OFF']);
    expect(await names('site_q=fe03-a&online=false')).toEqual(['A-NEW', 'A-OFF']);
    expect(await names('charge_point_q=b-fresh')).toEqual([]);
    expect(await names('site_q=fe03-b')).toEqual([]);
    expect(await names('charge_point_q=&site_q=')).toEqual(all); // blank = no search
    for (const qs of [`charge_point_q=${'x'.repeat(101)}`, 'site_q=a%01b', 'q=a-fresh'])
      expect([qs, (await get(`/charge-points?${qs}`, t)).status]).toEqual([qs, 400]);
  });

  it('summarises the Operator: charge points, BR-P38 connector groups, open faults by severity, queues', async () => {
    expect((await get('/summary', tokens['a'])).body).toEqual({
      charge_points: {
        total: 4,
        online: 2,
        offline: 2,
        by_lifecycle: { in_service: 3, awaiting_connection: 1 },
      },
      connectors: { available: 1, in_use: 1, freeing_soon: 1, unavailable: 1, offline: 3 },
      open_faults: { total: 2, critical: 1, major: 1, minor: 0, none: 0 },
      sessions_to_review: 1,
      unattributed_sessions: 1,
      uncertain_starts: 0,
    });
    expect((await get('/summary', tokens['b'])).body).toMatchObject({
      charge_points: { total: 1, online: 1, offline: 0 },
      connectors: { available: 1, offline: 0 },
      open_faults: { total: 1, critical: 1 },
      sessions_to_review: 0,
      unattributed_sessions: 0,
    });
  });

  it('[TC-BRP52-05] T150: list and detail carry offline_card_risk from the latest check (migration 0030)', async () => {
    const check = (cp: string, risk: boolean, reason: string | null, changes: object) =>
      q(
        `INSERT INTO charge_point_offline_auth_checks(charge_point_id,epoch,started_at,completed_at,
           config_values,change_results,supported_feature_profiles,offline_card_risk,risk_reason)
         VALUES($1,1,now(),now(),'{}',$2,'Core',$3,$4)`,
        [ids[cp], JSON.stringify(changes), risk, reason],
      );
    // A-FRESH: an old risky check, then a confirmed one (the latest wins). A-STALE: Rejected.
    await check('A-FRESH', true, 'no_response', {});
    await check('A-FRESH', false, null, { LocalAuthorizeOffline: 'Accepted' });
    await check('A-STALE', true, 'rejected', { LocalAuthorizeOffline: 'Rejected' });
    const list = (await get('/charge-points', tokens['a'])).body.items;
    const flag = (serial: string) => {
      const cp = list.find((c: any) => c.serial_number === serial);
      return [cp.offline_card_risk, cp.offline_card_risk_reason, 'offline_auth_check' in cp];
    };
    expect(flag('A-FRESH')).toEqual([false, null, false]);
    expect(flag('A-STALE')).toEqual([true, 'rejected', false]);
    // Never checked = not confirmed.
    expect(flag('A-OFF')).toEqual([true, 'not_checked', false]);
    const d = (await get(`/charge-points/${ids['A-STALE']}`, tokens['a'])).body;
    expect(d).toMatchObject({
      offline_card_risk: true,
      offline_card_risk_reason: 'rejected',
      offline_auth_check: {
        epoch: 1,
        change_results: { LocalAuthorizeOffline: 'Rejected' },
        supported_feature_profiles: 'Core',
        fallback_profile_status: null,
      },
    });
    expect(Date.parse(d.offline_auth_check.checked_at)).not.toBeNaN();
    expect((await get(`/charge-points/${ids['A-OFF']}`, tokens['a'])).body.offline_auth_check).toBe(
      null,
    );
  });

  it('FE-05: detail adds capabilities, the open faults of this charge point and the 20 latest commands', async () => {
    for (let i = 0; i < 22; i++)
      await q(
        `INSERT INTO remote_commands(charge_point_id,connector_no,action,status,requested_at,error)
         VALUES($1,NULL,'Reset',$2,now()-($3::int*interval '1 minute'),$4)`,
        [ids['A-STALE'], i === 0 ? 'rejected' : 'accepted', i, i === 0 ? 'Rejected' : null],
      );
    await q(
      "UPDATE charge_points SET firmware_version='1.4.2',rated_power_kw=120,reports_soc=true WHERE id=$1",
      [ids['A-STALE']],
    );
    const d = await get(`/charge-points/${ids['A-STALE']}`, tokens['a']);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      id: ids['A-STALE'],
      serial_number: 'A-STALE',
      firmware_version: '1.4.2',
      rated_power_kw: 120,
      reports_soc: true,
      supports_reservation: false,
      site: { site_code: 'FE03-A' },
    });
    expect(d.body.connectors.map((c: any) => [c.status, c.error_code])).toEqual([
      ['Faulted', 'GroundFailure'],
      ['Finishing', null],
    ]);
    // Only this charge point's faults, same DTO as screen 21 (actions included).
    expect(d.body.open_faults).toHaveLength(1);
    expect(d.body.open_faults[0]).toMatchObject({
      charge_point_id: ids['A-STALE'],
      kind: 'faulted',
      error_code: 'GroundFailure',
      allowed_actions: ['acknowledge'],
    });
    expect(d.body.recent_commands).toHaveLength(20);
    expect(d.body.recent_commands[0]).toMatchObject({
      charge_point_id: ids['A-STALE'],
      action: 'Reset',
      connector_no: null,
      status: 'rejected',
      error: 'Rejected',
      sent_at: null,
    });
    const times = d.body.recent_commands.map((c: any) => Date.parse(c.requested_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    // The whole-charge-point Offline fault shows on that charge point's detail.
    const off = (await get(`/charge-points/${ids['A-OFF']}`, tokens['a'])).body;
    expect(off.open_faults.map((f: any) => f.kind)).toEqual(['offline']);
    expect(off.recent_commands).toEqual([]);
    // A decommissioned charge point is still reachable by id; the list stays without extras.
    expect((await get(`/charge-points/${ids['A-OLD']}`, tokens['a'])).body.lifecycle).toBe(
      'decommissioned',
    );
    const listed = (await get('/charge-points', tokens['a'])).body.items[0];
    expect(listed).not.toHaveProperty('firmware_version');
    expect(listed).not.toHaveProperty('extra');
  });

  it('FE-05: another Operator’s or an unknown charge point is 404; no query on the detail', async () => {
    for (const path of [
      `/charge-points/${ids['B-FRESH']}`,
      '/charge-points/999999',
      '/charge-points/abc',
    ])
      expect([path, (await get(path, tokens['a'])).status]).toEqual([path, 404]);
    expect((await get(`/charge-points/${ids['A-FRESH']}?x=1`, tokens['a'])).status).toBe(400);
    expect((await get(`/charge-points/${ids['A-FRESH']}`)).status).toBe(401);
  });

  it('rejects bad queries and methods', async () => {
    const t = tokens['a'];
    for (const qs of [
      'x=1',
      'online=yes',
      'lifecycle=broken',
      'site_id=abc',
      'page=0',
      'page_size=101',
      'page=1&page=2',
    ])
      expect([qs, (await get(`/charge-points?${qs}`, t)).status]).toEqual([qs, 400]);
    expect((await get('/summary?x=1', t)).status).toBe(400);
    const post = await fetch(`${base}/api/operator/v1/summary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
    });
    expect(post.status).toBe(405);
  });
});
