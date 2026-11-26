import { randomBytes } from 'node:crypto';
import {
  assertConfigured,
  AuthError,
  DASHBOARD_TOKEN_TTL_S,
  loadDashboardAuthConfig,
  parseAllowedOrigins,
} from './auth.js';

const key = randomBytes(32).toString('base64');
const full = {
  DASHBOARD_JWT_SECRET_BASE64: key,
  DASHBOARD_JWT_ISSUER: 'powerme-test',
  DASHBOARD_JWT_AUDIENCE: 'powerme-dashboard',
};

describe('loadDashboardAuthConfig (FE-01a, ADR-0018)', () => {
  it('is empty when none of the three variables is set, and the API then answers 503', () => {
    const config = loadDashboardAuthConfig({});
    expect(config).toEqual({});
    expect(() => assertConfigured(config)).toThrow(AuthError);
    try {
      assertConfigured(config);
    } catch (error) {
      expect((error as AuthError).status).toBe(503);
      expect((error as AuthError).code).toBe('auth_unavailable');
    }
  });

  it('loads a canonical base64 key of at least 32 bytes with issuer and audience', () => {
    const config = loadDashboardAuthConfig(full);
    expect(Buffer.from(config.secret!).toString('base64')).toBe(key);
    expect(config.issuer).toBe('powerme-test');
    expect(config.audience).toBe('powerme-dashboard');
  });

  it.each([
    ['only the key', { DASHBOARD_JWT_SECRET_BASE64: key }],
    ['no audience', { ...full, DASHBOARD_JWT_AUDIENCE: '' }],
    ['blank issuer', { ...full, DASHBOARD_JWT_ISSUER: '  ' }],
    ['a short key', { ...full, DASHBOARD_JWT_SECRET_BASE64: randomBytes(16).toString('base64') }],
    ['non-base64', { ...full, DASHBOARD_JWT_SECRET_BASE64: 'not base64!' }],
    ['url-safe base64', { ...full, DASHBOARD_JWT_SECRET_BASE64: key.replace(/\+/g, '-') + '-' }],
  ])('refuses to start with %s', (_, env) => {
    expect(() => loadDashboardAuthConfig(env)).toThrow();
  });

  it('T125: refresh life is optional (12 h default at use), within 3600..86400', () => {
    expect(DASHBOARD_TOKEN_TTL_S).toBe(900);
    expect(loadDashboardAuthConfig(full).refreshTtlS).toBeUndefined();
    expect(loadDashboardAuthConfig({ ...full, DASHBOARD_JWT_REFRESH_TTL_S: '' }).refreshTtlS).toBe(
      undefined,
    );
    expect(
      loadDashboardAuthConfig({ ...full, DASHBOARD_JWT_REFRESH_TTL_S: '3600' }).refreshTtlS,
    ).toBe(3600);
    expect(loadDashboardAuthConfig({ DASHBOARD_JWT_REFRESH_TTL_S: '86400' })).toEqual({
      refreshTtlS: 86400,
    });
  });

  it.each(['3599', '86401', '0', '-1', '1.5', 'abc', '012'])(
    'refuses to start with DASHBOARD_JWT_REFRESH_TTL_S=%s',
    (v) => {
      expect(() => loadDashboardAuthConfig({ ...full, DASHBOARD_JWT_REFRESH_TTL_S: v })).toThrow(
        /DASHBOARD_JWT_REFRESH_TTL_S/,
      );
    },
  );
});

describe('BE-46 DASHBOARD_ALLOWED_ORIGINS', () => {
  it('is empty when unset and lists exact https origins', () => {
    expect(loadDashboardAuthConfig({}).allowedOrigins).toBeUndefined();
    expect(parseAllowedOrigins(' https://a.example , https://b.example:8443')).toEqual([
      'https://a.example',
      'https://b.example:8443',
    ]);
    expect(
      loadDashboardAuthConfig({ ...full, DASHBOARD_ALLOWED_ORIGINS: 'https://a.example' })
        .allowedOrigins,
    ).toEqual(['https://a.example']);
  });

  it.each([
    'http://a.example',
    'https://a.example/',
    'https://a.example/x',
    '*',
    'a.example',
    'https://a.example,',
  ])('rejects %p', (raw) => {
    expect(() => parseAllowedOrigins(raw)).toThrow('DASHBOARD_ALLOWED_ORIGINS');
  });
});
