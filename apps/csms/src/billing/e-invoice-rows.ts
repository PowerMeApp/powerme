/**
 * Ghi kết quả STM-7 dùng chung cho `e_invoices` (worker `e-invoice-issue`, T32 Phần 7) và
 * `invoice_adjustments` (worker `invoice-adjustment-issue`, T32 Phần 9b), decisions D5 / D7.
 *
 * Vì sao tồn tại: hai bảng cùng enum `e_invoice_status`, cùng STM-7, cùng lịch retry, cùng đường hết
 * lượt giữ chỗ (8c) và Admin retry. Rút ra từ `EInvoiceService` (Phần 9b, không đổi hành vi của
 * `e-invoice-issue`: cùng câu SQL, cùng thứ tự chuyển, cùng tên log và trường log) để worker điều
 * chỉnh không phải chép lại.
 *
 * Tên bảng / cột lấy từ map cố định `ISSUE_TABLES`, không nhận SQL từ bên gọi. Mọi hàm chạy trong
 * transaction của bên gọi, không tự BEGIN/COMMIT, không gọi bên ngoài.
 */
import type { LedgerClient } from './credit-ledger.service.js';
import { EInvoiceStateMachine, EInvoiceStatus } from './e-invoice-state-machine.js';
import { RETRY_LIMIT } from './refund-state-machine.js';
import { nextRetry } from './retry-schedule.js';

/** `BackgroundWork.name` của việc xuất hoá đơn (D7). */
export const E_INVOICE_ISSUE_WORK = 'e-invoice-issue';

/** `BackgroundWork.name` của việc gửi điều chỉnh hoá đơn (D7, T32 Phần 9b). */
export const INVOICE_ADJUSTMENT_ISSUE_WORK = 'invoice-adjustment-issue';

/** `last_error_message` cắt còn chừng này ký tự (thông điệp của nhà cung cấp có thể dài). */
export const LAST_ERROR_MESSAGE_MAX = 500;

export type IssueTable = 'e_invoices' | 'invoice_adjustments';

interface IssueTableSpec {
  /** Cột số do nhà cung cấp cấp. */
  noColumn: string;
  /** Tên trường số trong log khi `issued`. */
  noField: string;
  /** Tiền tố tên log (`<event>_issued`, `<event>_needs_review`, …). */
  event: string;
  /** Tên trường id trong log. */
  idField: string;
  /** Tên trường id của dòng cha trong log (`top_up_id` / `e_invoice_id`). */
  parentField: string;
  /** Lỗi `nextRetry` hết lịch khi STM-7 còn đòi hẹn (không xảy ra nếu RETRY_LIMIT khớp lịch). */
  scheduleMismatch: string;
}

const ISSUE_TABLES: Record<IssueTable, IssueTableSpec> = {
  e_invoices: {
    noColumn: 'invoice_no',
    noField: 'invoice_no',
    event: 'e_invoice',
    idField: 'e_invoice_id',
    parentField: 'top_up_id',
    scheduleMismatch: 'e_invoice_retry_schedule_mismatch',
  },
  invoice_adjustments: {
    noColumn: 'provider_adjustment_no',
    noField: 'provider_adjustment_no',
    event: 'invoice_adjustment',
    idField: 'invoice_adjustment_id',
    parentField: 'e_invoice_id',
    scheduleMismatch: 'invoice_adjustment_retry_schedule_mismatch',
  },
};

/** Dòng đã khoá (`lockLeased` / `SELECT … FOR UPDATE`): đủ cột để áp STM-7 và log. */
export interface LockedIssueRow {
  id: string;
  status: EInvoiceStatus;
  attempt_count: number;
  /** `top_up_id` (e_invoices) hoặc `e_invoice_id` (invoice_adjustments); chỉ để log. */
  parentId: number;
  unfinished_claims?: number;
}

/** Kết quả một lượt gọi nhà cung cấp, đã phân loại; `no` = số nhà cung cấp cấp. */
export type IssueOutcome =
  | { kind: 'issued'; no: string }
  | { kind: 'transient'; message: string }
  | { kind: 'data'; message: string };

/** Log ghi SAU commit (kết quả bị rollback không được log). */
export type IssueLog = {
  level: 'log' | 'warn' | 'error';
  event: string;
  fields: Record<string, unknown>;
};

const stm = new EInvoiceStateMachine();

/** #6: dòng `failed` đến hạn → `requested` trước khi áp kết quả lượt vừa gọi. */
function fromStatus(status: EInvoiceStatus): EInvoiceStatus {
  return status === 'failed' ? stm.apply('failed', 'RETRY_DUE').to : status;
}

