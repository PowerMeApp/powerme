import { randomBytes } from 'node:crypto';
import { assertConfigured, AuthError, loadDashboardAuthConfig } from './auth.js';

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
});
