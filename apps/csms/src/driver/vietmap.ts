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
export interface RoadRoute {
  distance_m: number;
  duration_s: number;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  traffic_quality: 'unknown';
}

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

  async route(
    from: Coordinate,
    to: Coordinate,
  ): Promise<{ distance_m: number; duration_s: number }> {
    const data = object(
      await this.get('route/v4', [
        ['point', point(from)],
        ['point', point(to)],
        ['vehicle', 'car'],
        ['points_encoded', 'true'],
      ]),
    );
    if (data.code === 'ZERO_RESULTS') throw new ProviderUnavailable('no_route');
    const path = Array.isArray(data.paths) ? object(data.paths[0]) : {};
    if (data.code !== 'OK' || !nonnegative(path.distance) || !nonnegative(path.time))
      throw new ProviderUnavailable('invalid_response');
    return {
      distance_m: path.distance as number,
      duration_s: Math.ceil((path.time as number) / 1000),
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
    const data = object(
      await this.get(
        'route/v4',
        [
          ['point', point(from)],
          ['point', point(to)],
          ['vehicle', 'car'],
          ['points_encoded', 'false'],
        ],
        signal,
      ),
    );
    if (data.code === 'ZERO_RESULTS') throw new ProviderUnavailable('no_route');
    const route = Array.isArray(data.paths) ? object(data.paths[0]) : {};
    const geometry = object(route.points);
    const coordinates = geometry.coordinates;
    if (
      data.code !== 'OK' ||
      route.points_encoded !== false ||
      !nonnegative(route.distance) ||
      !nonnegative(route.time) ||
      geometry.type !== 'LineString' ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      coordinates.length > 10000 ||
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
    return {
      distance_m: route.distance,
      duration_s: Math.ceil(route.time / 1000),
      geometry: { type: 'LineString', coordinates },
      traffic_quality: 'unknown',
    };
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderUnavailable('invalid_response');
  return value as Record<string, unknown>;
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