/** tx2: áp kết quả một lượt gọi lên dòng đã khoá theo lease, ghi MỘT câu UPDATE. */
export async function applyIssueOutcome(
  c: LedgerClient,
  table: IssueTable,
  locked: LockedIssueRow,
  result: IssueOutcome,
): Promise<IssueLog> {
  const t = ISSUE_TABLES[table];
  const id = Number(locked.id);
  const from = fromStatus(locked.status);
  const attemptCount = Number(locked.attempt_count) + 1;
  const base = {
    [t.idField]: id,
    [t.parentField]: locked.parentId,
    attempt_count: attemptCount,
  };

  if (result.kind === 'issued') {
    const step = stm.apply(from, 'PROVIDER_ISSUED');
    await c.query(
      `UPDATE ${table} SET status = $2::e_invoice_status, ${t.noColumn} = $3, issued_at = now(),
         next_attempt_at = NULL, attempt_count = $4, last_attempt_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, step.to, result.no, attemptCount],
    );
    return {
      level: 'log',
      event: `${t.event}_issued`,
      fields: { ...base, [t.noField]: result.no },
    };
  }

  const step = stm.apply(from, 'ATTEMPT_FAILED', { errorKind: result.kind, attemptCount });
  const message = result.message.slice(0, LAST_ERROR_MESSAGE_MAX);
  let delayMs: number | null = null;
  if (step.retry) {
    const r = nextRetry(attemptCount);
    if (r.exhausted) throw new Error(t.scheduleMismatch);
    delayMs = r.delayMs;
  }
  const updated = (
    await c.query<{ next_attempt_at: string | null }>(
      `UPDATE ${table} SET status = $2::e_invoice_status, attempt_count = $3,
         last_error_kind = $4::e_invoice_error_kind, last_error_message = $5,
         last_attempt_at = now(),
         next_attempt_at = CASE WHEN $6::bigint IS NULL THEN NULL
                                ELSE now() + $6::bigint * interval '1 millisecond' END,
         updated_at = now()
       WHERE id = $1
       RETURNING next_attempt_at::text AS next_attempt_at`,
      [id, step.to, attemptCount, result.kind, message, delayMs],
    )
  ).rows[0]!;
  const fields = { ...base, last_error_kind: result.kind, last_error_message: message };
  return step.to === 'needs_review'
    ? { level: 'error', event: `${t.event}_needs_review`, fields }
    : {
        level: 'warn',
        event: `${t.event}_attempt_failed`,
        fields: { ...fields, next_attempt_at: updated.next_attempt_at },
      };
}

/**
 * Hết lượt giữ chỗ (T32 Phần 8c, D7): chạy trong tx riêng của `runLeasedBatch`, dòng đã khoá bằng
 * lease, KHÔNG gọi nhà cung cấp. Chỉ dùng chuyển trạng thái có sẵn của STM-7: `failed` qua #6
 * trước, rồi `ATTEMPT_FAILED` → #3→#5 `needs_review`. Guard và `attempt_count` ghi vào dòng là
 * `max(attempt_count + 1, RETRY_LIMIT)` (Khang chốt 19/11). Trả log để bên gọi ghi sau commit.
 */
export async function exhaustIssueRow(
  c: LedgerClient,
  table: IssueTable,
  locked: LockedIssueRow,
): Promise<IssueLog> {
  const t = ISSUE_TABLES[table];
  const id = Number(locked.id);
  const from = fromStatus(locked.status);
  const attemptCount = Math.max(Number(locked.attempt_count) + 1, RETRY_LIMIT);
  const step = stm.apply(from, 'ATTEMPT_FAILED', { errorKind: 'transient', attemptCount });
  await c.query(
    `UPDATE ${table} SET status = $2::e_invoice_status, attempt_count = $3,
       last_error_kind = 'transient', last_error_message = 'unfinished_claims_exhausted',
       last_attempt_at = now(), next_attempt_at = NULL, updated_at = now()
     WHERE id = $1`,
    [id, step.to, attemptCount],
  );
  return {
    level: 'error',
    event: `${t.event}_needs_review`,
    fields: {
      [t.idField]: id,
      [t.parentField]: locked.parentId,
      attempt_count: attemptCount,
      reason: 'unfinished_claims_exhausted',
      unfinished_claims: locked.unfinished_claims ?? null,
    },
  };
}

/**
 * Admin retry (STM-7 #7) trên dòng đã khoá `FOR UPDATE`: chỉ `needs_review` → `requested`, đến hạn
 * ngay, GIỮ `attempt_count`, `unfinished_claims = 0`. Trạng thái khác → `InvalidTransition`.
 */
export async function adminRetryIssueRow(
  c: LedgerClient,
  table: IssueTable,
  locked: Pick<LockedIssueRow, 'id' | 'status'>,
): Promise<EInvoiceStatus> {
  const step = stm.apply(locked.status, 'ADMIN_RETRY');
  await c.query(
    `UPDATE ${table} SET status = $2::e_invoice_status, next_attempt_at = now(),
       unfinished_claims = 0, updated_at = now() WHERE id = $1`,
    [Number(locked.id), step.to],
  );
  return step.to;
}
