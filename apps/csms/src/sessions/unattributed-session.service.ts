/**
 * UnattributedSessionService (BE-24, F-12, FR-13, UC-OPS-05) — operator gán hoặc đóng một phiên
 * `payment_mode = unattributed` (thẻ lạ, thẻ không Accepted, thẻ online thiếu tài xế/ví, free vend,
 * app tag dùng lại — xem SessionsService.classifyIdTag). Chi tiết: docs/BE-24-UNATTRIBUTED.md.
 *
 * Điều kiện chung: phiên đã có StopTransaction (`received_stopped_at` khác null, trạng thái
 * closed/review/reconciled) — trước đó chưa biết năng lượng cuối nên chưa có gì để quyết định.
 * Quyền: operator_staff đang hoạt động của operator sở hữu trụ (lockOperatorSession, dùng chung
 * với SessionReviewService); phiên của operator khác → not_found.
 *
 * - `assign`: gán cho một tài xế đang hoạt động có Charging Credit chưa đóng → `driver_id` + đổi
 *   `payment_mode` thành `csms_billed`, rồi gọi ChargeSettlementService.settle() có sẵn (sau
 *   commit). Từ chối phiên free vend (BR-P08/ADR-0012: free vend không có người trả, không bao giờ
 *   trừ tiền) và phiên của thẻ không phải `online` (thẻ ví — tiền đã thu ở trụ, BR-P08 cấm trừ hai
 *   lần). Đây là ngoại lệ DUY NHẤT của "payment_mode quyết một lần lúc bắt đầu" (BR-P08) và luôn có
 *   dấu vết — câu hỏi sửa câu chữ BR-P08 ghi trong tài liệu.
 * - `close`: giữ `unattributed`, không tính tiền; chỉ ghi quyết định + lý do.
 *
 * Dấu vết (không cần migration): một dòng `session_status_history` (append-only theo trigger 0001)
 * với event `UNATTRIBUTED_ASSIGNED` / `UNATTRIBUTED_CLOSED`, from = to = trạng thái hiện tại (không
 * phải chuyển STM-1), actor = users.id operator, note = quyết định + ghi chú, occurred_at = giờ
 * CSMS. Thêm vào đó các `reconciliation_records` `unknown_id_tag` chưa duyệt của phiên được đóng
 * (reviewed_by/reviewed_at + resolution) để hàng đợi đối soát cũng hết mục. Phiên free vend không
 * có record nào nên dòng history là dấu vết bắt buộc; nó cũng không phụ thuộc công tắc ablation
 * RECONCILIATION_ENABLED (ReconciliationService không ghi record khi tắt).
 *
 * Idempotent: dòng sessions bị khoá FOR UPDATE; gọi lại cùng quyết định (assign cùng tài xế, hoặc
 * close lần hai) trả kết quả cũ với `already_resolved = true`, không thêm dấu vết; quyết định
 * khác với quyết định đã có → `already_resolved` (409).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DB, Db } from '../db/db.module.js';
import { ChargeSettlementService } from './charge-settlement.service.js';
import { chargeTransaction } from './charge-sql.js';
import { lockOperatorSession } from './operator-session-access.js';

export type UnattributedErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'not_unattributed'
  | 'session_not_stopped'
  | 'free_vend_not_billable'
  | 'wallet_card_not_billable'
  | 'driver_not_eligible'
  | 'already_resolved';

export class UnattributedSessionError extends Error {
  constructor(readonly code: UnattributedErrorCode) {
    super(code);
    this.name = 'UnattributedSessionError';
  }
}

/** Event của dòng session_status_history ghi quyết định (không phải event STM-1). */
export const UNATTRIBUTED_ASSIGNED = 'UNATTRIBUTED_ASSIGNED';
export const UNATTRIBUTED_CLOSED = 'UNATTRIBUTED_CLOSED';

type Settlement = 'posted' | 'already_posted' | 'pending' | 'ineligible';

export interface AssignResult {
  sessionId: number;
  decision: 'assigned';
  driverId: number;
  paymentMode: 'csms_billed';
  /** true nếu phiên đã được gán đúng tài xế này từ trước (gọi lại). */
  alreadyResolved: boolean;
  recordsReviewed: number;
  settlement: Settlement;
}

