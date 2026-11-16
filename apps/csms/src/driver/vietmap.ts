export class ProviderUnavailable extends Error {
  constructor(
    readonly reason:
      | 'unconfigured'
      | 'credentials'
      | 'restricted_or_quota'
      | 'rate_limited'
      | 'timeout'
      | 'network'
      | 'invalid_response'
      | 'no_route',
    readonly httpStatus?: number,
  ) {
    super('provider_unavailable');
  }
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}
export interface AddressSuggestion {
  ref_id: string;
  display: string;
  name: string;
  address: string;
}
export interface Place extends AddressSuggestion, Coordinate {}
export interface RoadSummary {
  distance_m: number;
  duration_s: number;
  congested_distance_m?: number;
}
interface RouteInterval {
  start_index: number;
  end_index: number;
}
export interface RouteInstruction extends RouteInterval {
  sign: number;
  text: string;
  street_name: string | null;
  distance_m: number;
  duration_s: number;
}
export interface TrafficSegment extends RouteInterval {
  level: 'low' | 'moderate' | 'heavy' | 'severe' | 'unknown';
}
export interface RoadRoute extends RoadSummary {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  traffic_quality: 'unknown';
  instructions?: RouteInstruction[];
  traffic_segments?: TrafficSegment[];
}

const MAX_ROUTE_POINTS = 10000;
const ROUTE_ANNOTATIONS = 'congestion,congestion_distance';

// WP3: provider addresses are separate from PowerMe station discovery and ranking.
export class VietmapAdapter {
  constructor(
    private readonly searchKey?: string,
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async autocomplete(text: string, focus?: Coordinate): Promise<AddressSuggestion[]> {
    if (typeof text !== 'string' || text.trim().length < 2 || text.length > 120)
      throw new Error('invalid_search');
    const params: [string, string][] = [
      ['text', text.trim()],
      ['display_type', '1'],
    ];
    if (focus) params.push(['focus', point(focus)]);
    const data = await this.get('autocomplete/v4', params);
    if (!Array.isArray(data) || data.length > 10) throw new ProviderUnavailable('invalid_response');
    return data.map(address);
  }

  async place(refId: string): Promise<Place> {
    if (typeof refId !== 'string' || !/^(auto|geocode):[A-Za-z0-9_-]{1,2048}$/.test(refId))
      throw new Error('invalid_input');
    const data = object(await this.get('place/v4', [['refid', refId]]));
    const location = { latitude: data.lat, longitude: data.lng };
    try {
      point(location as Coordinate);
    } catch {
      throw new ProviderUnavailable('invalid_response');
    }
    return { ...address({ ...data, ref_id: refId }), ...location } as Place;
  }

  async route(from: Coordinate, to: Coordinate): Promise<RoadSummary> {
    const path = await this.routePath(from, to, true);
    const last = path.points_encoded === true ? polylineLastIndex(path.points) : undefined;
    const annotations = record(path.annotations);
    const congested =
      last === undefined
        ? undefined
        : congestedDistance(
            path.distance,
            annotations?.congestion_distance,
            trafficSegments(annotations?.congestion, last),
            last,
          );
    return {
      distance_m: path.distance,
      duration_s: Math.ceil(path.time / 1000),
      ...(congested === undefined ? {} : { congested_distance_m: congested }),
    };
  }

  async matrix(from: Coordinate, to: Coordinate): Promise<{ duration_s: number }> {
    const data = object(
      await this.get('matrix/v4', [
        ['point', point(from)],
        ['point', point(to)],
        ['vehicle', 'car'],
        ['sources', '0'],
        ['destinations', '1'],
        ['annotation', 'duration'],
      ]),
    );
    if (data.code === 'ZERO_RESULTS') throw new ProviderUnavailable('no_route');
    const rows = data.durations;
    if (
      data.code !== 'OK' ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      !Array.isArray(rows[0]) ||
      rows[0].length !== 1 ||
      !nonnegative(rows[0][0])
    )
      throw new ProviderUnavailable('invalid_response');
    return { duration_s: Math.ceil(rows[0][0] as number) };
  }

  async roadRoute(from: Coordinate, to: Coordinate, signal?: AbortSignal): Promise<RoadRoute> {
    const route = await this.routePath(from, to, false, signal);
    const geometry = object(route.points);
    const coordinates = geometry.coordinates;
    if (
      route.points_encoded !== false ||
      geometry.type !== 'LineString' ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      coordinates.length > MAX_ROUTE_POINTS ||
      coordinates.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 2 ||
          !Number.isFinite(p[0]) ||
          !Number.isFinite(p[1]) ||
          Math.abs(p[0]) > 180 ||
          Math.abs(p[1]) > 90,
      )
    )
      throw new ProviderUnavailable('invalid_response');
    const last = coordinates.length - 1;
    const instructions = routeInstructions(route.instructions, last);
    const annotations = record(route.annotations);
    const traffic = trafficSegments(annotations?.congestion, last);
    const congested = congestedDistance(
      route.distance,
      annotations?.congestion_distance,
      traffic,
      last,
    );
    return {
      distance_m: route.distance,
      duration_s: Math.ceil(route.time / 1000),
      geometry: { type: 'LineString', coordinates },
      traffic_quality: 'unknown',
      ...(instructions.length ? { instructions } : {}),
      ...(traffic?.length ? { traffic_segments: traffic } : {}),
      ...(congested === undefined ? {} : { congested_distance_m: congested }),
    };
  }

