import { ProviderCache } from './provider-cache.js';
it('coalesces concurrent calls, scopes principals, expires at two minutes and never caches failure', async () => {
  let now = 0;
  const cache = new ProviderCache(() => now);
  let calls = 0;
  const work = async () => {
    calls++;
    return { count: calls };
  };
  await Promise.all([cache.run('1', 'road', work), cache.run('1', 'road', work)]);
  expect(calls).toBe(1);
  expect((await cache.run('1', 'road', work)).cached).toBe(true);
  await cache.run('2', 'road', work);
  expect(calls).toBe(2);
  now = 120000;
  await cache.run('1', 'road', work);
  expect(calls).toBe(3);
  await expect(
    cache.run('1', 'bad', () => {
      throw new Error('failure');
    }),
  ).rejects.toThrow('failure');
  await cache.run('1', 'bad', work);
  expect(calls).toBe(4);
});
it('bounds concurrency and charges per-principal requests only on provider misses', async () => {
  const cache = new ProviderCache();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = [0, 1, 2, 3].map((i) => cache.run('1', String(i), () => gate));
  await expect(cache.run('1', 'fifth', async () => 0)).rejects.toMatchObject({
    status: 429,
    code: 'provider_busy',
  });
  release();
  await Promise.all(pending);
  const budget = new ProviderCache();
  for (let i = 0; i < 30; i++) await budget.run('1', String(i), async () => i);
  expect((await budget.run('1', '0', async () => 0)).cached).toBe(true);
  await expect(budget.run('1', 'overflow', async () => 0)).rejects.toMatchObject({
    status: 429,
    code: 'provider_rate_limited',
  });
});

it('caps misses across principals at 120 per minute and reopens the budget after expiry', async () => {
  let now = 0;
  const cache = new ProviderCache(() => now);
  const work = jest.fn(async () => 'value');
  for (let i = 0; i < 120; i++) await cache.run(`driver-${i}`, 'route', work);
  await expect(cache.run('driver-overflow', 'route', work)).rejects.toMatchObject({
    status: 429,
    code: 'provider_rate_limited',
  });
  expect(work).toHaveBeenCalledTimes(120);
  expect((await cache.run('driver-0', 'route', work)).cached).toBe(true);
  now = 60000;
  expect((await cache.run('driver-overflow', 'route', work)).cached).toBe(false);
  expect(work).toHaveBeenCalledTimes(121);
});

it('does not let one caller cancellation poison shared work or another caller', async () => {
  const cache = new ProviderCache();
  const first = new AbortController();
  const second = new AbortController();
  let release!: (value: { value: number }) => void;
  const work = jest.fn(
    () =>
      new Promise<{ value: number }>((resolve) => {
        release = resolve;
      }),
  );
  const cancelled = cache.run('1', 'route', work, first.signal);
  const surviving = cache.run('1', 'route', work, second.signal);
  first.abort();
  await expect(cancelled).rejects.toMatchObject({ reason: 'timeout' });
  release({ value: 1 });
  const result = await surviving;
  result.value.value = 2;
  expect(work).toHaveBeenCalledTimes(1);
  expect((await cache.run('1', 'route', work)).value).toEqual({ value: 1 });
});

it('evicts beyond 128 entries without logging keys or retaining expired values', async () => {
  let now = 0;
  const cache = new ProviderCache(() => now);
  let calls = 0;
  const work = async () => ++calls;
  for (let i = 0; i < 129; i++) {
    if (i === 120) now = 60000;
    await cache.run(String(i), String(i), work);
  }
  expect((await cache.run('127', '127', work)).cached).toBe(true);
  expect((await cache.run('0', '0', work)).cached).toBe(false);
  expect(calls).toBe(130);
});

it('preserves six driver calls for interactive routes and refreshes the minute window', async () => {
  let now = 0;
  const cache = new ProviderCache(() => now);
  const work = jest.fn(async () => 0);
  for (let i = 0; i < 24; i++) await cache.run('driver', String(i), work, undefined, 'ranking');
  await expect(cache.run('driver', 'cold', work, undefined, 'ranking')).rejects.toMatchObject({
    code: 'provider_rate_limited',
  });
  expect((await cache.run('driver', '0', work, undefined, 'ranking')).cached).toBe(true);
  for (let i = 0; i < 6; i++) await cache.run('driver', `manual-${i}`, work);
  await expect(cache.run('driver', 'overflow', work)).rejects.toMatchObject({
    code: 'provider_rate_limited',
  });
  expect(work).toHaveBeenCalledTimes(30);
  now = 60000;
  await expect(cache.run('driver', 'cold', work, undefined, 'ranking')).resolves.toMatchObject({
    cached: false,
  });
});

it('reserves global calls and an active slot without charging rejected requests', async () => {
  const cache = new ProviderCache(() => 0);
  const work = jest.fn(async () => 0);
  for (let i = 0; i < 105; i++) await cache.run(`driver-${i}`, 'route', work, undefined, 'ranking');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = [0, 1, 2].map((i) =>
    cache.run('series', String(i), () => gate, undefined, 'ranking'),
  );
  await expect(cache.run('series', 'extra', work, undefined, 'ranking')).rejects.toMatchObject({
    code: 'provider_busy',
  });
  const shared = cache.run('series', '0', () => gate, undefined, 'ranking');
  await expect(cache.run('series', 'interactive', work)).resolves.toMatchObject({ cached: false });
  release();
  await Promise.all([...pending, shared]);
  await expect(cache.run('next', 'ranking', work, undefined, 'ranking')).rejects.toMatchObject({
    code: 'provider_rate_limited',
  });
  for (let i = 0; i < 11; i++) await cache.run('next', String(i), work);
  await expect(cache.run('next', 'overflow', work)).rejects.toMatchObject({
    code: 'provider_rate_limited',
  });
  expect(work).toHaveBeenCalledTimes(117);
});
