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

const sample = {
  distance: 400,
  time: 61501,
  points_encoded: false,
  points: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0.00001, 0],
      [0.00002, 0],
      [0.00003, 0],
    ],
  },
};
const annotation = (first: number, last: number, value: number | string) => ({
  first,
  last,
  value,
});
const congestion = [annotation(0, 1, 'heavy'), annotation(1, 2, 'severe'), annotation(2, 3, 'low')];
const congestionDistance = [annotation(0, 1, 75), annotation(1, 2, 125), annotation(2, 3, 200)];
const encoded = { ...sample, points_encoded: true, points: '???A?A?A' };
const pathReply = (path: object) => reply({ code: 'OK', paths: [path] });

it('normalizes signed turns and indexed traffic. Zero-span instructions can precede the final geometry point', async () => {
  const network = pathReply({
    ...sample,
    instructions: [
      { interval: [0, 1], sign: 0, text: 'Đi thẳng', distance: 100, time: 2000 },
      { interval: [1, 1], sign: -2, street_name: 'Đường A', distance: 200, time: 30501 },
      { interval: [1, 1], sign: -2, distance: 200, time: 30501 },
      { interval: [0, 1], sign: 2, distance: 100, time: 2500 },
      { interval: [1, 4], sign: 2, distance: 100, time: 2500 },
      { interval: [2, 2], sign: 4, text: 'Đến nơi', distance: 0, time: 0 },
    ],
    annotations: { congestion, congestion_distance: congestionDistance },
  });
  const route = await new VietmapAdapter('test-key', network).roadRoute(a, b);
  expect((network.mock.calls[0]![0] as URL).searchParams.get('annotations')).toBe(
    'congestion,congestion_distance',
  );
  expect(route).toMatchObject({
    traffic_quality: 'unknown',
    congested_distance_m: 200,
    duration_s: 62,
    traffic_segments: congestion.map(({ first, last, value }) => ({
      start_index: first,
      end_index: last,
      level: value,
    })),
  });
  expect(route.instructions).toEqual([
    {
      start_index: 0,
      end_index: 1,
      sign: 0,
      text: 'Đi thẳng',
      street_name: null,
      distance_m: 100,
      duration_s: 2,
    },
    {
      start_index: 1,
      end_index: 1,
      sign: -2,
      text: 'Đường A',
      street_name: 'Đường A',
      distance_m: 200,
      duration_s: 31,
    },
    {
      start_index: 2,
      end_index: 2,
      sign: 4,
      text: 'Đến nơi',
      street_name: null,
      distance_m: 0,
      duration_s: 0,
    },
  ]);
});

it.each([
  ['overlap', [annotation(0, 2, 'heavy'), annotation(1, 3, 'low')]],
  ['duplicate', [annotation(0, 1, 'low'), annotation(0, 1, 'low')]],
  ['reversed', [annotation(2, 3, 'heavy'), annotation(0, 2, 'low')]],
  ['out of bounds', [annotation(0, 4, 'heavy')]],
  ['empty span', [annotation(0, 0, 'heavy')]],
  ['unindexed', ['low', 'heavy', 'low']],
])('omits %s traffic without rejecting valid route geometry', async (_case, raw) => {
  const result = await new VietmapAdapter(
    'test-key',
    pathReply({
      ...sample,
      instructions: [null],
      annotations: { congestion: raw },
    }),
  ).roadRoute(a, b);
  expect(result).toEqual({
    distance_m: 400,
    duration_s: 62,
    geometry: sample.points,
    traffic_quality: 'unknown',
  });
});

it('retains a known interval and explicit unknown segments for display when coverage is incomplete', async () => {
  const result = await new VietmapAdapter(
    'test-key',
    pathReply({
      ...sample,
      annotations: { congestion: [annotation(0, 1, 'heavy'), annotation(2, 3, 'unknown')] },
    }),
  ).roadRoute(a, b);
  expect(result.traffic_segments).toEqual([
    { start_index: 0, end_index: 1, level: 'heavy' },
    { start_index: 2, end_index: 3, level: 'unknown' },
  ]);
  expect(result).not.toHaveProperty('congested_distance_m');
});

it.each([
  ['coverage verified', congestion, congestionDistance, encoded.points, 200],
  ['known zero', [annotation(0, 3, 'moderate')], undefined, encoded.points, 0],
  ['unknown level', [annotation(0, 3, 'unknown')], [], encoded.points, undefined],
  ['missing meters', congestion, [], encoded.points, undefined],
  ['mismatched meters', congestion, [annotation(0, 2, 200)], encoded.points, undefined],
  [
    'gap',
    [annotation(0, 1, 'heavy'), annotation(2, 3, 'low')],
    congestionDistance,
    encoded.points,
    undefined,
  ],
  ['missing tail', [annotation(0, 2, 'low')], [], encoded.points, undefined],
  ['bad polyline', congestion, congestionDistance, '~~~', undefined],
  [
    'impossible meters',
    [annotation(0, 3, 'heavy')],
    [annotation(0, 3, 420)],
    encoded.points,
    undefined,
  ],
  ['rounded meters', [annotation(0, 3, 'heavy')], [annotation(0, 3, 400.2)], encoded.points, 400],
])(
  'exposes summary congestion only with complete evidence: %s',
  async (_case, levels, meters, points, expected) => {
    const network = pathReply({
      ...encoded,
      points,
      annotations: { congestion: levels, congestion_distance: meters },
    });
    const summary = await new VietmapAdapter('test-key', network).route(a, b);
    expect(summary).toEqual({
      distance_m: 400,
      duration_s: 62,
      ...(expected === undefined ? {} : { congested_distance_m: expected }),
    });
    const params = (network.mock.calls[0]![0] as URL).searchParams;
    expect(params.get('points_encoded')).toBe('true');
    expect(params.get('annotations')).toBe('congestion,congestion_distance');
  },
);

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
