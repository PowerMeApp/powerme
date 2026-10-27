// WP3/T31: thresholds are supplied by composition; no proposed minimum becomes universal policy.
export interface ChargePolicy {
  minimumStartVnd: number;
  cutoffReserveVnd: number;
  pointsExpiryMonths: number;
  commandTimeoutMs: number;
  stationStaleAfterMs: number;
  stationOfflineAfterMs?: number;
}

export function validateChargePolicy(policy: ChargePolicy): void {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_charge_policy');
  }
  if (
    policy.pointsExpiryMonths < 1 ||
    policy.commandTimeoutMs < 1 ||
    (policy.stationOfflineAfterMs !== undefined && policy.stationOfflineAfterMs < 1) ||
    policy.stationStaleAfterMs < 1
  )
    throw new Error('invalid_charge_policy');
}

export function startCreditPolicy(
  availableVnd: number,
  energyLimitWh: number,
  maxPricePerKwhVnd: number,
  policy: ChargePolicy,
):
  | { outcome: 'eligible'; reserveVnd: number }
  | { outcome: 'topuprequired' }
  | { outcome: 'requiresconfirmation'; maxEnergyWh: number } {
  validateChargePolicy(policy);
  if (
    ![availableVnd, energyLimitWh, maxPricePerKwhVnd].every(Number.isSafeInteger) ||
    energyLimitWh <= 0 ||
    maxPricePerKwhVnd < 0
  )
    throw new Error('invalid_start_input');
  if (availableVnd < policy.minimumStartVnd) return { outcome: 'topuprequired' };
  const reserve = (BigInt(energyLimitWh) * BigInt(maxPricePerKwhVnd) + 999n) / 1000n;
  if (reserve > BigInt(availableVnd))
    return {
      outcome: 'requiresconfirmation',
      maxEnergyWh: Number((BigInt(availableVnd) * 1000n) / BigInt(maxPricePerKwhVnd)),
    };
  return { outcome: 'eligible', reserveVnd: Number(reserve) };
}
