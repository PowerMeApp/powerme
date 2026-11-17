import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const siteCount = 50;
const routesPerRequest = 6;
const targetMs = 2000;
const { env } = process;
const log = (record) => console.log(JSON.stringify(record));

class BenchmarkError extends Error {}

function requireValid(condition, message) {
  if (!condition) throw new BenchmarkError(message);
}

function numberEnv(name, min, max, integer = false) {
  const raw = env[name];
  const value = Number(raw);
  requireValid(
    /^-?\d+(?:\.\d+)?$/.test(raw ?? '') &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value)),
    `Invalid or missing ${name}`,
  );
  return value;
}

function validCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

function readFixture(body) {
  const items = body?.items;
  requireValid(
    body?.total === siteCount && Array.isArray(items) && items.length === siteCount,
    `Expected ${siteCount} stations on one page; total=${Number.isInteger(body?.total) ? body.total : 'unknown'}`,
  );
  const fixture = new Map();
  const coordinates = new Set();
  for (const { site_id, latitude, longitude } of items) {
    requireValid(
      typeof site_id === 'string' &&
        /^[1-9]\d*$/.test(site_id) &&
        !fixture.has(site_id) &&
        validCoordinate(latitude, longitude),
      'Fixture contains a duplicate/missing station ID or invalid coordinates',
    );
    const point = `${latitude},${longitude}`;
    fixture.set(site_id, point);
    coordinates.add(point);
  }
  requireValid(coordinates.size === siteCount, 'Fixture coordinates must be distinct');
  return fixture;
}

function readRanking(body, expectedFixture) {
  const fixture = readFixture(body);
  for (const [id, point] of fixture) {
    requireValid(expectedFixture.get(id) === point, 'Station fixture changed after preflight');
  }

  const source = body.ranking_source;
  requireValid(source === 'brief' || source === 'vietmap_route', 'Unexpected ranking_source');
  const sites = body.items.map((site) => {
    const { site_id, reach, road_estimate: road } = site;
    const item = { site_id, reach: ['ok', 'tight', 'risky'].includes(reach) ? reach : null };
    for (const field of ['est_drive_min', 'est_wait_min', 'est_charge_min', 'est_total_min']) {
      item[field] = Number.isFinite(site[field]) ? site[field] : null;
    }
    if (road == null) return { ...item, road_estimate: null };
    const { distance_m, duration_s, computed_at, congested_distance_m } = road;
    requireValid(
      Number.isFinite(distance_m) &&
        distance_m >= 0 &&
        Number.isInteger(duration_s) &&
        duration_s >= 0 &&
        typeof computed_at === 'string' &&
        Number.isFinite(Date.parse(computed_at)),
      'Invalid road_estimate',
    );
    return {
      ...item,
      road_estimate: {
        distance_m,
        duration_s,
        computed_at,
        ...(Number.isFinite(congested_distance_m) ? { congested_distance_m } : {}),
      },
    };
  });
  const routeCount = sites.filter(({ road_estimate }) => road_estimate !== null).length;
  requireValid(
    source === 'brief' ? routeCount === 0 : routeCount > 0 && routeCount <= routesPerRequest,
    'Road coverage does not match ranking_source',
  );
  return { ranking_source: source, sites, routeCount };
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
}

async function run() {
  const base = env.NFR_DRIVER_API_URL ?? '';
  requireValid(
    /^http:\/\/127\.0\.0\.1(?::\d+)?\/api\/driver\/v1\/?$/.test(base),
    'NFR_DRIVER_API_URL must use a local IPv4 loopback listener or the staging SSH tunnel',
  );
  const token = env.NFR_DRIVER_ACCESS_TOKEN;
  requireValid(token && /^[\w.-]+$/.test(token), 'Missing or invalid NFR_DRIVER_ACCESS_TOKEN');
  const vehicleId = env.NFR_VEHICLE_ID;
  requireValid(/^[1-9]\d*$/.test(vehicleId ?? ''), 'Invalid or missing NFR_VEHICLE_ID');
  const requests = numberEnv('NFR_REQUESTS', 1, 600, true);
  const remaining = numberEnv(
    'NFR_ROUTE_REMAINING',
    routesPerRequest,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const intervalMs = numberEnv('NFR_INTERVAL_MS', 12500, 600000, true);
  requireValid(
    requests * routesPerRequest <= remaining,
    'Planned Route cost exceeds remaining quota',
  );

  const url = new URL(`${base.replace(/\/$/, '')}/stations`);
  url.search = new URLSearchParams({
    vehicle_id: vehicleId,
    latitude: String(numberEnv('NFR_LATITUDE', -90, 90)),
    longitude: String(numberEnv('NFR_LONGITUDE', -180, 180)),
    radius_km: String(numberEnv('NFR_RADIUS_KM', 0.001, 20040)),
    page_size: String(siteCount),
  });
  const soc = numberEnv('NFR_SOC_PERCENT', 0, 80);
  requireValid(soc < 80, 'NFR_SOC_PERCENT must be below the default target of 80');
  const request = () =>
    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });

  url.searchParams.set('sort', 'name');
  const preflight = await request();
  requireValid(preflight.ok, `Station preflight returned HTTP ${preflight.status}`);
  const fixture = readFixture(await preflight.json());
  log({
    phase: 'preflight',
    stations: fixture.size,
    requested: requests,
    planned_route_calls: requests * routesPerRequest,
  });

  url.searchParams.set('sort', 'smart');
  url.searchParams.set('soc_percent', String(soc));
  url.searchParams.set('location_consent', 'true');
  const latencies = [];
  let successful = 0;
  let brief = 0;
  let fullRouteSamples = 0;
  for (let index = 1; index <= requests; index++) {
    const started = performance.now();
    let status = null;
    let latency;
    try {
      const response = await request();
      status = response.status;
      requireValid(response.ok, 'Suggestion HTTP request failed');
      const body = await response.json();
      latency = performance.now() - started;
      const { routeCount, ...ranking } = readRanking(body, fixture);
      successful++;
      brief += Number(ranking.ranking_source === 'brief');
      fullRouteSamples += Number(routeCount === routesPerRequest);
      log({ phase: 'sample', index, status, latency_ms: Math.round(latency), ...ranking });
    } catch (error) {
      latency ??= performance.now() - started;
      const reason =
        error instanceof BenchmarkError ? error.message : 'Request or response failure';
      log({ phase: 'sample', index, status, latency_ms: Math.round(latency), invalid: reason });
      latencies.push(latency);
      break;
    }
    latencies.push(latency);
    if (index < requests) await sleep(intervalMs);
  }

  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 0.95);
  const valid = successful === requests && fullRouteSamples > 0;
  const pass = valid && p95 <= targetMs;
  log({
    phase: 'summary',
    n: latencies.length,
    valid_responses: successful,
    p50_ms: percentile(latencies, 0.5),
    p95_ms: p95,
    brief_ratio: successful ? brief / successful : null,
    full_route_samples: fullRouteSamples,
    valid,
    pass,
  });
  if (!pass) process.exitCode = 1;
}

try {
  await run();
} catch (error) {
  // Suppress native fetch/JSON errors that could contain request or response data.
  console.error(
    error instanceof BenchmarkError ? error.message : 'Benchmark failed before sampling',
  );
  process.exitCode = 1;
}
