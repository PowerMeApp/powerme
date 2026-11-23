import { ChargingError } from './charging-error.js';
import {
  type ChargePolicy,
  startCreditPolicy,
  validateChargePolicy,
} from './charge-start-policy.js';

type StartIdentity = { connectorId: number; vehicleId: number };
export type EnergyStartInput = StartIdentity & { mode: 'energy_kwh'; energyLimitWh: number };
export type ChargeStartInput =
  | EnergyStartInput
  | (StartIdentity & { mode: 'full' })
  | (StartIdentity & { mode: 'timed'; durationMinutes: number })
  | (StartIdentity & { mode: 'amount_vnd'; amountLimitVnd: number });
export type ChargeMode = ChargeStartInput['mode'];

export function chargeLimit(input: ChargeStartInput): number | null {
  switch (input.mode) {
    case 'full':
      return null;
    case 'energy_kwh':
      return input.energyLimitWh;
    case 'timed':
      return input.durationMinutes;
    case 'amount_vnd':
      return input.amountLimitVnd;
  }
}

export function validateChargeStart(input: ChargeStartInput): void {
  if (!input || typeof input !== 'object') throw new ChargingError('invalid_input');
  const fields = {
    full: null,
    timed: 'durationMinutes',
    energy_kwh: 'energyLimitWh',
    amount_vnd: 'amountLimitVnd',
  };
  if (!Object.hasOwn(fields, input.mode)) throw new ChargingError('unsupported_mode');
  const limitField = fields[input.mode];
  if (limitField === undefined) throw new ChargingError('unsupported_mode');
  const allowed = ['connectorId', 'vehicleId', 'mode', ...(limitField ? [limitField] : [])];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    ![input.connectorId, input.vehicleId, ...(limitField ? [chargeLimit(input)] : [])].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new ChargingError('invalid_input');
}

export type ModeCreditDecision =
  | { outcome: 'eligible'; reserveVnd: number }
  | { outcome: 'topuprequired' }
  | {
      outcome: 'requiresconfirmation';
      maxEnergyWh?: number;
      maxDurationMinutes?: number;
      maxAmountVnd?: number;
    };

// WP3: limits reserve an upper bound; they never substitute for metered settlement.
export function modeCreditPolicy(
  available: number,
  input: ChargeStartInput,
  price: number,
  powerW: number | null,
  policy: ChargePolicy,
): ModeCreditDecision {
  validateChargeStart(input);
  validateChargePolicy(policy);
  if (!Number.isSafeInteger(available) || !Number.isSafeInteger(price) || price < 0)
    throw new ChargingError('invalid_start_input');
  if (available < policy.minimumStartVnd) return { outcome: 'topuprequired' };
  if (input.mode === 'energy_kwh')
    return startCreditPolicy(available, input.energyLimitWh, price, policy);
  if (input.mode === 'full') return { outcome: 'eligible', reserveVnd: available };
  if (input.mode === 'amount_vnd')
    return input.amountLimitVnd > available
      ? { outcome: 'requiresconfirmation', maxAmountVnd: available }
      : { outcome: 'eligible', reserveVnd: input.amountLimitVnd };
  if (powerW === null || !Number.isSafeInteger(powerW) || powerW <= 0)
    throw new ChargingError('power_unavailable');
  const rate = BigInt(powerW) * BigInt(price);
  const reserve = (rate * BigInt(input.durationMinutes) + 59999n) / 60000n;
  if (reserve > BigInt(available))
    return {
      outcome: 'requiresconfirmation',
      maxDurationMinutes: Number((BigInt(available) * 60000n) / rate),
    };
  return { outcome: 'eligible', reserveVnd: Number(reserve) };
}

// WP3: PostgreSQL numeric values are converted exactly, including fractional Wh.
export function scaledInteger(value: string, scale = 3): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.slice(scale).replace(/0/g, '') ?? '') !== '') return null;
  return (
    BigInt(match[1]!) * 10n ** BigInt(scale) +
    BigInt((match[2] ?? '').slice(0, scale).padEnd(scale, '0') || '0')
  );
}

export type TariffWindow = { id: string; price: string; starts: Date; ends: Date };
export type MeterPoint = { at: Date; milliWh: bigint };
export type MeteredCostBounds = { minVnd: number; maxVnd: number; quality: 'exact' | 'bounded' };

// WP3: a sparse interval is bounded by its actual tariff windows, never allocated by invented power.
export function meteredCostBounds(
  points: MeterPoint[],
  tariffs: TariffWindow[],
): MeteredCostBounds | null {
  if (points.length < 2 || !tariffs.length) return null;
  let low = 0n;
  let high = 0n;
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]!;
    const after = points[i]!;
    const start = before.at.getTime();
    const end = after.at.getTime();
    const delta = after.milliWh - before.milliWh;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || delta < 0n) return null;
    if (start === end && delta === 0n) {
      if (
        !tariffs.some(
          (t) => t.starts.getTime() <= start && t.ends.getTime() > start && /^\d+$/.test(t.price),
        )
      )
        return null;
      continue;
    }
    if (start === end) return null;
    let cursor = start;
    const rates: bigint[] = [];
    for (const tariff of tariffs) {
      const left = Math.max(start, tariff.starts.getTime());
      const right = Math.min(end, tariff.ends.getTime());
      if (right <= left) continue;
      if (left !== cursor || !/^\d+$/.test(tariff.price)) return null;
      rates.push(BigInt(tariff.price));
      cursor = right;
    }
    if (cursor !== end || !rates.length) return null;
    low += delta * rates.reduce((a, b) => (a < b ? a : b));
    high += delta * rates.reduce((a, b) => (a > b ? a : b));
  }
  const min = (low + 500000n) / 1000000n;
  const max = (high + 500000n) / 1000000n;
  if (max > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { minVnd: Number(min), maxVnd: Number(max), quality: low === high ? 'exact' : 'bounded' };
}
