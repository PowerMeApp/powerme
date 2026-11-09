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
    this.spend(principal, 30);
    this.spend('*', 120);
    if (this.active >= 4) throw new DriverApiError(429, 'provider_busy');
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

  private spend(principal: string, limit: number) {
    const now = this.now();
    for (const [id, entry] of this.budgets) if (entry.until <= now) this.budgets.delete(id);
    let budget = this.budgets.get(principal);
    if (!budget) {
      if (this.budgets.size >= 1024) throw new DriverApiError(429, 'provider_busy');
      budget = { until: now + 60000, count: 0 };
      this.budgets.set(principal, budget);
    }
    if (budget.count >= limit) throw new DriverApiError(429, 'provider_rate_limited');
    budget.count++;
  }
}
