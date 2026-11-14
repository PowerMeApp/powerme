/**
 * Lấy dòng đến hạn bằng "giữ chỗ có hạn" (lease) cho bảng có `next_attempt_at` (decisions D7, T32 Phần 12).
 *
 * Vì sao tồn tại: D7 muốn mỗi dòng xử lý dưới `FOR UPDATE SKIP LOCKED`, nhưng VNPay refund, querydr và
 * e-invoice là HTTP ~10 s và không được gọi trong DB transaction (billing/CLAUDE.md). Nên một dòng đi qua:
 *
 *   tx1 (ngắn, `claimDue`): SELECT … FOR UPDATE SKIP LOCKED, đẩy `next_attempt_at = now() + lease`, COMMIT.
 *   ngoài transaction: gọi bên ngoài.
 *   tx2 (bên gọi): `lockLeased` (khoá lại dòng, kiểm lease còn của mình) → state machine → ghi kết quả.
 *
 * Sập giữa chừng thì `next_attempt_at` là hạn lease; hết lease dòng lại đến hạn. Lease không tăng
 * `attempt_count` (state machine ở tx2 đếm).
 *
 * `leaseToken` = `next_attempt_at` dạng text (giữ đủ µs; JS `Date` chỉ có ms). Runner khác lấy lại dòng
 * sau khi hết lease thì token đổi, `lockLeased` của lượt cũ trả `null` → lượt cũ bỏ kết quả.
 *
 * Mốc thời gian là `now()` của DB. Tên bảng / enum lấy từ map cố định, không nhận SQL từ bên gọi.
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LedgerClient } from './credit-ledger.service.js';

export type LeasedTable = 'refunds' | 'e_invoices' | 'invoice_adjustments' | 'top_ups';

/** Enum của cột `status` (cast tham số để dùng được index `(status, next_attempt_at)`). */
const STATUS_ENUM: Record<LeasedTable, string> = {
  refunds: 'refund_status',
  e_invoices: 'e_invoice_status',
  invoice_adjustments: 'e_invoice_status',
  top_ups: 'top_up_status',
};

/**
 * Điều kiện trạng thái viết HẰNG cho bảng chỉ có partial index (T32 Phần 8): `top_ups_pending_next_attempt_idx`
 * là `(next_attempt_at) WHERE status = 'pending'`; câu `status = ANY($1)` có tham số không khớp được
 * predicate của partial index trong generic plan (EXPLAIN trên powerme_test, 14/11). Bảng có mặt ở đây
 * chỉ nhận đúng `statuses` đã ghi; vẫn không nhận SQL từ bên gọi.
 */
const FIXED_DUE_STATUS: Partial<Record<LeasedTable, { statuses: readonly string[]; sql: string }>> =
  {
    top_ups: { statuses: ['pending'], sql: "status = 'pending'" },
  };

export interface LeaseSpec {
  table: LeasedTable;
  /** Trạng thái được coi là còn việc, vd. `['requested']` cho refund, `['requested','failed']` cho hoá đơn. */
  statuses: readonly string[];
  leaseMs: number;
}

export interface LeasedRow {
  id: number;
  leaseToken: string;
}

function check(spec: LeaseSpec, limit: number): void {
  if (!(spec.table in STATUS_ENUM)) throw new Error(`due_rows_unknown_table: ${spec.table}`);
  if (spec.statuses.length === 0) throw new Error('due_rows_no_status');
  const fixed = FIXED_DUE_STATUS[spec.table];
  if (
    fixed &&
    (spec.statuses.length !== fixed.statuses.length ||
      spec.statuses.some((s, i) => s !== fixed.statuses[i]))
  ) {
    throw new Error(`due_rows_fixed_status: ${spec.table} chỉ nhận [${fixed.statuses.join(',')}]`);
  }
  if (!Number.isSafeInteger(spec.leaseMs) || spec.leaseMs < 1) {
    throw new Error('due_rows_invalid_lease');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('due_rows_invalid_limit');
  }
}

