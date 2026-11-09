import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { VietmapAdapter, ProviderUnavailable } from '../dist/driver/vietmap.js';

const envFile = process.argv[2];
const output = process.argv[3];
const roadOnly = process.argv[4] === '--road-only';
if (!envFile || !output)
  throw new Error('Usage: node scripts/vietmap-probe.mjs <infra/.env> <output.json>');
const key = parseEnv(readFileSync(envFile, 'utf8')).VIETMAP_SEARCH_API_KEY;
if (!key) throw new Error('VIETMAP_SEARCH_API_KEY is absent');
const adapter = new VietmapAdapter(key);
const from = { latitude: 10.888, longitude: 106.8 };
const to = { latitude: 10.889, longitude: 106.801 };
const results = {
  checked_at: new Date().toISOString(),
  ...(roadOnly ? {} : { synthetic_public_coordinates: [from, to] }),
  capabilities: {},
};
async function check(name, operation) {
  try {
    const data = await operation();
    results.capabilities[name] = { available: true, ...data };
  } catch (error) {
    results.capabilities[name] = {
      available: false,
      reason: error instanceof ProviderUnavailable ? error.reason : 'invalid_response',
      ...(error instanceof ProviderUnavailable && error.httpStatus
        ? { http_status: error.httpStatus }
        : {}),
    };
  }
}
let selected;
if (roadOnly) {
  await check('road_geometry_v4', async () => {
    const route = await adapter.roadRoute(from, to);
    return {
      geometry_type: route.geometry.type,
      vertex_count: route.geometry.coordinates.length,
      coordinate_types: route.geometry.coordinates[0].map((value) => typeof value),
      distance_m: route.distance_m,
      duration_s: route.duration_s,
    };
  });
} else {
  await check('autocomplete_v4', async () => {
    const items = await adapter.autocomplete('Đông Hòa', from);
    selected = items[0]?.ref_id;
    return { count: items.length };
  });
  if (selected)
    await check('place_v4', async () => {
      await adapter.place(selected);
      return {};
    });
  await check('route_v4', () => adapter.route(from, to));
  await check('matrix_v4', () => adapter.matrix(from, to));
}
writeFileSync(output, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(results));
