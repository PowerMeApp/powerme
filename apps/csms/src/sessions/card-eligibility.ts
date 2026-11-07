import { sql } from 'drizzle-orm';
import type { DbExecutor } from '../db/db.module.js';
import { ChargePolicy, meetsStartMinimum } from './charge-start-policy.js';

/**
 * BE-19 (G8): quy tắc BR-P23 + BR-P18 cho thẻ RFID `online` đã `active`.
 * Thẻ phải gắn một tài xế đang hoạt động, tài xế có ví Charging Credit còn hoạt động và số dư khả
 * dụng (trừ phần giữ chỗ của các intent app đang mở, cùng cách `authorizeAppTag` tính) >= mức
 * tối thiểu để bắt đầu (`ChargePolicy.minimumStartVnd`).
 */
export type CardDenyReason =
  | 'no_driver' // thẻ chưa gắn tài xế (BR-P23)                 -> Invalid
  | 'no_credit_account' // tài xế chưa có ví                     -> Invalid
  | 'driver_inactive' // tài khoản tài xế bị khoá/vô hiệu         -> Blocked
  | 'credit_closed' // ví Charging Credit đã đóng               -> Blocked
  | 'credit_in_shortfall' // ví đang âm sau phiên trước (BR-P18..P23) -> Blocked
  | 'below_start_minimum'; // số dư khả dụng < mức tối thiểu (BR-P18) -> Blocked

export type CardEligibility =
  | { eligible: true; driverId: number }
  | {
      eligible: false;
      reason: CardDenyReason;
      status: 'Invalid' | 'Blocked';
      driverId: number | null;
    };

const STATUS_BY_REASON: Record<CardDenyReason, 'Invalid' | 'Blocked'> = {
  no_driver: 'Invalid',
  no_credit_account: 'Invalid',
  driver_inactive: 'Blocked',
  credit_closed: 'Blocked',
  credit_in_shortfall: 'Blocked',
  below_start_minimum: 'Blocked',
};

export async function evaluateOnlineCard(
  ex: DbExecutor,
  driverId: number | null,
  policy: ChargePolicy,
): Promise<CardEligibility> {
  const deny = (reason: CardDenyReason): CardEligibility => ({
    eligible: false,
    reason,
    status: STATUS_BY_REASON[reason],
    driverId,
  });
  if (driverId === null) return deny('no_driver');
  const res = await ex.execute<{
    account_status: string | null;
    credit_status: string | null;
    available_vnd: string | null;
  }>(sql`SELECT u.account_status::text AS account_status, a.status::text AS credit_status,
      a.balance_vnd - coalesce((SELECT sum(i.reserved_vnd) FROM driver_charge_intents i
        WHERE i.driver_id = ${driverId} AND i.state NOT IN ('rejected','settled','released')),0)
        AS available_vnd
    FROM users u LEFT JOIN credit_accounts a ON a.driver_id = u.id
    WHERE u.id = ${driverId} AND u.role = 'driver'`);
  const row = res.rows[0];
  if (!row) return deny('no_driver');
  if (row.account_status !== 'active') return deny('driver_inactive');
  if (row.credit_status === null) return deny('no_credit_account');
  if (row.credit_status === 'in_shortfall') return deny('credit_in_shortfall');
  if (row.credit_status !== 'active') return deny('credit_closed');
  if (!meetsStartMinimum(Number(row.available_vnd), policy)) return deny('below_start_minimum');
  return { eligible: true, driverId };
}

/**
 * StartTransaction không bao giờ bị từ chối (BR-P06), nhưng chỉ gán nợ cho tài xế khi khoản đó còn
 * thu được: ví thiếu tiền / đang âm vẫn billable (BR-P18..P23 cho số dư âm sau phiên offline);
 * thẻ chưa gắn tài xế, tài xế bị khoá, ví đóng hay chưa có ví thì không.
 */
export function isBillableWhenDenied(reason: CardDenyReason): boolean {
  return reason === 'below_start_minimum' || reason === 'credit_in_shortfall';
}
