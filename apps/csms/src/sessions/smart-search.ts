export interface SmartSearchConfig {
  range_factor: number;
  road_factor: number;
  reserve_km: number;
  avg_speed_kmh: number;
  charge_efficiency: number;
  available_wait_min: number;
  freeing_soon_wait_min: number;
  in_use_wait_min: number;
  radius_factor: number;
  fallback_limit: number;
}

export const DEFAULT_SMART_SEARCH: Readonly<SmartSearchConfig> = Object.freeze({
  range_factor: 0.75,
  road_factor: 1.3,
  reserve_km: 10,
  avg_speed_kmh: 30,
  charge_efficiency: 0.85,
  available_wait_min: 0,
  freeing_soon_wait_min: 5,
  in_use_wait_min: 30,
  radius_factor: 1.5,
  fallback_limit: 3,
});

export function loadSmartSearchConfig(env: NodeJS.ProcessEnv): SmartSearchConfig {
  const result = { ...DEFAULT_SMART_SEARCH };
  const bounds: Record<keyof SmartSearchConfig, [number, number]> = {
    range_factor: [0.001, 1],
    road_factor: [1, 10],
    reserve_km: [0, 20040],
    avg_speed_kmh: [0.1, 300],
    charge_efficiency: [0.001, 1],
    available_wait_min: [0, 10080],
    freeing_soon_wait_min: [0, 10080],
    in_use_wait_min: [0, 10080],
    radius_factor: [0.1, 10],
    fallback_limit: [1, 100],
  };
  for (const key of Object.keys(result) as (keyof SmartSearchConfig)[]) {
    const name = `SMART_SEARCH_${key.toUpperCase()}`;
    const value = env[name] === undefined || env[name] === '' ? result[key] : Number(env[name]);
    if (
      !Number.isFinite(value) ||
      value < bounds[key][0] ||
      value > bounds[key][1] ||
      (key === 'fallback_limit' && !Number.isSafeInteger(value))
    )
      throw new Error(`Invalid ${name}`);
    result[key] = value;
  }
  return result;
}

export interface SmartFields {
  reach: 'ok' | 'tight' | 'risky' | null;
  best_connector_id: string | null;
  est_drive_min: number | null;
  est_wait_min: number | null;
  est_charge_min: number | null;
  est_total_min: number | null;
  est_energy_kwh: number | null;
  est_cost_vnd_max: number | null;
}

export const EMPTY_SMART_FIELDS: Readonly<SmartFields> = Object.freeze({
  reach: null,
  best_connector_id: null,
  est_drive_min: null,
  est_wait_min: null,
  est_charge_min: null,
  est_total_min: null,
  est_energy_kwh: null,
  est_cost_vnd_max: null,
});
