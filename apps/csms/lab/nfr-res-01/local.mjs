import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { SignJWT } from 'jose';
import {
  applyMigration,
  connectDemoDb,
  CSMS_DIR,
  startEmbeddedDb,
} from '../../demo/db-embedded.mjs';
import { portOpen } from '../rq1/local-csms.mjs';
import { loadConfig } from '../../dist/config.js';
import { createDb } from '../../dist/db/db.module.js';
import { createDriverListener } from '../../dist/driver/driver.http.js';
import { ConnectionRegistry } from '../../dist/ocpp-gateway/connection-registry.js';
import { loadChargePolicy } from '../../dist/sessions/charge-policy.config.js';
import { ChargeSettlementService } from '../../dist/sessions/charge-settlement.service.js';
import { DriverChargingService } from '../../dist/sessions/driver-charging.service.js';

const workspace = path.resolve(CSMS_DIR, '../../..');
const labDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(labDir, 'run.mjs');
const siteCount = 50;
const routesPerRequest = 6;
const jwtScope = 'powerme-nfr-res-01-local';
const { env } = process;

class LabError extends Error {}

function integer(name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new LabError('Invalid ' + name);
  }
  return value;
}

async function loadPoints() {
  const { origin, stations } = JSON.parse(
    await readFile(path.join(labDir, 'road-points.json'), 'utf8'),
  );
  const points = [origin, ...stations];
  if (
    points.length !== siteCount + 1 ||
    points.some(
      ([id, lat, lng]) =>
        !Number.isInteger(id) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < 10.855 ||
        lat > 10.887 ||
        lng < 106.767 ||
        lng > 106.81,
    ) ||
    new Set(points.map(([id]) => id)).size !== points.length ||
    new Set(points.map(([, lat, lng]) => lat + ',' + lng)).size !== points.length
  ) {
    throw new LabError('The road-point fixture must contain 50 distinct stations and one origin');
  }
  return { origin, stations };
}

async function seed(client, stations) {
  await client.query('BEGIN');
  try {
    const {
      rows: [{ id: operator }],
    } = await client.query(
      "INSERT INTO operators(tax_code,legal_name,status) VALUES('NFRRES01','NFR-RES-01 Local','active') RETURNING id",
    );
    const {
      rows: [{ id: driver }],
    } = await client.query(
      "INSERT INTO users(email,full_name,role) VALUES('nfr-res-01@example.invalid','Local NFR Driver','driver') RETURNING id",
    );
    await client.query(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'nfr-res-01-local',now())",
      [driver],
    );
    const {
      rows: [{ id: vehicle }],
    } = await client.query(
      "WITH model AS (INSERT INTO vehicle_models (brand,model_name,connector_type,battery_capacity_kwh,rated_range_km,max_dc_kw) VALUES('Fixture','NFR-RES-01','ccs2',60,320,100) RETURNING id) INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) SELECT $1,id,'NFRRES01' FROM model RETURNING id",
      [driver],
    );
    await client.query(
      "INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from) VALUES($1,'normal','00:00','24:00',4500,'2000-01-01')",
      [operator],
    );
    await client.query(
      "INSERT INTO sites(operator_id,site_code,site_name,latitude,longitude) SELECT $1,'NFR-' || osm_id,'Trạm local ' || osm_id,lat,lng FROM jsonb_to_recordset($2) AS p(osm_id bigint, lat numeric, lng numeric)",
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
    return { driver, vehicle };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

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
        const status = response.statusCode;
        counts.http_statuses[status] = (counts.http_statuses[status] ?? 0) + 1;
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
  return {
    counts,
    close() {
      for (const [topic, handler] of subscriptions) topic.unsubscribe(handler);
    },
  };
}

async function measure(settings, n, phase, log, provider, signal) {
  const child = spawn(process.execPath, [runner], {
    stdio: ['ignore', 'pipe', 'ignore'],
    signal,
    env: { ...settings, NFR_REQUESTS: String(n) },
    windowsHide: true,
  });
  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let summary;
  let lastAttempts = provider.attempted;
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.phase === 'sample') {
        entry.provider_calls = provider.attempted - lastAttempts;
        lastAttempts = provider.attempted;
      }
      log({ run: phase, ...entry });
      if (entry.phase === 'summary') summary = entry;
      if (phase === 'batch' && entry.phase === 'sample' && entry.ranking_source === 'brief') {
        child.kill();
      }
    }
    await closed;
    if (spawnFailed) throw new LabError('Benchmark subprocess could not finish');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  return summary;
}

async function verifyFixture(base, settings, log) {
  const url = new URL(base + '/stations');
  url.search = new URLSearchParams({
    vehicle_id: settings.NFR_VEHICLE_ID,
    latitude: settings.NFR_LATITUDE,
    longitude: settings.NFR_LONGITUDE,
    radius_km: settings.NFR_RADIUS_KM,
    sort: 'name',
    page_size: String(siteCount),
  });
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + settings.NFR_DRIVER_ACCESS_TOKEN },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new LabError('Local preflight HTTP ' + response.status);
  const { total, items } = await response.json();
  if (!Array.isArray(items)) throw new LabError('Local preflight station list is missing');
  const ids = new Set(items.map(({ site_id }) => site_id));
  const points = new Set(items.map(({ latitude, longitude }) => latitude + ',' + longitude));
  const eligible = items.filter(
    ({ connectors, latitude, longitude }) =>
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      connectors.some(
        (c) =>
          c.connector_type === 'ccs2' &&
          c.status_quality === 'fresh' &&
          c.is_online &&
          c.available_now &&
          Number(c.max_power_kw) > 0,
      ),
  ).length;
  log({
    phase: 'fixture',
    total,
    unique_ids: ids.size,
    unique_points: points.size,
    eligible,
    site_ids: [...ids],
  });
  if (
    total !== siteCount ||
    items.length !== siteCount ||
    ids.size !== siteCount ||
    points.size !== siteCount ||
    eligible !== siteCount
  ) {
    throw new LabError(
      'Expected 50 distinct fresh, compatible CCS2 stations before calling Vietmap',
    );
  }
}