export interface CloseResult {
  sessionId: number;
  decision: 'closed';
  reason: string;
  paymentMode: 'unattributed';
  alreadyResolved: boolean;
  recordsReviewed: number;
}

export interface UnattributedQueueItem {
  session_id: number;
  transaction_no: number;
  station: string;
  connector_no: number;
  id_tag: string;
  origin: string;
  status: string;
  energy_wh: number | null;
  delivered_offline: boolean;
  stopped_at: string;
  operator_id: number;
  /** null nếu gán được; nếu không, mã lỗi assign sẽ trả (chỉ còn đóng). */
  not_assignable_reason: 'free_vend_not_billable' | 'wallet_card_not_billable' | null;
  /** Các bản ghi unknown_id_tag chưa duyệt (lý do phiên không gán được lúc bắt đầu). */
  open_records: string[];
}

/** Trạng thái STM-1 có StopTransaction đã tới (đi qua #9–#12). */
const STOPPED_STATUSES = ['closed', 'review', 'reconciled'];

/**
 * Vì sao phiên không gán được cho tài xế (null = gán được). So sánh `card_kind::text` thay vì giá trị
 * enum để câu lệnh vẫn chạy nếu enum rfid_card_kind đổi (T110 dự kiến bỏ `wallet`).
 */
const NOT_ASSIGNABLE_SQL = `CASE WHEN s.origin='free_vend' THEN 'free_vend_not_billable'
  WHEN rc.id IS NOT NULL AND rc.card_kind::text <> 'online' THEN
    CASE WHEN rc.card_kind::text='free_vend' THEN 'free_vend_not_billable' ELSE 'wallet_card_not_billable' END
  END`;

const DECISION_EVENTS = [UNATTRIBUTED_ASSIGNED, UNATTRIBUTED_CLOSED];

@Injectable()
export class UnattributedSessionService {
  private readonly logger = new Logger(UnattributedSessionService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settlement: ChargeSettlementService,
  ) {}

  /** Gán phiên unattributed đã đóng cho tài xế `driverId` rồi quyết toán bằng đường có sẵn. */
  async assign(
    sessionId: number,
    operatorUserId: number,
    driverId: number,
    note: string,
  ): Promise<AssignResult> {
    if (
      ![sessionId, operatorUserId, driverId].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !validNote(note)
    )
      throw new UnattributedSessionError('invalid_input');
    const text = note.trim();

    const outcome = await chargeTransaction(this.db, async (c) => {
      const lock = await lockOperatorSession(c, sessionId, operatorUserId);
      if (!lock.ok) throw new UnattributedSessionError(lock.code);
      const { session } = lock;
      const prior = await this.priorDecision(c, sessionId);
      if (prior?.event === UNATTRIBUTED_ASSIGNED) {
        if (session.driver_id !== null && Number(session.driver_id) === driverId)
          return { alreadyResolved: true, recordsReviewed: 0 };
        throw new UnattributedSessionError('already_resolved');
      }
      if (prior) throw new UnattributedSessionError('already_resolved');
      this.checkOpenDecision(session);
      const blocker = (
        await c.query<{ reason: UnattributedErrorCode | null }>(
          `SELECT ${NOT_ASSIGNABLE_SQL} AS reason FROM sessions s
           LEFT JOIN rfid_cards rc ON rc.id=s.rfid_card_id WHERE s.id=$1`,
          [sessionId],
        )
      ).rows[0]!.reason;
      if (blocker) throw new UnattributedSessionError(blocker);
      // Tài xế đang hoạt động, có Charging Credit chưa đóng (settle() trừ vào đó; ví đóng vi phạm
      // credit_accounts_closed_check — G15). Số dư thấp vẫn được: BR-P20 cho âm sau phiên.
      const driver = (
        await c.query(
          `SELECT 1 FROM drivers d JOIN users u ON u.id=d.user_id
           JOIN credit_accounts ca ON ca.driver_id=d.user_id
           WHERE d.user_id=$1 AND u.role='driver' AND u.account_status='active'
             AND ca.status<>'closed'`,
          [driverId],
        )
      ).rowCount;
      if (!driver) throw new UnattributedSessionError('driver_not_eligible');

      await c.query(
        `UPDATE sessions SET driver_id=$2,payment_mode='csms_billed',updated_at=now() WHERE id=$1`,
        [sessionId, driverId],
      );
      await this.trace(
        c,
        sessionId,
        session.status,
        UNATTRIBUTED_ASSIGNED,
        operatorUserId,
        `driver=${driverId}: ${text}`,
      );
      const recordsReviewed = await this.reviewRecords(
        c,
        sessionId,
        operatorUserId,
        `operator_assigned(driver=${driverId}): ${text}`,
      );
      // Job quyết toán bền: trigger 0005 chỉ xếp lại khi status/received_stopped_at đổi, và job
      // của phiên unattributed thường đã `ineligible` — mở lại để retryPending() thử tiếp nếu
      // settle() trả pending (vd phiên còn `review`, thiếu biểu giá).
      await c.query(
        `INSERT INTO charge_settlement_jobs(session_id,reason) VALUES($1,'operator_assigned')
         ON CONFLICT(session_id) DO UPDATE SET state='pending',reason='operator_assigned',
           next_attempt_at=now(),updated_at=now()
         WHERE charge_settlement_jobs.state<>'posted'`,
        [sessionId],
      );
      return { alreadyResolved: false, recordsReviewed };
    });

    if (!outcome.alreadyResolved)
      this.logger.log(
        JSON.stringify({ event: 'unattributed_assigned', sessionId, operatorUserId, driverId }),
      );
    // Sau commit, transaction riêng; settle() idempotent theo session_id nên gọi lại an toàn.
    const settlement = await this.settlement.settle(sessionId);
    return {
      sessionId,
      decision: 'assigned',
      driverId,
      paymentMode: 'csms_billed',
      alreadyResolved: outcome.alreadyResolved,
      recordsReviewed: outcome.recordsReviewed,
      settlement,
    };
  }

