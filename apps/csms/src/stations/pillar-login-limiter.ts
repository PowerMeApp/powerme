/**
 * PillarLoginLimiter — caps failed Basic-auth upgrades before PillarAuthService spends a scrypt
 * hash on them (issue #40, ADR-0011 "Consequences — costs").
 *
 * Two counters, each a sliding window of failure times:
 *   - per serial + client IP: 5 failures / 60 s → locked 15 min
 *   - per client IP:         20 failures / 60 s → locked 15 min
 * While a key is locked every attempt from it is refused with 429, even with the right password,
 * and no hash is computed. A successful login clears the serial + IP counter (not the IP one).
 * Attempts still being hashed count too: one IP may have at most `perIp.maxFailures` logins in
 * flight, so a burst of parallel upgrades cannot get past the counters before they are written.
 *
 * The serial counter is keyed with the IP so that a stranger who knows a serial (printed on the
 * pillar) locks out only themselves, not the real pillar on its own connection.
 *
 * Known limit: the state is in memory, so it resets on restart and is not shared between
 * processes. That is enough for the single-process CSMS (ADR-0002); move it to Redis when there
 * is more than one instance.
 */

export interface LoginLimitRule {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}

export interface PillarLoginLimits {
  perSerial: LoginLimitRule;
  perIp: LoginLimitRule;
}

export const DEFAULT_PILLAR_LOGIN_LIMITS: PillarLoginLimits = {
  perSerial: { maxFailures: 5, windowMs: 60_000, lockMs: 15 * 60_000 },
  perIp: { maxFailures: 20, windowMs: 60_000, lockMs: 15 * 60_000 },
};

/** Above this many tracked keys, expired entries are swept on the next failure. */
const SWEEP_THRESHOLD = 10_000;

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export type LockState = { locked: false } | { locked: true; retryAfterS: number };

/** Result of recording a failure: `lockedNow` names the counter that just tripped, if any. */
export interface FailureResult {
  lockedNow: 'serial' | 'ip' | null;
  serialFailures: number;
  ipFailures: number;
}

export class PillarLoginLimiter {
  private readonly bySerial = new Map<string, Entry>();
  private readonly byIp = new Map<string, Entry>();
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly limits: PillarLoginLimits = DEFAULT_PILLAR_LOGIN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checked before any DB lookup or hashing. */
  check(serial: string, ip: string): LockState {
    const t = this.now();
    const until = Math.max(
      this.bySerial.get(serialKey(serial, ip))?.lockedUntil ?? 0,
      this.byIp.get(ip)?.lockedUntil ?? 0,
    );
    if (until > t) return { locked: true, retryAfterS: Math.ceil((until - t) / 1000) };
    if ((this.inFlight.get(ip) ?? 0) >= this.limits.perIp.maxFailures) {
      return { locked: true, retryAfterS: 1 };
    }
    return { locked: false };
  }

  /** Marks one attempt from `ip` as being checked; call the returned function when it is done. */
  begin(ip: string): () => void {
    this.inFlight.set(ip, (this.inFlight.get(ip) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.inFlight.get(ip) ?? 1) - 1;
      if (n > 0) this.inFlight.set(ip, n);
      else this.inFlight.delete(ip);
    };
  }

  recordFailure(serial: string, ip: string): FailureResult {
    const t = this.now();
    if (this.bySerial.size + this.byIp.size > SWEEP_THRESHOLD) this.sweep(t);
    const serialFailures = this.bump(
      this.bySerial,
      serialKey(serial, ip),
      this.limits.perSerial,
      t,
    );
    const ipFailures = this.bump(this.byIp, ip, this.limits.perIp, t);
    const lockedNow =
      serialFailures === this.limits.perSerial.maxFailures
        ? 'serial'
        : ipFailures === this.limits.perIp.maxFailures
          ? 'ip'
          : null;
    return { lockedNow, serialFailures, ipFailures };
  }

  recordSuccess(serial: string, ip: string): void {
    this.bySerial.delete(serialKey(serial, ip));
  }

  /** Adds a failure at `t` and locks the key when it reaches the limit; returns the window count. */
  private bump(map: Map<string, Entry>, key: string, rule: LoginLimitRule, t: number): number {
    const entry = map.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((at) => at > t - rule.windowMs);
    entry.failures.push(t);
    if (entry.failures.length >= rule.maxFailures) entry.lockedUntil = t + rule.lockMs;
    map.set(key, entry);
    return entry.failures.length;
  }

  private sweep(t: number): void {
    const windowMs = Math.max(this.limits.perSerial.windowMs, this.limits.perIp.windowMs);
    for (const map of [this.bySerial, this.byIp]) {
      for (const [key, entry] of map) {
        if (entry.lockedUntil <= t && entry.failures.every((at) => at <= t - windowMs)) {
          map.delete(key);
        }
      }
    }
  }
}

function serialKey(serial: string, ip: string): string {
  return `${serial}\u0000${ip}`;
}
