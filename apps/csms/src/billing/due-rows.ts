/**
 * Lấy dòng đến hạn bằng "giữ chỗ có hạn" (lease) cho bảng có `next_attempt_at` (decisions D7, T32 Phần 12).
 *
 * Vì sao tồn tại: D7 muốn mỗi dòng xử lý dưới `FOR UPDATE SKIP LOCKED`, nhưng querydr và
 * e-invoice là HTTP ~10 s và không được gọi trong DB transaction (billing/CLAUDE.md). Nên một dòng đi qua:
 *
 *   tx1 (ngắn, `claimDue`): SELECT … FOR UPDATE SKIP LOCKED, đẩy `next_attempt_at = now() + lease`, COMMIT.
 *   ngoài transaction: gọi bên ngoài.
 *   tx2 (bên gọi): `lockLeased` (khoá lại dòng, kiểm lease còn của mình) → state machine → ghi kết quả.
 *
 * Sập giữa chừng thì `next_attempt_at` là hạn lease; hết lease dòng lại đến hạn. Lease không tăng
 * `attempt_count` (state machine ở tx2 đếm lượt gọi bên ngoài đã ra kết quả).
 *
 * Bộ đếm `unfinished_claims` (T32 Phần 8c, 0027): tx1 tăng 1; tx2 khoá lại được bằng lease của mình
 * và COMMIT thì đặt về 0 (tx2 rollback thì phần đặt về 0 cũng rollback). Lần giữ chỗ làm bộ đếm
 * VƯỢT `UNFINISHED_CLAIM_LIMIT` (lần thứ 6 liên tiếp không ra kết quả: `handle` ném, sập, lỗi lặp ở
 * tx2) thì không gọi `handle` mà gọi `spec.onExhausted` của bảng trong một tx ngắn riêng, không gọi
 * bên ngoài. Thiếu bộ đếm thì dòng như vậy quay vòng mãi sau mỗi lease.
 *
 * `leaseToken` = `next_attempt_at` dạng text (giữ đủ µs; JS `Date` chỉ có ms). Runner khác lấy lại dòng
 * sau khi hết lease thì token đổi, `lockLeased` của lượt cũ trả `null` → lượt cũ bỏ kết quả.
 *
 * Mốc thời gian là `now()` của DB. Tên bảng / enum lấy từ map cố định, không nhận SQL từ bên gọi.
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LedgerClient } from './credit-ledger.service.js';

/** Không có `refunds`: hoàn tiền thủ công, không có worker refund (D1). */
export type LeasedTable = 'e_invoices' | 'invoice_adjustments' | 'top_ups';

