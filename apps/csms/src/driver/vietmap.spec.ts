import { ProviderUnavailable, VietmapAdapter } from './vietmap.js';

const a = { latitude: 10.888, longitude: 106.8 };
const b = { latitude: 10.889, longitude: 106.801 };
it('validates actual unencoded GeoJSON lon/lat geometry and keeps traffic unknown', async () => {
  const network = reply({
    code: 'OK',
    paths: [
      {
        distance: 137.4,
        time: 49999,
        points_encoded: false,
        points: {
          type: 'LineString',
          coordinates: [
            [106.8, 10.888],
            [106.801, 10.889],
          ],
        },
      },
    ],
  });
  const result = await new VietmapAdapter('test-key', network).roadRoute(a, b);
  expect(result).toMatchObject({
    duration_s: 50,
    traffic_quality: 'unknown',
    geometry: {
      type: 'LineString',
      coordinates: [
        [106.8, 10.888],
        [106.801, 10.889],
      ],
    },
  });
  expect((network.mock.calls[0]![0] as URL).searchParams.get('points_encoded')).toBe('false');
  await expect(
    new VietmapAdapter(
      'test-key',
      reply({
        code: 'OK',
        paths: [
          {
            distance: 1,
            time: 1,
            points_encoded: false,
            points: {
              type: 'LineString',
              coordinates: [
                [10.8, 106.8],
                [10.9, 106.9],
              ],
            },
          },
        ],
      }),
    ).roadRoute(a, b),
  ).rejects.toMatchObject({ reason: 'invalid_response' });
});
const reply = (body: unknown, status = 200) =>
  jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

it('separates addresses and place coordinates from station inventory', async () => {
  const record = { ref_id: 'auto:abc', display: 'Đông Hòa', name: 'Đông Hòa', address: 'Việt Nam' };
  const network = reply([record]);
  expect(await new VietmapAdapter('test-key', network).autocomplete('Đông Hòa', a)).toEqual([
    record,
  ]);
  const url = network.mock.calls[0]![0] as URL;
  expect(url.pathname).toBe('/api/autocomplete/v4');
  expect(url.searchParams.get('focus')).toBe('10.888,106.8');
  expect(network.mock.calls[0]![1]?.redirect).toBe('error');
  expect(
    await new VietmapAdapter(
      'test-key',
      reply({ ...record, lat: a.latitude, lng: a.longitude }),
    ).place(record.ref_id),
  ).toEqual({ ...record, ...a });
});

it('keeps Route milliseconds and Matrix seconds explicit and preserves repeated points', async () => {
  const network = reply({ code: 'OK', paths: [{ distance: 200.1, time: 12501 }] });
  expect(await new VietmapAdapter('test-key', network).route(a, b)).toEqual({
    distance_m: 200.1,
    duration_s: 13,
  });
  expect((network.mock.calls[0]![0] as URL).searchParams.getAll('point')).toEqual([
    '10.888,106.8',
    '10.889,106.801',
  ]);
  expect(
    await new VietmapAdapter('test-key', reply({ code: 'OK', durations: [[12.1]] })).matrix(a, b),
  ).toEqual({ duration_s: 13 });
});

it.each([
  [401, 'credentials'],
  [403, 'credentials'],
  [423, 'restricted_or_quota'],
  [429, 'rate_limited'],
  [500, 'network'],
])('sanitizes provider HTTP %s', async (status, reason) => {
  await expect(
    new VietmapAdapter('test-key', reply({ secret: 'must-not-escape' }, status as number)).route(
      a,
      b,
    ),
  ).rejects.toMatchObject({ message: 'provider_unavailable', reason, httpStatus: status });
});

it('fails closed on absent key, transport failures, oversized JSON and invalid schemas', async () => {
  const network = reply([]);
  await expect(new VietmapAdapter(undefined, network).autocomplete('abc')).rejects.toMatchObject({
    reason: 'unconfigured',
  });
  expect(network).not.toHaveBeenCalled();
  const failed = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockRejectedValue(new Error('secret URL must-not-escape'));
  await expect(new VietmapAdapter('test-key', failed).autocomplete('abc')).rejects.toMatchObject({
    reason: 'network',
    message: 'provider_unavailable',
  });
  for (const body of [{}, [null], { code: 'OK', durations: [[null]] }, 'x'.repeat(524289)]) {
    const adapter = new VietmapAdapter('test-key', reply(body));
    await expect(adapter.autocomplete('abc')).rejects.toBeInstanceOf(ProviderUnavailable);
  }
  await expect(
    new VietmapAdapter('test-key', reply({ code: 'ZERO_RESULTS' })).route(a, b),
  ).rejects.toMatchObject({ reason: 'no_route' });
  await expect(
    new VietmapAdapter('test-key', reply({ code: 'OK', durations: [[null]] })).matrix(a, b),
  ).rejects.toMatchObject({ reason: 'invalid_response' });
});

it('aborts on timeout without leaking the provider URL', async () => {
  const network: typeof fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('secret URL')), {
        once: true,
      });
    });
  await expect(new VietmapAdapter('test-key', network, 10).route(a, b)).rejects.toMatchObject({
    reason: 'timeout',
    message: 'provider_unavailable',
  });
});
