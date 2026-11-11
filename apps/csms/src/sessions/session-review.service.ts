/**
 * SessionReviewService (BE-18) — operator giải quyết phiên `review` (STM-1 #17 OPERATOR_RESOLVED,
 * review → reconciled), trước đây không có caller.
 *
 * Quyền: người gọi phải là `operator_staff` đang hoạt động của CHÍNH operator sở hữu trụ của phiên
 * (BR-P11/P16: nhiều operator độc lập; B2/migration 0012: reconciliation_records.reviewed_by trỏ
 * operator_staff). Tài xế, admin, nhân viên operator khác bị từ chối. Cùng cách kiểm với
 * beginStartRecovery/recordBoundaryEvidence của WP3.
 *
 * Một transaction: khoá phiên → kiểm quyền và trạng thái → STM-1 → UPDATE sessions → ghi
 * session_status_history (actor = users.id của operator) → đóng các reconciliation_records chưa
 * duyệt của phiên (reviewed_by/at + kết luận). Gọi lại với phiên đã `reconciled` bị từ chối
 * (`not_in_review`) nên một lần giải quyết chỉ có một dấu vết.
 *
 * Quyết toán: sau commit, nếu phiên đã có StopTransaction (received_stopped_at) thì gọi
 * ChargeSettlementService.settle() — cùng đường đã có; chỉ phiên `reconciled` mới được trừ tiền
 * (settle() tự kiểm). Phiên hard cap chưa có StopTransaction thì không có gì để trừ.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB, Db } from '../db/db.module.js';
import { ChargeSettlementService } from './charge-settlement.service.js';
import { chargeTransaction } from './charge-sql.js';
import { lockOperatorSession } from './operator-session-access.js';
import { SessionStateMachine, SessionStatus } from './session-state-machine.js';

export type SessionReviewErrorCode = 'invalid_input' | 'forbidden' | 'not_found' | 'not_in_review';

export class SessionReviewError extends Error {
  constructor(readonly code: SessionReviewErrorCode) {
    super(code);
    this.name = 'SessionReviewError';
  }
}

export interface ResolveReviewResult {
  sessionId: number;
  status: 'reconciled';
  /** Số reconciliation_records chưa duyệt đã được đóng. */
  recordsReviewed: number;
  /** Kết quả settle() nếu phiên đã có StopTransaction; null nếu không có gì để quyết toán. */
  settlement: 'posted' | 'already_posted' | 'pending' | 'ineligible' | null;
}

/** Bản ghi mang kết luận đối soát — những loại operator phải duyệt (không gồm replay/duplicate…). */
const VERDICT_TYPES = ['meter_gap', 'conflict', 'late_sample'];

