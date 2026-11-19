/**
 * Harness RQ2 (T142, BM04 RF-11, SRS NFR-RES-04) — chạy một kịch bản trên CSMS dựng tại chỗ.
 *
 *   node lab/rq2/run.mjs --scenario quiet --dry-run --requests 10 --interval-ms 1000
 *   node lab/rq2/run.mjs --scenario quiet --route-remaining <số trên Vietmap Console>
 *
 * Dựng Postgres nhúng riêng (cổng 55437, DB powerme_rq2) + migration + 50 trạm của
 * `../nfr-res-01/road-points.json`, rồi Driver API thật trong tiến trình (giống
 * `../nfr-res-01/local.mjs`). Mỗi request:
 *   1. ghi tải của kịch bản vào DB (trạng thái súng, độ tươi, sự cố mở);
 *   2. GET /stations sort=smart (Vietmap thật) và sort=distance (đối chứng, không tốn Route);
 *   3. chấm cả hai theo sự thật nền (score.mjs), ghi một dòng vào rows.jsonl.
 *
 * Hạn mức (D-Y): tối đa 1 request/phút khi chạy thật, ngân sách Route mặc định 850, chừa 500 Route
 * cho Sơn trên cùng key. Dừng sớm khi chạm ngân sách hoặc 10 request `brief` liên tiếp và in
 * `--start-index` để chạy tiếp. Lab là dụng cụ đo: không sửa mã CSMS.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { SignJWT } from 'jose';
import {
  applyMigration,
  connectDemoDb,
  CSMS_DIR,
  startEmbeddedDb,
} from '../../demo/db-embedded.mjs';
import { ensureBuilt, portOpen } from '../rq1/local-csms.mjs';
import { writeSummary } from './analyze.mjs';
import { drawRequest, SCENARIOS, TARGET_SOC } from './scenarios.mjs';
import { AVG_SPEED_KMH, ROAD_FACTOR, scoreRequest, VEHICLE } from './score.mjs';

const labDir = path.dirname(fileURLToPath(import.meta.url));
const SITE_COUNT = 50;
const ROUTES_PER_REQUEST = 6;
/** Q15: phần tối thiểu của Sơn (NFR-RES-01) trên cùng key Vietmap mỗi ngày. */
const RESERVED_FOR_OTHERS = 500;
/** Q19. */
const MAX_BRIEF_STREAK = 10;
const JWT_SCOPE = 'powerme-rq2-local';

class LabError extends Error {}

function options() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      requests: { type: 'string', default: '200' },
      seed: { type: 'string', default: '20261120' },
      'start-index': { type: 'string', default: '0' },
      'interval-ms': { type: 'string' },
      'route-budget': { type: 'string', default: '850' },
      'route-remaining': { type: 'string' },
      'pg-port': { type: 'string', default: '55437' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const int = (name, min, max) => {
    const raw = values[name];
    const n = Number(raw);
    if (!/^\d+$/.test(raw ?? '') || n < min || n > max)
      throw new LabError(`--${name} không hợp lệ`);
    return n;
  };
  if (!SCENARIOS[values.scenario]) throw new LabError('--scenario phải là quiet | peak | faulty');
  const dryRun = values['dry-run'];
  const o = {
    scenario: values.scenario,
    requests: int('requests', 1, 1000),
    seed: int('seed', 0, 2 ** 32 - 1),
    start: int('start-index', 0, 999),
    intervalMs: values['interval-ms'] === undefined ? 60000 : int('interval-ms', 0, 3600000),
    budget: int('route-budget', 0, 100000),
    pgPort: int('pg-port', 1024, 65535),
    dryRun,
  };
  if (o.start >= o.requests) throw new LabError('--start-index phải nhỏ hơn --requests');
  if (!dryRun) {
    if (o.intervalMs < 60000)
      throw new LabError('Chạy thật: --interval-ms tối thiểu 60000 (1 request/phút)');
    if (values['route-remaining'] === undefined)
      throw new LabError(
        'Chạy thật cần --route-remaining (số Route còn lại trên Vietmap Console hôm nay)',
      );
    o.remaining = int('route-remaining', 0, 1000000);
    if (o.budget > o.remaining - RESERVED_FOR_OTHERS)
      throw new LabError(
        `--route-budget ${o.budget} vượt ${o.remaining} − ${RESERVED_FOR_OTHERS} (phần của NFR-RES-01). Giảm ngân sách hoặc chờ hôm sau`,
      );
    if (o.budget < ROUTES_PER_REQUEST) throw new LabError('--route-budget quá nhỏ');
  }
  const day = new Date().toISOString().slice(0, 10);
  o.out = path.resolve(
    values.out ?? path.join(labDir, 'results', `${day}-${o.scenario}${dryRun ? '-dry' : ''}`),
  );
  return o;
}

