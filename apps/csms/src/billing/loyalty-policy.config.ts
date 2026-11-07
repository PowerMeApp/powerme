/**
 * Cấu hình loyalty của billing.
 *
 * Hạn điểm `earn` đọc **cùng biến** `CHARGE_POINTS_EXPIRY_MONTHS` mà WP3 dùng
 * (`sessions/charge-policy.config.ts`), để khi `charge-settlement` chuyển sang
 * `LoyaltyService.earnForSession` (D9) thì hạn điểm không đổi. Không import từ `sessions/`
 * (ranh giới module).
 */
export const LOYALTY_POLICY = Symbol('BILLING_LOYALTY_POLICY');

export interface LoyaltyPolicy {
  /** Số tháng từ lúc earn tới lúc điểm hết hạn. */
  pointsExpiryMonths: number;
}

export function loadLoyaltyPolicy(env: NodeJS.ProcessEnv = process.env): LoyaltyPolicy {
  const raw = env['CHARGE_POINTS_EXPIRY_MONTHS'];
  const months = raw === undefined || raw === '' ? 12 : Number(raw);
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new Error('invalid_loyalty_policy: CHARGE_POINTS_EXPIRY_MONTHS phải là số nguyên ≥ 1');
  }
  return { pointsExpiryMonths: months };
}