async function run() {
  const samples = integer('NFR_LOCAL_SAMPLES', 0, 0, 20);
  const pgPort = integer('NFR_LOCAL_PG_PORT', 55436, 1024, 65535);
  const remaining = integer('NFR_ROUTE_REMAINING', 0, 0, Number.MAX_SAFE_INTEGER);
  if (samples && remaining < (samples + 1) * routesPerRequest)
    throw new LabError('NFR_ROUTE_REMAINING must cover the pilot and batch at six calls each');
  const key = samples
    ? parseEnv(await readFile(path.resolve(CSMS_DIR, '../../infra/.env'), 'utf8'))
        .VIETMAP_SEARCH_API_KEY
    : undefined;
  if (samples && !key?.trim()) throw new LabError('Missing VIETMAP_SEARCH_API_KEY in infra/.env');
  if (await portOpen(pgPort))
    throw new LabError('The dedicated local Postgres port is already in use');

  const { origin, stations } = await loadPoints();
  const review = path.join(workspace, '.review', 'nfr-res-01-local');
  await mkdir(review, { recursive: true });
  const folder = await mkdtemp(path.join(await realpath(review), 'run-'));
  const dataDir = path.join(folder, 'pg');
  const output = path.join(folder, 'evidence.jsonl');
  const log = (record) => {
    appendFileSync(output, JSON.stringify(record) + '\n');
    if (record.phase !== 'sample') console.log(JSON.stringify(record));
  };
  console.log('Evidence: ' + output);

  let pg;
  let client;
  let db;
  let server;
  let stage = 'Postgres startup';
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  process.once('SIGINT', stop);
  const provider = observeProvider();
  try {
    pg = await startEmbeddedDb({ dataDir, port: pgPort, database: 'powerme_nfr_res_01' });
    stage = 'migration';
    client = await connectDemoDb(pg.url);
    await applyMigration(client);
    stage = 'fixture seed';
    const { driver, vehicle } = await seed(client, stations);
    const jwtSecret = randomBytes(32);
    const config = loadConfig({
      DATABASE_URL: pg.url,
      DRIVER_API_JWT_SECRET_BASE64: jwtSecret.toString('base64'),
      DRIVER_API_JWT_ISSUER: jwtScope,
      DRIVER_API_JWT_AUDIENCE: jwtScope,
      VIETMAP_SEARCH_API_KEY: key,
    });
    const token = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(driver)
      .setIssuer(jwtScope)
      .setAudience(jwtScope)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(jwtSecret);
    stage = 'Driver API startup';
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
    const base = 'http://127.0.0.1:' + server.address().port + '/api/driver/v1';
    const settings = {
      NFR_DRIVER_API_URL: base,
      NFR_DRIVER_ACCESS_TOKEN: token,
      NFR_VEHICLE_ID: vehicle,
      NFR_LATITUDE: String(origin[1]),
      NFR_LONGITUDE: String(origin[2]),
      NFR_RADIUS_KM: '5',
      NFR_SOC_PERCENT: '35',
      NFR_INTERVAL_MS: '12500',
      NFR_ROUTE_REMAINING: String(remaining),
    };
    stage = 'fixture preflight';
    await verifyFixture(base, settings, log);
    if (!samples) return;
    stage = 'live pilot';
    const pilot = await measure(settings, 1, 'pilot', log, provider.counts, interrupted.signal);
    if (
      !pilot?.valid ||
      pilot.full_route_samples !== 1 ||
      provider.counts.attempted !== routesPerRequest
    )
      throw new LabError('Live pilot did not return six verified routes; batch skipped');

    stage = 'live batch';
    settings.NFR_ROUTE_REMAINING = String(remaining - routesPerRequest);
    const batch = await measure(
      settings,
      samples,
      'batch',
      log,
      provider.counts,
      interrupted.signal,
    );
    if (!batch?.valid) throw new LabError('Live batch incomplete; see the per-sample evidence');
    if (!batch.pass) throw new LabError('Local p95 exceeded 2000 ms; see the per-sample evidence');
  } catch (error) {
    if (error instanceof LabError) throw error;
    const code = /^[A-Z0-9_]{1,32}$/.test(error?.code ?? '') ? ' (' + error.code + ')' : '';
    throw new LabError('Local lab failed during ' + stage + code);
  } finally {
    process.removeListener('SIGINT', stop);
    provider.close();
    try {
      await Promise.allSettled([
        server?.listening && new Promise((resolve) => server.close(resolve)),
        db?.$client.end(),
        client?.end(),
      ]);
    } finally {
      pg?.stopSync();
    }
    if (pg && !(await portOpen(pgPort))) {
      const resolved = await realpath(dataDir);
      if (path.dirname(resolved) === folder && path.basename(resolved) === 'pg')
        await rm(resolved, { recursive: true, force: true });
    }
    log({ phase: 'provider', ...provider.counts });
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof LabError ? error.message : 'Local lab setup or cleanup failed');
  process.exitCode = 1;
}
