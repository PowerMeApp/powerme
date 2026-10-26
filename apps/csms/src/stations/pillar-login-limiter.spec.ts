/**
 * PillarLoginLimiter — issue #40: failed pillar logins are capped per serial + IP and per IP,
 * checked before any scrypt hash. A fake clock drives the windows.
 */
import { PillarLoginLimiter } from './pillar-login-limiter';

const SERIAL = 'RH24D1-00077';
const IP = '203.0.113.7';

function makeLimiter() {
  let t = 1_000_000;
  const limiter = new PillarLoginLimiter(undefined, () => t);
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe('PillarLoginLimiter (issue #40)', () => {
  it('5 failures in 60 s lock the serial from that IP for 15 min; another IP is not affected', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 1; i <= 4; i++) {
      expect(limiter.recordFailure(SERIAL, IP).lockedNow).toBeNull();
      advance(1_000);
    }
    expect(limiter.recordFailure(SERIAL, IP)).toMatchObject({
      lockedNow: 'serial',
      serialFailures: 5,
    });
    expect(limiter.check(SERIAL, IP)).toEqual({ locked: true, retryAfterS: 900 });
    expect(limiter.check(SERIAL, '198.51.100.1')).toEqual({ locked: false });

    advance(15 * 60_000 - 1);
    expect(limiter.check(SERIAL, IP).locked).toBe(true);
    advance(1);
    expect(limiter.check(SERIAL, IP)).toEqual({ locked: false });
  });

  it('failures older than the 60 s window do not count', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure(SERIAL, IP);
    advance(60_000);
    expect(limiter.recordFailure(SERIAL, IP)).toMatchObject({ lockedNow: null, serialFailures: 1 });
    expect(limiter.check(SERIAL, IP).locked).toBe(false);
  });

  it('a successful login clears the serial counter', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure(SERIAL, IP);
    limiter.recordSuccess(SERIAL, IP);
    expect(limiter.recordFailure(SERIAL, IP).serialFailures).toBe(1);
  });

  it('20 failures from one IP across many serials lock the whole IP', () => {
    const { limiter } = makeLimiter();
    for (let i = 1; i < 20; i++) {
      expect(limiter.recordFailure(`SERIAL-${i}`, IP).lockedNow).toBeNull();
    }
    expect(limiter.recordFailure('SERIAL-20', IP).lockedNow).toBe('ip');
    expect(limiter.check('ANY-OTHER-SERIAL', IP).locked).toBe(true);
    expect(limiter.check('ANY-OTHER-SERIAL', '198.51.100.1').locked).toBe(false);
  });

  it('caps logins in flight per IP, so a parallel burst cannot outrun the counters', () => {
    const { limiter } = makeLimiter();
    const releases = Array.from({ length: 20 }, () => limiter.begin(IP));
    expect(limiter.check(SERIAL, IP)).toEqual({ locked: true, retryAfterS: 1 });
    expect(limiter.check(SERIAL, '198.51.100.1').locked).toBe(false);
    releases[0]!();
    releases[0]!(); // releasing twice is harmless
    expect(limiter.check(SERIAL, IP).locked).toBe(false);
  });
});