/**
 * Giữ chỗ tối đa `limit` dòng đến hạn. `tx` phải đang trong transaction; khoá dòng giữ tới khi bên
 * gọi COMMIT, sau đó dòng được bảo vệ bằng lease.
 */
export async function claimDue(
  tx: LedgerClient,
  spec: LeaseSpec & { limit: number },
): Promise<LeasedRow[]> {
  check(spec, spec.limit);
  const t = spec.table;
  const fixed = FIXED_DUE_STATUS[t];
  // Bảng có điều kiện hằng không truyền danh sách trạng thái; $n đánh số theo từng nhánh.
  const [statusSql, params] = fixed
    ? [fixed.sql, [spec.limit, spec.leaseMs]]
    : [`status = ANY($3::${STATUS_ENUM[t]}[])`, [spec.limit, spec.leaseMs, spec.statuses]];
  const { rows } = await tx.query<{ id: string; lease_token: string }>(
    `WITH due AS (
       SELECT id FROM ${t}
       WHERE ${statusSql} AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${t} AS r
     SET next_attempt_at = now() + $2 * interval '1 millisecond', updated_at = now()
     FROM due WHERE r.id = due.id
     RETURNING r.id, r.next_attempt_at::text AS lease_token`,
    params,
  );
  return rows
    .map((r) => ({ id: Number(r.id), leaseToken: r.lease_token }))
    .sort((a, b) => a.id - b.id);
}

/**
 * tx2: khoá lại dòng nếu lease vẫn là của mình. `null` = lease đã mất (runner khác đã lấy lại sau khi
 * hết hạn, hoặc dòng đã đổi lịch) → bỏ kết quả.
 */
export async function lockLeased<T extends Record<string, unknown> = Record<string, unknown>>(
  tx: LedgerClient,
  table: LeasedTable,
  row: LeasedRow,
): Promise<T | null> {
  if (!(table in STATUS_ENUM)) throw new Error(`due_rows_unknown_table: ${table}`);
  const { rows } = await tx.query<T>(
    `SELECT * FROM ${table} WHERE id = $1 AND next_attempt_at = $2::timestamptz FOR UPDATE`,
    [row.id, row.leaseToken],
  );
  return rows[0] ?? null;
}

const defaultLogger = new Logger('LeasedBatch');

/**
 * Xử lý tối đa `limit` dòng, **mỗi lần giữ chỗ một dòng** (lô giữ chỗ cùng lúc thì dòng cuối có thể hết
 * lease trước khi tới lượt). `handle` gọi bên ngoài rồi tự mở tx2 với `lockLeased`.
 *
 * - `signal.aborted` kiểm trước mỗi lần giữ chỗ: shutdown chỉ chờ xong dòng đang làm.
 * - `handle` ném: log warn, sang dòng kế. Dòng lỗi giữ nguyên lease, hết lease thì quay lại; vẫn tính vào
 *   số trả về để lô toàn dòng lỗi không làm runner lặp mãi.
 */
export async function runLeasedBatch(
  pool: { connect(): Promise<PoolClient> },
  spec: LeaseSpec & { limit: number },
  handle: (row: LeasedRow) => Promise<void>,
  signal: AbortSignal,
  logger: Pick<Logger, 'warn'> = defaultLogger,
): Promise<number> {
  check(spec, spec.limit);
  let handled = 0;
  while (handled < spec.limit && !signal.aborted) {
    const row = await claimOne(pool, spec);
    if (!row) break;
    handled++;
    try {
      await handle(row);
    } catch (err) {
      logger.warn(
        `D7 ${spec.table}#${row.id} failed; lease kept until ${row.leaseToken}, row will be retried: ${String(err)}`,
      );
    }
  }
  return handled;
}

async function claimOne(
  pool: { connect(): Promise<PoolClient> },
  spec: LeaseSpec,
): Promise<LeasedRow | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const [row] = await claimDue(c, { ...spec, limit: 1 });
    await c.query('COMMIT');
    return row ?? null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