  /**
   * Đóng phiên unattributed: giữ không tính tiền.
   * @param reason mã ngắn (a-z, 0-9, _; ≤ 40), vd `free_vend_ok`, `test_session`, `owner_unknown`.
   */
  async close(
    sessionId: number,
    operatorUserId: number,
    reason: string,
    note: string,
  ): Promise<CloseResult> {
    if (
      ![sessionId, operatorUserId].every((n) => Number.isSafeInteger(n) && n > 0) ||
      typeof reason !== 'string' ||
      !/^[a-z0-9_]{1,40}$/.test(reason) ||
      !validNote(note)
    )
      throw new UnattributedSessionError('invalid_input');
    const text = note.trim();

    const outcome = await chargeTransaction(this.db, async (c) => {
      const lock = await lockOperatorSession(c, sessionId, operatorUserId);
      if (!lock.ok) throw new UnattributedSessionError(lock.code);
      const { session } = lock;
      const prior = await this.priorDecision(c, sessionId);
      if (prior?.event === UNATTRIBUTED_CLOSED)
        return {
          alreadyResolved: true,
          recordsReviewed: 0,
          reason: (prior.note ?? '').split(':')[0] ?? reason,
        };
      if (prior) throw new UnattributedSessionError('already_resolved');
      this.checkOpenDecision(session);
      await this.trace(
        c,
        sessionId,
        session.status,
        UNATTRIBUTED_CLOSED,
        operatorUserId,
        `${reason}: ${text}`,
      );
      const recordsReviewed = await this.reviewRecords(
        c,
        sessionId,
        operatorUserId,
        `operator_closed(${reason}): ${text}`,
      );
      return { alreadyResolved: false, recordsReviewed, reason };
    });

    if (!outcome.alreadyResolved)
      this.logger.log(
        JSON.stringify({ event: 'unattributed_closed', sessionId, operatorUserId, reason }),
      );
    return {
      sessionId,
      decision: 'closed',
      reason: outcome.reason,
      paymentMode: 'unattributed',
      alreadyResolved: outcome.alreadyResolved,
      recordsReviewed: outcome.recordsReviewed,
    };
  }

