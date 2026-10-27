import { ChargePolicy, validateChargePolicy } from './charge-start-policy.js';

// WP3/T72: monetary defaults are documented configurable proposals, not a provider policy.
export function loadChargePolicy(env: NodeJS.ProcessEnv = process.env): ChargePolicy {
  const read = (key: string, fallback: number) =>
    env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
  const policy: ChargePolicy = {
    minimumStartVnd: read('CHARGE_MINIMUM_START_VND', 50000),
    cutoffReserveVnd: read('CHARGE_CUTOFF_RESERVE_VND', 10000),
    pointsExpiryMonths: read('CHARGE_POINTS_EXPIRY_MONTHS', 12),
    commandTimeoutMs: read('CHARGE_COMMAND_TIMEOUT_MS', 30000),
    stationStaleAfterMs: read(
      'CHARGE_STATION_STALE_MS',
      read('OCPP_HEARTBEAT_INTERVAL_SECONDS', 300) * 2000,
    ),
    stationOfflineAfterMs: read('OCPP_OFFLINE_THRESHOLD_SECONDS', 900) * 1000,
  };
  validateChargePolicy(policy);
  return policy;
}
