/**
 * BE-22 — đọc ví credit của chính tài xế cho app (UC-PAY-02, màn hình 9 "Charging Credit & Top Up").
 *
 * Chỉ đọc: mọi ghi sổ vẫn đi qua `CreditLedgerService.post` (billing). Số dư là snapshot
 * `credit_accounts.balance_vnd`, vốn bằng Σ `credit_transactions.amount_vnd` (bất biến của sổ cái);
 * `held_vnd` là tiền đang giữ trước cho các start intent còn mở, cùng điều kiện mà
 * `DriverChargingService.start` trừ khi kiểm BR-P18, nên `available_vnd` khớp số app sẽ bị kiểm.
 */
import type { Db } from '../db/db.module.js';
import { DriverApiError } from './driver-auth.js';

/** Tài xế chưa có ví (đăng ký BE-21 không tạo ví) → trả 0 với `status: 'none'`, không tạo ví khi đọc. */
export type DriverCreditStatus = 'active' | 'in_shortfall' | 'closed' | 'none';

export interface DriverCreditSummary {
  balance_vnd: number;
  held_vnd: number;
  available_vnd: number;
  status: DriverCreditStatus;
  updated_at: Date | null;
}

export interface DriverCreditEntry {
  transaction_id: string;
  entry_no: number;
  transaction_type: string;
  amount_vnd: number;
  balance_after_vnd: number;
  session_id: string | null;
  top_up_id: string | null;
  reservation_id: string | null;
  created_at: Date;
}

const MAX_PAGE_SIZE = 100;

function money(raw: string | number | null): number {
  const value = Number(raw ?? 0);
  // Tiền VND trong DB là bigint; vượt MAX_SAFE_INTEGER thì không trả số sai cho app.
  if (!Number.isSafeInteger(value)) throw new Error('credit_amount_out_of_range');
  return value;
}

export async function creditSummary(db: Db, driverId: string): Promise<DriverCreditSummary> {
  const row = (
    await db.$client.query<{
      balance_vnd: string | null;
      status: string | null;
      updated_at: Date | null;
      held_vnd: string;
    }>(
      `SELECT a.balance_vnd,a.status,a.updated_at,
        (SELECT coalesce(sum(i.reserved_vnd),0) FROM driver_charge_intents i
          WHERE i.driver_id=$1 AND i.state NOT IN ('rejected','settled','released')) AS held_vnd
       FROM (SELECT $1::bigint AS driver_id) d LEFT JOIN credit_accounts a ON a.driver_id=d.driver_id`,
      [driverId],
    )
  ).rows[0]!;
  const balance = money(row.balance_vnd);
  const held = money(row.held_vnd);
  return {
    balance_vnd: balance,
    held_vnd: held,
    available_vnd: balance - held,
    status: (row.status ?? 'none') as DriverCreditStatus,
    updated_at: row.updated_at,
  };
}

function pageParam(q: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = q.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) > max)
    throw new DriverApiError(400, 'invalid_input');
  return Number(raw);
}

export async function creditTransactions(
  db: Db,
  driverId: string,
  q: URLSearchParams,
): Promise<{ items: DriverCreditEntry[]; total: number; page: number; page_size: number }> {
  const page = pageParam(q, 'page', 1, 100000);
  const pageSize = pageParam(q, 'page_size', 20, MAX_PAGE_SIZE);
  const rows = (
    await db.$client.query<{
      id: string;
      entry_no: string;
      transaction_type: string;
      amount_vnd: string;
      balance_after_vnd: string;
      session_id: string | null;
      top_up_id: string | null;
      reservation_id: string | null;
      created_at: Date;
      total: string;
    }>(
      `SELECT t.id,t.entry_no,t.transaction_type,t.amount_vnd,t.balance_after_vnd,t.session_id,
        t.top_up_id,t.reservation_id,t.created_at,count(*) OVER () AS total
       FROM credit_transactions t JOIN credit_accounts a ON a.id=t.credit_account_id
       WHERE a.driver_id=$1 ORDER BY t.entry_no DESC LIMIT $2 OFFSET $3`,
      [driverId, pageSize, (page - 1) * pageSize],
    )
  ).rows;
  let total = rows.length ? Number(rows[0]!.total) : 0;
  if (!rows.length && page > 1)
    total = Number(
      (
        await db.$client.query<{ total: string }>(
          `SELECT count(*) AS total FROM credit_transactions t
           JOIN credit_accounts a ON a.id=t.credit_account_id WHERE a.driver_id=$1`,
          [driverId],
        )
      ).rows[0]!.total,
    );
  return {
    items: rows.map((r) => ({
      transaction_id: r.id,
      entry_no: Number(r.entry_no),
      transaction_type: r.transaction_type,
      amount_vnd: money(r.amount_vnd),
      balance_after_vnd: money(r.balance_after_vnd),
      session_id: r.session_id,
      top_up_id: r.top_up_id,
      reservation_id: r.reservation_id,
      created_at: r.created_at,
    })),
    total,
    page,
    page_size: pageSize,
  };
}
