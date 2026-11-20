/**
 * FE-12 — screen 23 session queues over real HTTP (ConsoleServer → operator API) and Postgres:
 * GET /api/operator/v1/sessions?queue=unattributed|review, POST …/sessions/{id}/assign|close|resolve.
 * The routes only wrap Trí's services (BE-18, BE-24); these tests cover what the wrapper adds:
 * token → actor (never a body field), lists scoped to the token's Operator (BR-P16), paging,
 * input checks, error statuses. Business rules themselves are tested in be24 / be18.
 * Needs DATABASE_URL; resets its schema.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { SessionReviewService } from '../src/sessions/session-review.service.js';
import { UnattributedSessionService } from '../src/sessions/unattributed-session.service.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'fe12', audience: 'dashboard' };

describeDb('FE-12 operator session queues (screen 23; UC-OPS-05, F-12, STM-1 #17)', () => {
  let db: Db;
  let server: ConsoleServer;
  let commands: ConsoleCommands;
  let base = '';
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let txNo = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const r = await fetch(`${base}/api/operator/v1${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  const get = (path: string, token?: string) => call('GET', path, token);
  const post = (path: string, token: string | undefined, body: unknown) =>
    call('POST', path, token, body);

  /** A stopped session on Operator `op`'s charge point. */
  async function session(key: string, op: 'A' | 'B', status: string, origin = 'rfid') {
    txNo += 1;
    ids[key] = (
      await q(
        `INSERT INTO sessions(transaction_no,charge_point_id,connector_id,connector_no,id_tag,origin,payment_mode,
           status,meter_start_wh,meter_stop_wh,energy_wh,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at)
         VALUES($1,$2,$3,1,$4,$5,'unattributed',$6,0,2000,2000,now()-interval '1 hour',now()-interval '1 hour',
           now()-($1::int*interval '1 minute'),now()-($1::int*interval '1 minute'))
         RETURNING id::text AS id`,
        [txNo, ids[`cp${op}`], ids[`c${op}`], `FE12-${key}`, origin, status],
      )
    )[0].id;
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
          [`040000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
        )
      )[0].id;
      const site = (
        await q(
          `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
           VALUES($1,$2,$3,'x',10.7,106.7) RETURNING id::text AS id`,
          [`FE12-${op}`, ids[`op${op}`], `Tram ${op}`],
        )
      )[0].id;
      ids[`cp${op}`] = (
        await q(
          `INSERT INTO charge_points(serial_number,site_id,model,lifecycle)
           VALUES($1,$2,'D1-120','in_service') RETURNING id::text AS id`,
          [`FE12-CP-${op}`, site],
        )
      )[0].id;
      ids[`c${op}`] = (
        await q(
          `INSERT INTO connectors(charge_point_id,connector_no,connector_type,max_power_kw)
           VALUES($1,1,'ccs2',60) RETURNING id::text AS id`,
          [ids[`cp${op}`]],
        )
      )[0].id;
      ids[`staff${op}`] = (
        await q(
          `INSERT INTO users(email,full_name,role,password_hash)
           VALUES($1,$2,'operator_staff',$3) RETURNING id::text AS id`,
          [`staff${op.toLowerCase()}@fe12.test`, `Staff ${op}`, hash],
        )
      )[0].id;
      await q(
        "INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'technician')",
        [ids[`staff${op}`], ids[`op${op}`]],
      );
    }
    for (const [key, credit] of [
      ['driver', true],
      ['noCredit', false],
    ] as const) {
      ids[key] = (
        await q(
          "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id::text AS id",
          [`${key}@fe12.test`, key],
        )
      )[0].id;
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t',now())",
        [ids[key]],
      );
      if (credit)
        await q(
          "INSERT INTO credit_accounts(driver_id,status,balance_vnd) VALUES($1,'active',200000)",
          [ids[key]],
        );
    }
    // Operator A: three unattributed (one free vend) and one in review. Operator B: one of each.
    await session('A1', 'A', 'closed');
    await session('A2', 'A', 'closed');
    await session('Afree', 'A', 'closed', 'free_vend');
    await session('Areview', 'A', 'review');
    await session('B1', 'B', 'closed');
    await session('Breview', 'B', 'review');

    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
      consolePort: 0,
      dashboardAuth: DASH,
    };
    const registry = new ConnectionRegistry(db);
    const settlement = new ChargeSettlementService(db);
    commands = new ConsoleCommands(
      db,
      registry,
      undefined,
      new SessionReviewService(db, settlement),
      new UnattributedSessionService(db, settlement),
    );
    server = new ConsoleServer(config, new ConsoleQueries(db, config, registry), commands, db);
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    for (const op of ['a', 'b']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `staff${op}@fe12.test`, password: PASSWORD }),
      });
      tokens[op] = ((await r.json()) as any).access_token;
    }
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('401 without a token', async () => {
    expect((await get('/sessions')).status).toBe(401);
    expect((await post(`/sessions/${ids['A1']}/close`, undefined, {})).status).toBe(401);
  });

  it('lists only the Operator’s queue, newest first, with the free-vend blocker and paging', async () => {
    const a = (await get('/sessions?queue=unattributed', tokens['a'])).body;
    // An unattributed session still in `review` is in both queues (BE-24 STOPPED_STATUSES).
    expect(a).toMatchObject({ queue: 'unattributed', total: 4, page: 1, page_size: 50 });
    expect(a.items.map((s: any) => s.session_id)).toEqual([
      ids['A1'],
      ids['A2'],
      ids['Afree'],
      ids['Areview'],
    ]);
    expect(a.items[0]).toMatchObject({
      charge_point_serial: 'FE12-CP-A',
      charge_point_id: ids['cpA'],
      site_id: expect.stringMatching(/^[1-9][0-9]*$/),
      site_name: 'Tram A',
      connector_no: 1,
      id_tag: 'FE12-A1',
      energy_wh: 2000,
      not_assignable_reason: null,
    });
    expect(a.items[0]).not.toHaveProperty('operator_id');
    expect(a.items[2].not_assignable_reason).toBe('free_vend_not_billable');
    // Default queue is unattributed; Operator B sees only its own.
    const b = (await get('/sessions', tokens['b'])).body;
    expect(b.items.map((s: any) => s.session_id)).toEqual([ids['B1'], ids['Breview']]);
    const review = (await get('/sessions?queue=review', tokens['a'])).body;
    expect(review).toMatchObject({ queue: 'review', total: 1 });
    expect(review.items[0]).toMatchObject({
      session_id: ids['Areview'],
      stopped: true,
      charge_point_id: ids['cpA'],
      site_name: 'Tram A',
    });
    const page2 = (await get('/sessions?queue=unattributed&page=2&page_size=2', tokens['a'])).body;
    expect(page2).toMatchObject({ total: 4, page: 2, page_size: 2 });
    expect(page2.items.map((s: any) => s.session_id)).toEqual([ids['Afree'], ids['Areview']]);
  });

  it('rejects bad queries and bodies (400 / 405 / 415)', async () => {
    for (const path of [
      '/sessions?queue=busy',
      '/sessions?page=0',
      '/sessions?page_size=101',
      '/sessions?page=11&page_size=50',
      '/sessions?limit=5',
    ])
      expect((await get(path, tokens['a'])).status).toBe(400);
    expect((await get(`/sessions/${ids['A1']}/assign`, tokens['a'])).status).toBe(405);
    const bad = [
      { note: 'x' }, // no driver_id
      { driver_id: 'abc', note: 'x' },
      { driver_id: ids['driver'] }, // no note
      { driver_id: ids['driver'], note: '   ' }, // blank note (service: invalid_input)
    ];
    for (const body of bad)
      expect((await post(`/sessions/${ids['A1']}/assign`, tokens['a'], body)).status).toBe(400);
    const r = await fetch(`${base}/api/operator/v1/sessions/${ids['A1']}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens['a']}`, 'Content-Type': 'text/plain' },
      body: 'x',
    });
    expect(r.status).toBe(415);
  });

  it('assign: actor is the token’s staff user; another Operator’s session is 404; idempotent', async () => {
    expect(
      (
        await post(`/sessions/${ids['A1']}/assign`, tokens['b'], {
          driver_id: ids['driver'],
          note: 'Không phải của B',
        })
      ).status,
    ).toBe(404);
    const r = await post(`/sessions/${ids['A1']}/assign`, tokens['a'], {
      driver_id: ids['driver'],
      note: 'Tài xế gọi điện xác nhận',
      operator_user_id: ids['staffB'], // ignored: the actor comes from the token
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      session_id: ids['A1'],
      decision: 'assigned',
      driver_id: ids['driver'],
      payment_mode: 'csms_billed',
      already_resolved: false,
    });
    const [h] = await q(
      "SELECT actor,note FROM session_status_history WHERE session_id=$1 AND event='UNATTRIBUTED_ASSIGNED'",
      [ids['A1']],
    );
    expect(h).toMatchObject({ actor: ids['staffA'] });
    expect(h.note).toContain('Tài xế gọi điện xác nhận');
    const again = await post(`/sessions/${ids['A1']}/assign`, tokens['a'], {
      driver_id: Number(ids['driver']),
      note: 'Gọi lại',
    });
    expect(again.body.already_resolved).toBe(true);
    const list = (await get('/sessions', tokens['a'])).body;
    expect(list.items.map((s: any) => s.session_id)).not.toContain(ids['A1']);
  });

  it('assign errors keep the console statuses: 422 driver without credit, 409 free vend', async () => {
    const noCredit = await post(`/sessions/${ids['A2']}/assign`, tokens['a'], {
      driver_id: ids['noCredit'],
      note: 'x',
    });
    expect(noCredit).toMatchObject({ status: 422, body: { error: 'driver_not_eligible' } });
    const free = await post(`/sessions/${ids['Afree']}/assign`, tokens['a'], {
      driver_id: ids['driver'],
      note: 'x',
    });
    expect(free).toMatchObject({ status: 409, body: { error: 'free_vend_not_billable' } });
  });

  it('close keeps the session unattributed; a second, different decision is 409', async () => {
    const r = await post(`/sessions/${ids['Afree']}/close`, tokens['a'], {
      reason: 'free_vend_ok',
      note: 'Khuyến mãi khai trương',
    });
    expect(r).toMatchObject({
      status: 200,
      body: { decision: 'closed', reason: 'free_vend_ok', payment_mode: 'unattributed' },
    });
    expect(
      (
        await post(`/sessions/${ids['Afree']}/close`, tokens['a'], {
          reason: 'BAD CODE',
          note: 'x',
        })
      ).status,
    ).toBe(400);
    const assign = await post(`/sessions/${ids['Afree']}/assign`, tokens['a'], {
      driver_id: ids['driver'],
      note: 'x',
    });
    expect(assign.status).toBe(409);
  });

  it('resolve: review → reconciled, actor from the token; again is 409 not_in_review', async () => {
    expect(
      (
        await post(`/sessions/${ids['Breview']}/resolve`, tokens['a'], {
          resolution: 'meter_confirmed',
          note: 'x',
        })
      ).status,
    ).toBe(404);
    const r = await post(`/sessions/${ids['Areview']}/resolve`, tokens['a'], {
      resolution: 'meter_confirmed',
      note: 'Đã xem ảnh công tơ',
    });
    expect(r).toMatchObject({
      status: 200,
      body: { session_id: ids['Areview'], status: 'reconciled' },
    });
    const [h] = await q(
      "SELECT actor FROM session_status_history WHERE session_id=$1 AND event='OPERATOR_RESOLVED'",
      [ids['Areview']],
    );
    expect(h.actor).toBe(ids['staffA']);
    const again = await post(`/sessions/${ids['Areview']}/resolve`, tokens['a'], {
      resolution: 'meter_confirmed',
      note: 'x',
    });
    expect(again).toMatchObject({ status: 409, body: { error: 'not_in_review' } });
  });

  it('the console queue (no login) still lists every Operator', async () => {
    const rows = (await commands.unattributedQueue(50)) as { session_id: number }[];
    expect(rows.map((r) => String(r.session_id))).toContain(ids['B1']);
  });
});