/** Enum của cột `status` (cast tham số để dùng được index `(status, next_attempt_at)`). */
const STATUS_ENUM: Record<LeasedTable, string> = {
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

/**
 * Số lần giữ chỗ liên tiếp chưa ra kết quả được phép (T32 Phần 8c, Khang 19/11). Lần giữ chỗ làm
 * `unfinished_claims` vượt số này thì không gọi `handle` nữa mà gọi `onExhausted`. Hằng chung, không
 * đọc từ biến môi trường.
 */
export const UNFINISHED_CLAIM_LIMIT = 5;

/**
 * Bộ xử lý hết lượt của một bảng. Chạy trong tx riêng (`tx`) do `runLeasedBatch` mở, sau khi dòng đã
 * được khoá lại bằng lease (`locked` = `SELECT *`, bộ đếm KHÔNG đặt về 0: dòng giữ số lần làm dấu
 * vết cho Admin). Không gọi bên ngoài. Trả về hàm thì hàm đó chạy SAU COMMIT (log, việc sau commit).
 */
export type ExhaustedHandler = (
  locked: Record<string, unknown>,
  tx: PoolClient,
) => Promise<(() => Promise<void>) | void>;

export interface LeaseSpec {
  table: LeasedTable;
  /** Trạng thái được coi là còn việc, vd. `['pending']` cho top-up, `['requested','failed']` cho hoá đơn. */
  statuses: readonly string[];
  leaseMs: number;
  /**
   * Xử lý khi hết lượt giữ chỗ (`unfinished_claims > UNFINISHED_CLAIM_LIMIT`). Cả ba bảng của
   * `LeasedTable` đã có (điều chỉnh hoá đơn: Phần 9b); bảng mới thiếu thì log error
   * rồi vẫn gọi `handle` như trước 8c.
   */
  onExhausted?: ExhaustedHandler;
}

export interface LeasedRow {
  id: number;
  leaseToken: string;
  /** `unfinished_claims` SAU khi tx1 tăng (lần giữ chỗ này đã tính). */
  unfinishedClaims: number;
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
  const { rows } = await tx.query<{ id: string; lease_token: string; unfinished_claims: number }>(
    `WITH due AS (
       SELECT id FROM ${t}
       WHERE ${statusSql} AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${t} AS r
     SET next_attempt_at = now() + $2 * interval '1 millisecond',
         unfinished_claims = r.unfinished_claims + 1, updated_at = now()
     FROM due WHERE r.id = due.id
     RETURNING r.id, r.next_attempt_at::text AS lease_token, r.unfinished_claims`,
    params,
  );
  return rows
    .map((r) => ({
      id: Number(r.id),
      leaseToken: r.lease_token,
      unfinishedClaims: Number(r.unfinished_claims),
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * tx2: khoá lại dòng nếu lease vẫn là của mình và đặt `unfinished_claims = 0` (tx2 COMMIT = lần giữ
 * chỗ này đã ra kết quả; rollback thì bộ đếm giữ nguyên). `null` = lease đã mất (runner khác đã lấy
 * lại sau khi hết hạn, hoặc dòng đã đổi lịch) → bỏ kết quả, không đụng bộ đếm.
 *
 * Khoá bằng CTE `FOR UPDATE` để giữ đúng mức khoá như trước 8c (`UPDATE` trần chỉ lấy `FOR NO KEY
 * UPDATE`). Không đặt `updated_at`: đường tx2 nào ghi kết quả đều tự đặt.
 */
export async function lockLeased<T extends Record<string, unknown> = Record<string, unknown>>(
  tx: LedgerClient,
  table: LeasedTable,
  row: LeasedRow,
): Promise<T | null> {
  if (!(table in STATUS_ENUM)) throw new Error(`due_rows_unknown_table: ${table}`);
  const { rows } = await tx.query<T>(
    `WITH l AS (
       SELECT id FROM ${table} WHERE id = $1 AND next_attempt_at = $2::timestamptz FOR UPDATE
     )
     UPDATE ${table} AS r SET unfinished_claims = 0 FROM l WHERE r.id = l.id
     RETURNING r.*`,
    [row.id, row.leaseToken],
  );
  return rows[0] ?? null;
}

/** Như `lockLeased` nhưng KHÔNG đặt bộ đếm về 0 (đường hết lượt: dòng giữ số lần làm dấu vết). */
async function lockForExhaustion(
  tx: LedgerClient,
  table: LeasedTable,
  row: LeasedRow,
): Promise<Record<string, unknown> | null> {
  const { rows } = await tx.query<Record<string, unknown>>(
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
 * - `row.unfinishedClaims > UNFINISHED_CLAIM_LIMIT`: không gọi `handle`, gọi `exhaust` (tx riêng,
 *   `spec.onExhausted`). Bảng không có `onExhausted` → log error rồi vẫn gọi `handle`.
 */
export async function runLeasedBatch(
  pool: { connect(): Promise<PoolClient> },
  spec: LeaseSpec & { limit: number },
  handle: (row: LeasedRow) => Promise<void>,
  signal: AbortSignal,
  logger: Pick<Logger, 'warn' | 'error'> = defaultLogger,
): Promise<number> {
  check(spec, spec.limit);
  let handled = 0;
  while (handled < spec.limit && !signal.aborted) {
    const row = await claimOne(pool, spec);
    if (!row) break;
    handled++;
    if (row.unfinishedClaims > UNFINISHED_CLAIM_LIMIT) {
      if (spec.onExhausted) {
        await exhaust(pool, spec.table, spec.onExhausted, row, logger);
        continue;
      }
      logger.error(
        JSON.stringify({
          event: 'leased_row_exhausted',
          table: spec.table,
          id: row.id,
          unfinished_claims: row.unfinishedClaims,
          no_handler: true,
        }),
      );
    }
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

/**
 * Đường hết lượt: tx ngắn riêng khoá lại dòng bằng lease (không đặt bộ đếm về 0) → `onExhausted` →
 * COMMIT → việc sau commit nếu có. Không ném: lỗi (kể cả của `onExhausted`) chỉ log error kèm
 * `exhaust_failed: true`; dòng giữ lease và quay lại khi hết lease (không thêm cơ chế lặp).
 */
async function exhaust(
  pool: { connect(): Promise<PoolClient> },
  table: LeasedTable,
  onExhausted: ExhaustedHandler,
  row: LeasedRow,
  logger: Pick<Logger, 'warn' | 'error'>,
): Promise<void> {
  const base = {
    event: 'leased_row_exhausted',
    table,
    id: row.id,
    unfinished_claims: row.unfinishedClaims,
  };
  let after: (() => Promise<void>) | void;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const locked = await lockForExhaustion(c, table, row);
    if (!locked) {
      await c.query('ROLLBACK');
      logger.warn(JSON.stringify({ ...base, lease_lost: true }));
      return;
    }
    after = await onExhausted(locked, c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    logger.error(JSON.stringify({ ...base, exhaust_failed: true, error: String(err) }));
    return;
  } finally {
    c.release();
  }
  logger.error(JSON.stringify(base));
  try {
    if (after) await after();
  } catch (err) {
    // Đã commit: việc sau commit lỗi chỉ log, không đổi kết quả.
    logger.error(JSON.stringify({ ...base, after_commit_failed: true, error: String(err) }));
  }
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