  private async routePath(
    from: Coordinate,
    to: Coordinate,
    encoded: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> & { distance: number; time: number }> {
    const data = object(
      await this.get(
        'route/v4',
        [
          ['point', point(from)],
          ['point', point(to)],
          ['vehicle', 'car'],
          ['points_encoded', String(encoded)],
          ['annotations', ROUTE_ANNOTATIONS],
        ],
        signal,
      ),
    );
    if (data.code === 'ZERO_RESULTS') throw new ProviderUnavailable('no_route');
    const path = Array.isArray(data.paths) ? record(data.paths[0]) : undefined;
    if (data.code !== 'OK' || !path || !nonnegative(path.distance) || !nonnegative(path.time))
      throw new ProviderUnavailable('invalid_response');
    return { ...path, distance: path.distance, time: path.time };
  }

  private async get(
    path: string,
    params: [string, string][],
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.searchKey) throw new ProviderUnavailable('unconfigured');
    const url = new URL(`https://maps.vietmap.vn/api/${path}`);
    url.search = new URLSearchParams([['apikey', this.searchKey], ...params]).toString();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    try {
      const response = await this.request(url, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderUnavailable(
          response.status === 401 || response.status === 403
            ? 'credentials'
            : response.status === 423
              ? 'restricted_or_quota'
              : response.status === 429
                ? 'rate_limited'
                : 'network',
          response.status,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderUnavailable('invalid_response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 524288) throw new ProviderUnavailable('invalid_response');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new ProviderUnavailable('invalid_response');
      }
    } catch (error) {
      if (error instanceof ProviderUnavailable) throw error;
      // WP3: fetch errors can contain a URL with the key; never expose their cause.
      throw new ProviderUnavailable(signal.aborted ? 'timeout' : 'network');
    }
  }
}

function point(c: Coordinate): string {
  if (
    !Number.isFinite(c.latitude) ||
    !Number.isFinite(c.longitude) ||
    Math.abs(c.latitude) > 90 ||
    Math.abs(c.longitude) > 180
  )
    throw new Error('invalid_input');
  return `${c.latitude},${c.longitude}`;
}
function object(value: unknown): Record<string, unknown> {
  const entry = record(value);
  if (!entry) throw new ProviderUnavailable('invalid_response');
  return entry;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function interval(start: unknown, end: unknown, last: number): RouteInterval | undefined {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > last
  )
    return undefined;
  return { start_index: start, end_index: end };
}
function routeInstructions(raw: unknown, last: number): RouteInstruction[] {
  if (!Array.isArray(raw) || raw.length > MAX_ROUTE_POINTS) return [];
  const result: RouteInstruction[] = [];
  for (const entry of raw) {
    const step = record(entry);
    const indices = step?.interval;
    if (!step || !Array.isArray(indices) || indices.length !== 2) continue;
    const range = interval(indices[0], indices[1], last);
    const { sign, distance, time } = step;
    const previous = result.at(-1);
    if (
      !range ||
      (previous && range.start_index < previous.end_index) ||
      typeof sign !== 'number' ||
      !Number.isSafeInteger(sign) ||
      !nonnegative(distance) ||
      !nonnegative(time) ||
      (previous?.start_index === range.start_index &&
        previous.end_index === range.end_index &&
        previous.sign === sign)
    )
      continue;
    const street_name = routeLabel(step.street_name);
    result.push({
      ...range,
      sign,
      text: routeLabel(step.text) ?? street_name ?? '',
      street_name,
      distance_m: distance,
      duration_s: Math.ceil(time / 1000),
    });
  }
  return result;
}
function routeLabel(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 512 ? raw.trim() || null : null;
}
function indexedAnnotations<T>(
  raw: unknown,
  last: number,
  valid: (value: unknown) => value is T,
): (RouteInterval & { value: T })[] | undefined {
  if (!Array.isArray(raw) || raw.length > last) return undefined;
  const result: (RouteInterval & { value: T })[] = [];
  let previousEnd = 0;
  for (const entry of raw) {
    const row = record(entry);
    if (!row) return undefined;
    const range = interval(row.first, row.last, last);
    if (
      !range ||
      range.end_index === range.start_index ||
      range.start_index < previousEnd ||
      !valid(row.value)
    )
      return undefined;
    result.push({ ...range, value: row.value });
    previousEnd = range.end_index;
  }
  return result;
}
function trafficSegments(raw: unknown, last: number): TrafficSegment[] | undefined {
  return indexedAnnotations(
    raw,
    last,
    (level): level is TrafficSegment['level'] =>
      level === 'low' ||
      level === 'moderate' ||
      level === 'heavy' ||
      level === 'severe' ||
      level === 'unknown',
  )?.map(({ value: level, ...range }) => ({ ...range, level }));
}
function congestedDistance(
  routeDistance: number,
  rawDistances: unknown,
  segments: TrafficSegment[] | undefined,
  last: number,
): number | undefined {
  if (!segments?.length || segments.at(-1)?.end_index !== last) return undefined;
  const distances = indexedAnnotations(rawDistances, last, nonnegative);
  const metersByRange = new Map(
    distances?.map(({ start_index, end_index, value }) => [`${start_index}:${end_index}`, value]),
  );
  let total = 0;
  let previousEnd = 0;
  for (const { start_index, end_index, level } of segments) {
    if (start_index !== previousEnd || level === 'unknown') return undefined;
    previousEnd = end_index;
    if (level === 'heavy' || level === 'severe') {
      const meters = metersByRange.get(`${start_index}:${end_index}`);
      if (meters === undefined) return undefined;
      total += meters;
    }
  }
  // Route totals may be rounded independently of the individual segment lengths.
  return total <= routeDistance + 1 ? Math.min(total, routeDistance) : undefined;
}
function polylineLastIndex(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_ROUTE_POINTS * 12) return undefined;
  const coordinates = [0, 0];
  let components = 0;
  let value = 0;
  let shift = 0;
  for (let index = 0; index < raw.length; index++) {
    const chunk = raw.charCodeAt(index) - 63;
    if (chunk < 0 || chunk > 63 || shift > 25) return undefined;
    value += (chunk & 31) * 2 ** shift;
    if (chunk >= 32) {
      shift += 5;
      continue;
    }
    const axis = components++ % 2;
    const delta = Math.floor(value / 2);
    coordinates[axis] = coordinates[axis]! + (value % 2 ? -delta - 1 : delta);
    if (Math.abs(coordinates[axis]!) > (axis === 0 ? 90 : 180) * 100000) return undefined;
    value = 0;
    shift = 0;
  }
  const count = components / 2;
  return shift === 0 && Number.isInteger(count) && count >= 2 && count <= MAX_ROUTE_POINTS
    ? count - 1
    : undefined;
}
function address(value: unknown): AddressSuggestion {
  const row = object(value);
  for (const field of ['ref_id', 'display', 'name', 'address'])
    if (typeof row[field] !== 'string' || (row[field] as string).length > 4096)
      throw new ProviderUnavailable('invalid_response');
  return {
    ref_id: row.ref_id as string,
    display: row.display as string,
    name: row.name as string,
    address: row.address as string,
  };
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