  /**
   * Hàng đợi cho console: phiên unattributed đã đóng, chưa có quyết định (mới nhất trước). Chưa lọc
   * theo operator — console chưa có đăng nhập (cùng mức GET /api/admin/sessions); mỗi dòng mang
   * `operator_id`. Quyền chỉ kiểm khi GHI (assign/close).
   */
  async listPending(limit: number): Promise<UnattributedQueueItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new UnattributedSessionError('invalid_input');
    const { rows } = await this.db.$client.query<{
      id: string;
      transaction_no: number;
      serial_number: string;
      connector_no: number;
      id_tag: string;
      origin: string;
      status: string;
      energy_wh: string | null;
      delivered_offline: boolean;
      received_stopped_at: Date;
      operator_id: string;
      not_assignable_reason: UnattributedQueueItem['not_assignable_reason'];
      open_records: (string | null)[];
    }>(
      `SELECT s.id,s.transaction_no,cp.serial_number,s.connector_no,s.id_tag,s.origin,s.status,
         s.energy_wh,s.delivered_offline,s.received_stopped_at,st.operator_id,
         ${NOT_ASSIGNABLE_SQL} AS not_assignable_reason,
         coalesce((SELECT array_agg(r.resolution ORDER BY r.record_no) FROM reconciliation_records r
           WHERE r.session_id=s.id AND r.reviewed_at IS NULL AND r.record_type='unknown_id_tag'),'{}')
           AS open_records
       FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id JOIN sites st ON st.id=cp.site_id
       LEFT JOIN rfid_cards rc ON rc.id=s.rfid_card_id
       WHERE s.payment_mode='unattributed' AND s.received_stopped_at IS NOT NULL
         AND s.status = ANY($2::session_status[])
         AND NOT EXISTS (SELECT 1 FROM session_status_history h
           WHERE h.session_id=s.id AND h.event = ANY($3::text[]))
       ORDER BY s.received_stopped_at DESC,s.id DESC LIMIT $1`,
      [limit, STOPPED_STATUSES, DECISION_EVENTS],
    );
    return rows.map((r) => ({
      session_id: Number(r.id),
      transaction_no: r.transaction_no,
      station: r.serial_number,
      connector_no: r.connector_no,
      id_tag: r.id_tag,
      origin: r.origin,
      status: r.status,
      energy_wh: r.energy_wh === null ? null : Number(r.energy_wh),
      delivered_offline: r.delivered_offline,
      stopped_at: r.received_stopped_at.toISOString(),
      operator_id: Number(r.operator_id),
      not_assignable_reason: r.not_assignable_reason,
      open_records: r.open_records.filter((x): x is string => x !== null),
    }));
  }

  /** Phiên phải còn unattributed và đã có StopTransaction. */
  private checkOpenDecision(session: {
    payment_mode: string;
    status: string;
    received_stopped_at: Date | null;
  }): void {
    if (session.payment_mode !== 'unattributed')
      throw new UnattributedSessionError('not_unattributed');
    if (session.received_stopped_at === null || !STOPPED_STATUSES.includes(session.status))
      throw new UnattributedSessionError('session_not_stopped');
  }

  private async priorDecision(
    c: PoolClient,
    sessionId: number,
  ): Promise<{ event: string; note: string | null } | undefined> {
    return (
      await c.query<{ event: string; note: string | null }>(
        `SELECT event,note FROM session_status_history
         WHERE session_id=$1 AND event = ANY($2::text[]) ORDER BY id DESC LIMIT 1`,
        [sessionId, DECISION_EVENTS],
      )
    ).rows[0];
  }

  private async trace(
    c: PoolClient,
    sessionId: number,
    status: string,
    event: string,
    operatorUserId: number,
    note: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor,note)
       VALUES($1,$2,$2,$3,$4,$5)`,
      [sessionId, status, event, String(operatorUserId), note],
    );
  }

  private async reviewRecords(
    c: PoolClient,
    sessionId: number,
    operatorUserId: number,
    resolution: string,
  ): Promise<number> {
    const res = await c.query(
      `UPDATE reconciliation_records SET reviewed_by=$2,reviewed_at=now(),
         resolution=coalesce(resolution || ' | ','') || $3,updated_at=now()
       WHERE session_id=$1 AND reviewed_at IS NULL AND record_type='unknown_id_tag'`,
      [sessionId, operatorUserId, resolution],
    );
    return res.rowCount ?? 0;
  }
}

function validNote(note: unknown): note is string {
  return typeof note === 'string' && note.trim().length > 0 && note.trim().length <= 500;
}