@Injectable()
export class SessionReviewService {
  private readonly logger = new Logger(SessionReviewService.name);
  private readonly stateMachine = new SessionStateMachine();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settlement: ChargeSettlementService,
  ) {}

  /**
   * @param resolution mã kết luận ngắn (a-z, 0-9, _; ≤ 40 ký tự), vd `accepted_station_data`.
   * @param note lý do / bằng chứng của operator, 1–500 ký tự.
   */
  async resolveReview(
    sessionId: number,
    operatorUserId: number,
    resolution: string,
    note: string,
  ): Promise<ResolveReviewResult> {
    if (
      ![sessionId, operatorUserId].every((n) => Number.isSafeInteger(n) && n > 0) ||
      typeof resolution !== 'string' ||
      !/^[a-z0-9_]{1,40}$/.test(resolution) ||
      typeof note !== 'string' ||
      !note.trim() ||
      note.trim().length > 500
    )
      throw new SessionReviewError('invalid_input');
    const text = note.trim();

    const outcome = await chargeTransaction(this.db, async (c) => {
      // Quyền + khoá dòng: dùng chung với UnattributedSessionService (operator-session-access.ts).
      const lock = await lockOperatorSession(c, sessionId, operatorUserId);
      if (!lock.ok) throw new SessionReviewError(lock.code);
      const { session } = lock;
      if (!this.stateMachine.canApply(session.status as SessionStatus, 'OPERATOR_RESOLVED'))
        throw new SessionReviewError('not_in_review');

      const to = this.stateMachine.apply('review', 'OPERATOR_RESOLVED'); // T13 #17
      await c.query('UPDATE sessions SET status=$2,updated_at=now() WHERE id=$1', [sessionId, to]);
      await c.query(
        `INSERT INTO session_status_history(session_id,from_status,to_status,event,actor,note)
         VALUES($1,'review',$2,'OPERATOR_RESOLVED',$3,$4)`,
        [sessionId, to, String(operatorUserId), `${resolution}: ${text}`],
      );
      const reviewed = await c.query(
        `UPDATE reconciliation_records SET reviewed_by=$2,reviewed_at=now(),
           resolution=coalesce(resolution || ' | ','') || $3,updated_at=now()
         WHERE session_id=$1 AND reviewed_at IS NULL AND record_type = ANY($4::reconciliation_record_type[])`,
        [sessionId, operatorUserId, `operator_resolved(${resolution}): ${text}`, VERDICT_TYPES],
      );
      return {
        recordsReviewed: reviewed.rowCount ?? 0,
        stopped: session.received_stopped_at !== null,
      };
    });

    this.logger.log(
      JSON.stringify({ event: 'session_review_resolved', sessionId, operatorUserId, resolution }),
    );
    // Sau commit: settle() có transaction riêng và tự nuốt lỗi billing (job bền sẽ thử lại).
    const settlement = outcome.stopped ? await this.settlement.settle(sessionId) : null;
    return {
      sessionId,
      status: 'reconciled',
      recordsReviewed: outcome.recordsReviewed,
      settlement,
    };
  }

  /**
   * BE-24: hàng đợi phiên `review` cho console (mới nhất trước), kèm các bản ghi kết luận chưa duyệt.
   * Chưa lọc theo operator — console chưa có đăng nhập (cùng mức với GET /api/admin/sessions);
   * mỗi dòng mang `operator_id` để màn hình lọc. Quyền chỉ kiểm khi GHI (resolveReview).
   */
  async listInReview(limit: number): Promise<ReviewQueueItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new SessionReviewError('invalid_input');
    const { rows } = await this.db.$client.query<ReviewQueueRow>(
      `SELECT s.id,s.transaction_no,cp.serial_number,s.connector_no,s.id_tag,s.origin,s.payment_mode,
         s.energy_wh,s.received_stopped_at,s.updated_at,st.operator_id,
         coalesce((SELECT array_agg(r.resolution ORDER BY r.record_no) FROM reconciliation_records r
           WHERE r.session_id=s.id AND r.reviewed_at IS NULL
             AND r.record_type = ANY($2::reconciliation_record_type[])),'{}') AS open_records
       FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id JOIN sites st ON st.id=cp.site_id
       WHERE s.status='review' ORDER BY s.updated_at DESC,s.id DESC LIMIT $1`,
      [limit, VERDICT_TYPES],
    );
    return rows.map((r) => ({
      session_id: Number(r.id),
      transaction_no: r.transaction_no,
      station: r.serial_number,
      connector_no: r.connector_no,
      id_tag: r.id_tag,
      origin: r.origin,
      payment_mode: r.payment_mode,
      energy_wh: r.energy_wh === null ? null : Number(r.energy_wh),
      stopped: r.received_stopped_at !== null,
      operator_id: Number(r.operator_id),
      open_records: r.open_records.filter((x): x is string => x !== null),
    }));
  }
}

interface ReviewQueueRow {
  id: string;
  transaction_no: number;
  serial_number: string;
  connector_no: number;
  id_tag: string;
  origin: string;
  payment_mode: string;
  energy_wh: string | null;
  received_stopped_at: Date | null;
  updated_at: Date;
  operator_id: string;
  open_records: (string | null)[];
}

export interface ReviewQueueItem {
  session_id: number;
  transaction_no: number;
  station: string;
  connector_no: number;
  id_tag: string;
  origin: string;
  payment_mode: string;
  energy_wh: number | null;
  /** Đã có StopTransaction — giải quyết sẽ gọi quyết toán. */
  stopped: boolean;
  operator_id: number;
  open_records: string[];
}
