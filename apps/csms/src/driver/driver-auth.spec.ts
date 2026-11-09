import { databaseId, loadDriverApiConfig } from './driver-auth.js';

it('disables dev auth by default and requires explicit local/test configuration', () => {
  expect(loadDriverApiConfig({}).devAuth).toBe(false);
  for (const NODE_ENV of [undefined, 'production', 'staging', 'development', 'test'])
    expect(() => loadDriverApiConfig({ NODE_ENV, DRIVER_API_DEV_AUTH: 'true' })).toThrow();
  expect(
    loadDriverApiConfig({ NODE_ENV: 'test', DRIVER_API_ENV: 'test', DRIVER_API_DEV_AUTH: 'true' })
      .devAuth,
  ).toBe(true);
  expect(() =>
    loadDriverApiConfig({
      NODE_ENV: 'production',
      DRIVER_API_ENV: 'local',
      DRIVER_API_DEV_AUTH: 'true',
    }),
  ).toThrow();
});

it('requires complete JWT config with a strong base64 key', () => {
  const env = {
    DRIVER_API_JWT_SECRET_BASE64: Buffer.alloc(32, 1).toString('base64'),
    DRIVER_API_JWT_ISSUER: 'powerme-test',
    DRIVER_API_JWT_AUDIENCE: 'driver-test',
  };
  expect(loadDriverApiConfig(env).secret).toHaveLength(32);
  expect(() => loadDriverApiConfig({ ...env, DRIVER_API_JWT_ISSUER: '' })).toThrow();
  expect(() => loadDriverApiConfig({ ...env, DRIVER_API_JWT_SECRET_BASE64: 'short' })).toThrow();
});

it('defaults the refresh token life to 30 days and bounds DRIVER_API_REFRESH_TTL_S', () => {
  expect(loadDriverApiConfig({}).refreshTtlS).toBe(2592000);
  expect(loadDriverApiConfig({ DRIVER_API_REFRESH_TTL_S: '' }).refreshTtlS).toBe(2592000);
  expect(loadDriverApiConfig({ DRIVER_API_REFRESH_TTL_S: '3600' }).refreshTtlS).toBe(3600);
  expect(loadDriverApiConfig({ DRIVER_API_REFRESH_TTL_S: '7776000' }).refreshTtlS).toBe(7776000);
  for (const value of ['900', '3599', '7776001', '1e5', '-3600', '86400.5', 'abc'])
    expect(() => loadDriverApiConfig({ DRIVER_API_REFRESH_TTL_S: value })).toThrow();
});

it('keeps bigint IDs lossless and rejects malformed/overflow IDs', () => {
  expect(databaseId('9223372036854775807')).toBe('9223372036854775807');
  for (const id of ['0', '01', '-1', '1.0', '1e3', '9223372036854775808', 1, null])
    expect(() => databaseId(id)).toThrow();
});
