import { driverClientIp, loadDriverApiConfig } from '../src/driver/driver-auth.js';

// BE-45: Driver API đứng sau Caddy trên staging. Không tin proxy thì mọi tài xế mang IP của Caddy và
// bộ khoá đăng nhập theo IP (20 lần sai / 60 s → khoá 15 phút) khoá cả nhóm cùng lúc.
const req = (remoteAddress: string | undefined, xff?: string | string[]) =>
  ({
    socket: { remoteAddress },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  }) as unknown as Parameters<typeof driverClientIp>[0];

describe('BE-45 driverClientIp', () => {
  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(driverClientIp(req('172.18.0.2', '203.0.113.9'), {})).toBe('172.18.0.2');
    expect(driverClientIp(req('172.18.0.2', '203.0.113.9'), { trustProxy: false })).toBe(
      '172.18.0.2',
    );
  });

  it('takes the LAST forwarded value (added by Caddy), not a client-supplied first value', () => {
    expect(
      driverClientIp(req('172.18.0.2', '198.51.100.1, 203.0.113.9'), { trustProxy: true }),
    ).toBe('203.0.113.9');
    expect(
      driverClientIp(req('172.18.0.2', ['198.51.100.1', '203.0.113.9']), { trustProxy: true }),
    ).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is missing or blank', () => {
    expect(driverClientIp(req('172.18.0.2'), { trustProxy: true })).toBe('172.18.0.2');
    expect(driverClientIp(req('172.18.0.2', ' '), { trustProxy: true })).toBe('172.18.0.2');
    expect(driverClientIp(req(undefined), {})).toBe('unknown');
  });
});

describe('BE-45 DRIVER_API_TRUST_PROXY', () => {
  it('defaults to false and accepts only true/false', () => {
    expect(loadDriverApiConfig({}).trustProxy).toBe(false);
    expect(loadDriverApiConfig({ DRIVER_API_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadDriverApiConfig({ DRIVER_API_TRUST_PROXY: '1' })).toThrow(
      'Invalid DRIVER_API_TRUST_PROXY',
    );
  });
});
