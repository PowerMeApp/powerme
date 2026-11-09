import { databaseId, DriverApiError } from './driver-auth.js';
import { RoadDiscovery } from './road-discovery.js';

const ROOT = '/api/driver/v1';
export function isRoadPath(path: string) {
  return (
    [`${ROOT}/places/autocomplete`, `${ROOT}/places/resolve`].includes(path) ||
    new RegExp(`^${ROOT}/stations/[^/]+/route$`).test(path)
  );
}
export async function handleRoad(
  path: string,
  q: URLSearchParams,
  driver: string,
  road: RoadDiscovery,
  signal: AbortSignal,
) {
  const kind = path.endsWith('/autocomplete')
    ? 'autocomplete'
    : path.endsWith('/resolve')
      ? 'place'
      : 'route';
  const extras = kind === 'autocomplete' ? ['q'] : kind === 'place' ? ['ref_id'] : [];
  const allowed =
    kind === 'place'
      ? ['vehicle_id', 'ref_id', 'location_consent']
      : [
          'vehicle_id',
          'latitude',
          'longitude',
          'location_consent',
          ...(kind === 'autocomplete' ? [] : ['include_vinfast_only']),
          ...extras,
        ];
  for (const key of q.keys())
    if (!allowed.includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
  const vehicle = databaseId(q.get('vehicle_id'));
  if (q.get('location_consent') !== 'true')
    throw new DriverApiError(400, 'location_consent_required');
  if (kind === 'place') {
    const ref = q.get('ref_id') ?? '';
    if (!/^(auto|geocode):[A-Za-z0-9_-]{1,2048}$/.test(ref))
      throw new DriverApiError(400, 'invalid_input');
    return await road.place(driver, vehicle, ref);
  }
  const latitude = number(q, 'latitude', -90, 90);
  const longitude = number(q, 'longitude', -180, 180);
  if ((latitude === undefined) !== (longitude === undefined))
    throw new DriverApiError(400, 'origin_coordinates_required');
  if (kind === 'autocomplete') {
    const text = q.get('q') ?? '';
    if (text.trim().length < 2 || text.length > 120 || /[\x00-\x1f\x7f]/.test(text))
      throw new DriverApiError(400, 'invalid_search');
    return await road.autocomplete(
      driver,
      vehicle,
      text,
      latitude === undefined ? undefined : { latitude, longitude: longitude! },
    );
  }
  if (latitude === undefined || longitude === undefined)
    throw new DriverApiError(400, 'origin_coordinates_required');
  const include = q.get('include_vinfast_only') ?? 'false';
  if (!['true', 'false'].includes(include)) throw new DriverApiError(400, 'invalid_input');
  const site = databaseId(path.split('/').at(-2));
  return await road.route(
    driver,
    vehicle,
    site,
    { latitude, longitude },
    include === 'true',
    signal,
  );
}

function number(q: URLSearchParams, key: string, min: number, max: number): number | undefined {
  if (!q.has(key)) return undefined;
  const raw = q.get(key)!;
  const value = Number(raw);
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(value) || value < min || value > max)
    throw new DriverApiError(400, 'invalid_input');
  return value;
}