async function loadPoints() {
  const { stations } = JSON.parse(
    await readFile(path.join(labDir, '../nfr-res-01/road-points.json'), 'utf8'),
  );
  if (stations.length !== SITE_COUNT) throw new LabError('road-points.json phải có 50 trạm');
  return stations;
}

/** Chép từ `../nfr-res-01/local.mjs` (seed), giữ nguyên dữ liệu; mã trạm đổi tiền tố RQ2-. */
async function seed(client, stations) {
  await client.query('BEGIN');
  try {
    const {
      rows: [{ id: operator }],
    } = await client.query(
      "INSERT INTO operators(tax_code,legal_name,status) VALUES('RQ2LOCAL','RQ2 Local','active') RETURNING id",
    );
    const {
      rows: [{ id: driver }],
    } = await client.query(
      "INSERT INTO users(email,full_name,role) VALUES('rq2@example.invalid','RQ2 Driver','driver') RETURNING id",
    );
    await client.query(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'rq2-local',now())",
      [driver],
    );
    const {
      rows: [{ id: vehicle }],
    } = await client.query(
      "WITH model AS (INSERT INTO vehicle_models (brand,model_name,connector_type,battery_capacity_kwh,rated_range_km,max_dc_kw) VALUES('Fixture','RQ2',  'ccs2',$2,320,$3) RETURNING id) INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) SELECT $1,id,'RQ2LOCAL' FROM model RETURNING id",
      [driver, VEHICLE.battery_kwh, VEHICLE.max_dc_kw],
    );
    await client.query(
      "INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from) VALUES($1,'normal','00:00','24:00',4500,'2000-01-01')",
      [operator],
    );
    await client.query(
      "INSERT INTO sites(operator_id,site_code,site_name,latitude,longitude) SELECT $1,'RQ2-' || osm_id,'Trạm RQ2 ' || osm_id,lat,lng FROM jsonb_to_recordset($2) AS p(osm_id bigint, lat numeric, lng numeric)",
      [operator, JSON.stringify(stations.map(([osm_id, lat, lng]) => ({ osm_id, lat, lng })))],
    );
    await client.query(
      "INSERT INTO charge_points(serial_number,display_code,site_id,rated_power_kw,lifecycle,is_online,last_message_at,online_changed_at,current_epoch) SELECT site_code,site_code,id,120,'in_service',true,now(),now()-interval '1 minute',1 FROM sites WHERE operator_id=$1",
      [operator],
    );
    await client.query(
      "INSERT INTO connectors(charge_point_id,connector_no,connector_type,max_power_kw,status,status_changed_at) SELECT cp.id,1,'ccs2',CASE WHEN cp.id % 3 = 0 THEN 60 ELSE 120 END,'Available',now() FROM charge_points cp JOIN sites st ON st.id=cp.site_id WHERE st.operator_id=$1",
      [operator],
    );
    await client.query('COMMIT');
    const { rows } = await client.query(
      `SELECT st.id::text AS site_id, st.latitude::float8 AS latitude, st.longitude::float8 AS longitude,
         cp.id AS charge_point_id, c.id AS connector_id, c.max_power_kw::float8 AS power_kw
       FROM sites st JOIN charge_points cp ON cp.site_id=st.id JOIN connectors c ON c.charge_point_id=cp.id
       WHERE st.operator_id=$1 ORDER BY st.id`,
      [operator],
    );
    return { driver, vehicle, sites: rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const OCPP_STATUS = {
  available: 'Available',
  in_use: 'Charging',
  freeing_soon: 'Finishing',
  stale_broken: 'Available',
  faulted: 'Faulted',
};

/**
 * Ghi tải của một request vào DB. Mọi trụ "chạm" lại last_message_at = now() để không trạm nào tự
 * thành stale / offline giữa lượt. Trạm stale_broken: trạng thái báo trước lần nối lại gần nhất
 * (status_changed_at < online_changed_at) → Status Quality = stale theo station-search.ts.
 * Trạm faulted: một FaultEvent OCPP đang mở → CSMS ẩn súng khỏi cả hai cách xếp.
 */
async function applyLoad(client, sites, load) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM fault_events');
    const rows = sites.map((s, i) => ({
      cp: s.charge_point_id,
      c: s.connector_id,
      st: OCPP_STATUS[load[i].state],
      stale: load[i].state === 'stale_broken',
      faulted: load[i].state === 'faulted',
    }));
    await client.query(
      `WITH p AS (SELECT * FROM jsonb_to_recordset($1) AS p(cp bigint, c bigint, st text, stale boolean, faulted boolean)),
       a AS (UPDATE charge_points cp SET last_message_at=now(), is_online=true, online_changed_at=now()-interval '1 minute'
             FROM p WHERE cp.id=p.cp)
       UPDATE connectors c SET status=p.st::connector_status,
         status_changed_at = CASE WHEN p.stale THEN now()-interval '1 hour' ELSE now()-interval '10 seconds' END
       FROM p WHERE c.id=p.c`,
      [JSON.stringify(rows)],
    );
    await client.query(
      `INSERT INTO fault_events(charge_point_id,connector_id,source,error_code,status,raised_at)
       SELECT p.cp,p.c,'ocpp','GroundFailure','raised',now()-interval '5 minutes'
       FROM jsonb_to_recordset($1) AS p(cp bigint, c bigint, faulted boolean) WHERE p.faulted`,
      [JSON.stringify(rows)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Chép từ `../nfr-res-01/local.mjs`: đếm request Route Vietmap thật qua diagnostics_channel. */
function observeProvider() {
  const counts = { attempted: 0, http_statuses: {}, network_errors: 0 };
  const isRoute = (request) =>
    request.origin === 'https://maps.vietmap.vn' && request.path.startsWith('/api/route/v4?');
  const subscriptions = [
    [
      'create',
      ({ request }) => {
        if (isRoute(request)) counts.attempted++;
      },
    ],
    [
      'headers',
      ({ request, response }) => {
        if (!isRoute(request)) return;
        counts.http_statuses[response.statusCode] =
          (counts.http_statuses[response.statusCode] ?? 0) + 1;
      },
    ],
    [
      'error',
      ({ request }) => {
        if (isRoute(request)) counts.network_errors++;
      },
    ],
  ].map(([event, handler]) => [channel('undici:request:' + event), handler]);
  for (const [topic, handler] of subscriptions) topic.subscribe(handler);
  return { counts, close: () => subscriptions.forEach(([t, h]) => t.unsubscribe(h)) };
}

async function getStations(base, token, vehicle, origin, extra) {
  const url = new URL(base + '/stations');
  url.search = new URLSearchParams({
    vehicle_id: String(vehicle),
    latitude: String(origin.latitude),
    longitude: String(origin.longitude),
    page_size: String(SITE_COUNT),
    ...extra,
  });
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new LabError(`Driver API HTTP ${response.status} (${extra.sort})`);
  return response.json();
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CSMS_DIR, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function run() {
  const o = options();
  const key = o.dryRun
    ? undefined
    : parseEnv(await readFile(path.resolve(CSMS_DIR, '../../infra/.env'), 'utf8'))
        .VIETMAP_SEARCH_API_KEY;
  if (!o.dryRun && !key?.trim())
    throw new LabError('Thiếu VIETMAP_SEARCH_API_KEY trong infra/.env');
  if (await portOpen(o.pgPort)) throw new LabError(`Cổng Postgres ${o.pgPort} đang bận`);

  ensureBuilt((m) => console.log(m));
  const [
    { loadConfig },
    { createDb },
    { createDriverListener },
    { ConnectionRegistry },
    { loadChargePolicy },
    { ChargeSettlementService },
    { DriverChargingService },
  ] = await Promise.all([
    import('../../dist/config.js'),
    import('../../dist/db/db.module.js'),
    import('../../dist/driver/driver.http.js'),
    import('../../dist/ocpp-gateway/connection-registry.js'),
    import('../../dist/sessions/charge-policy.config.js'),
    import('../../dist/sessions/charge-settlement.service.js'),
    import('../../dist/sessions/driver-charging.service.js'),
  ]);

  mkdirSync(o.out, { recursive: true });
  const rowsFile = path.join(o.out, 'rows.jsonl');
  const write = (record) => appendFileSync(rowsFile, JSON.stringify(record) + '\n');
  const metaFile = path.join(o.out, o.start === 0 ? 'meta.json' : `meta-from-${o.start}.json`);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'powerme-rq2-pg-'));
  const provider = observeProvider();
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  process.once('SIGINT', stop);
  let pg, client, db, server;
  let stopped = 'completed';
  let next = o.start;
  try {
    pg = await startEmbeddedDb({ dataDir, port: o.pgPort, database: 'powerme_rq2' });
    client = await connectDemoDb(pg.url);
    await applyMigration(client);
    const { driver, vehicle, sites } = await seed(client, await loadPoints());

    const secret = randomBytes(32);
    const config = loadConfig({
      DATABASE_URL: pg.url,
      DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
      DRIVER_API_JWT_ISSUER: JWT_SCOPE,
      DRIVER_API_JWT_AUDIENCE: JWT_SCOPE,
      VIETMAP_SEARCH_API_KEY: key,
    });
    const sign = () =>
      new SignJWT({ role: 'driver' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(String(driver))
        .setIssuer(JWT_SCOPE)
        .setAudience(JWT_SCOPE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(secret);
    db = createDb(pg.url);
    const policy = loadChargePolicy({});
    const service = new DriverChargingService(
      db,
      new ConnectionRegistry(db),
      new ChargeSettlementService(db, policy),
      policy,
      config,
    );
    server = createServer(createDriverListener(db, service, config.driverApi));
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const base = `http://127.0.0.1:${server.address().port}/api/driver/v1`;
    const indexOf = new Map(sites.map((s, i) => [s.site_id, i]));

    writeFileSync(
      metaFile,
      JSON.stringify(
        {
          task: 'T142',
          scenario: o.scenario,
          parameters: SCENARIOS[o.scenario],
          parameters_status: 'đề xuất, chờ Ân duyệt (Q7)',
          seed: o.seed,
          requests: o.requests,
          start_index: o.start,
          interval_ms: o.intervalMs,
          route_budget: o.budget,
          route_remaining_declared: o.remaining ?? null,
          dry_run: o.dryRun,
          target_soc_percent: TARGET_SOC,
          vehicle: { ...VEHICLE, rated_range_km: 320, connector_type: 'ccs2' },
          scoring: { road_factor: ROAD_FACTOR, avg_speed_kmh: AVG_SPEED_KMH, tie_min: 1 },
          smart_search: config.smartSearch ?? null,
          station_stale_after_ms: policy.stationStaleAfterMs,
          sites: sites.map(({ site_id, latitude, longitude, power_kw }) => ({
            site_id,
            latitude,
            longitude,
            power_kw,
          })),
          commit: gitCommit(),
          started_at: new Date().toISOString(),
          node: process.version,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Kịch bản ${o.scenario}, request ${o.start}..${o.requests - 1}, ghi vào ${rowsFile}`,
    );

    let briefStreak = 0;
    for (let k = o.start; k < o.requests; k++) {
      next = k;
      if (interrupted.signal.aborted) {
        stopped = 'interrupted';
        break;
      }
      if (!o.dryRun && provider.counts.attempted + ROUTES_PER_REQUEST > o.budget) {
        stopped = 'budget';
        break;
      }
      const began = Date.now();
      const req = drawRequest(o.scenario, o.seed, k, sites.length);
      await applyLoad(client, sites, req.load);
      const token = await sign();
      const before = provider.counts.attempted;
      const smart = await getStations(base, token, vehicle, req, {
        sort: 'smart',
        location_consent: 'true',
        soc_percent: String(req.soc_percent),
        target_soc_percent: String(TARGET_SOC),
      });
      const routeCalls = provider.counts.attempted - before;
      const nearest = await getStations(base, token, vehicle, req, { sort: 'distance' });
      if (!smart.items?.length || !nearest.items?.length)
        throw new LabError(`Request ${k}: không có trạm nào`);

      const smartIndex = indexOf.get(smart.items[0].site_id);
      // Q1: nearest compatible station — trạm đầu của sort=distance (đã lọc theo CCS2), không xét trạng thái.
      const baselineIndex = indexOf.get(nearest.items[0].site_id);
      const roadMin = new Map(
        smart.items
          .filter((s) => s.road_estimate)
          .map((s) => [indexOf.get(s.site_id), s.road_estimate.duration_s / 60]),
      );
      const scored = scoreRequest({
        stations: sites,
        load: req.load,
        origin: req,
        socPercent: req.soc_percent,
        smartIndex,
        baselineIndex,
        roadMin,
      });
      const side = (s) => ({
        ...s,
        site_id: sites[s.index].site_id,
        final_site_id: s.final_index === null ? null : sites[s.final_index].site_id,
      });
      briefStreak = smart.ranking_source === 'brief' ? briefStreak + 1 : 0;
      write({
        phase: 'request',
        scenario: o.scenario,
        seed: o.seed,
        k,
        pair: req.pair,
        at: new Date().toISOString(),
        origin: { latitude: req.latitude, longitude: req.longitude },
        soc_percent: req.soc_percent,
        ranking_source: smart.ranking_source ?? null,
        route_calls: routeCalls,
        smart: {
          ...side(scored.smart),
          est_total_min: smart.items[0].est_total_min ?? null,
          drive_source: smart.items[0].road_estimate ? 'road' : 'straight',
        },
        baseline: {
          ...side(scored.baseline),
          distance_m: nearest.items[0].distance_m,
          drive_source: roadMin.has(baselineIndex) ? 'road' : 'straight',
        },
        delta_start_min: scored.delta_start_min,
        delta_target_min: scored.delta_target_min,
        ...(scored.road ? { road: scored.road } : {}),
        load: Object.fromEntries(sites.map((s, i) => [s.site_id, req.load[i]])),
        ranking: smart.items.map((s) => ({
          site_id: s.site_id,
          reach: s.reach ?? null,
          est_drive_min: s.est_drive_min ?? null,
          est_wait_min: s.est_wait_min ?? null,
          est_charge_min: s.est_charge_min ?? null,
          est_total_min: s.est_total_min ?? null,
          road_estimate: s.road_estimate ?? null,
        })),
      });
      console.log(
        `#${k} ${smart.ranking_source} route=${routeCalls} smart=${scored.smart.target_min} baseline=${scored.baseline.target_min} Δ=${scored.delta_target_min}`,
      );
      next = k + 1;
      if (briefStreak >= MAX_BRIEF_STREAK && !o.dryRun) {
        stopped = 'brief_streak';
        break;
      }
      if (k + 1 < o.requests) {
        const wait = o.intervalMs - (Date.now() - began);
        if (wait > 0) await sleep(wait, undefined, { signal: interrupted.signal }).catch(() => {});
      }
    }
    if (interrupted.signal.aborted && stopped === 'completed' && next < o.requests)
      stopped = 'interrupted';
  } finally {
    process.removeListener('SIGINT', stop);
    provider.close();
    await Promise.allSettled([
      server?.listening && new Promise((resolve) => server.close(resolve)),
      db?.$client.end(),
      client?.end(),
    ]);
    pg?.stopSync();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  const end = {
    phase: 'end',
    scenario: o.scenario,
    stopped,
    next_start_index: next < o.requests ? next : null,
    provider: provider.counts,
    finished_at: new Date().toISOString(),
  };
  write(end);
  console.log(JSON.stringify(end));
  if (existsSync(rowsFile)) writeSummary([rowsFile], o.out);
  if (end.next_start_index !== null)
    console.log(
      `Chạy tiếp: node lab/rq2/run.mjs --scenario ${o.scenario} --seed ${o.seed} --start-index ${next} --route-remaining <số mới>`,
    );
}

try {
  await run();
} catch (error) {
  console.error(error instanceof LabError ? error.message : error);
  process.exitCode = 1;
}
