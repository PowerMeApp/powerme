import { DriverApiError } from './driver-auth.js';
import { ProviderUnavailable } from './vietmap.js';

// WP3: coordinates/address queries live only in this bounded two-minute memory cache.
export class ProviderCache {
  private cache = new Map<string, { until: number; result: unknown; computed_at: string }>();
  private pending = new Map<string, Promise<unknown>>();
  private budgets = new Map<string, { until: number; count: number }>();
  private active = 0;
  constructor(
    private readonly now = Date.now,
    private readonly ttlMs = 120000,
  ) {}

  async run<T>(
    principal: string,
    key: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
    lane: 'interactive' | 'ranking' = 'interactive',
  ): Promise<{ value: T; computed_at: string; cached: boolean }> {
    if (signal?.aborted) throw new ProviderUnavailable('timeout');
    const scoped = JSON.stringify([principal, key]);
    const now = this.now();
    for (const [key, entry] of this.cache) if (entry.until <= now) this.cache.delete(key);
    const prior = this.cache.get(scoped);
    if (prior)
      return {
        value: structuredClone(prior.result) as T,
        computed_at: prior.computed_at,
        cached: true,
      };
    const pending = this.pending.get(scoped);
    if (pending)
      return structuredClone(await this.forCaller(pending, signal)) as {
        value: T;
        computed_at: string;
        cached: boolean;
      };
    if (this.active >= (lane === 'ranking' ? 3 : 4)) throw new DriverApiError(429, 'provider_busy');
    this.reserve(principal, now, lane);
    this.active++;
    const task = (async () => {
      try {
        const value = await Promise.resolve().then(work);
        const computed_at = new Date(this.now()).toISOString();
        if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(scoped, {
          until: this.now() + this.ttlMs,
          result: structuredClone(value),
          computed_at,
        });
        return { value, computed_at, cached: false };
      } finally {
        this.active--;
        this.pending.delete(scoped);
      }
    })();
    this.pending.set(scoped, task);
    return structuredClone(await this.forCaller(task, signal));
  }

  private async forCaller<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await task;
    // One caller disconnecting must not cancel another caller's shared provider request.
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(new ProviderUnavailable('timeout'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private reserve(principal: string, now: number, lane: 'interactive' | 'ranking') {
    for (const [id, entry] of this.budgets) if (entry.until <= now) this.budgets.delete(id);
    const driver = this.budgets.get(principal);
    const global = this.budgets.get('*');
    if (
      (driver?.count ?? 0) >= (lane === 'ranking' ? 24 : 30) ||
      (global?.count ?? 0) >= (lane === 'ranking' ? 108 : 120)
    )
      throw new DriverApiError(429, 'provider_rate_limited');
    if (this.budgets.size + Number(!driver) + Number(!global) > 1024)
      throw new DriverApiError(429, 'provider_busy');
    // Charge both windows only after both budgets and concurrency admit the miss.
    this.budgets.set(principal, {
      until: driver?.until ?? now + 60000,
      count: (driver?.count ?? 0) + 1,
    });
    this.budgets.set('*', { until: global?.until ?? now + 60000, count: (global?.count ?? 0) + 1 });
  }
}
