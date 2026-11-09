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
      const staff = (
        await c.query<{ operator_id: string }>(
          `SELECT staff.operator_id FROM users u
           JOIN operator_staff staff ON staff.user_id=u.id
           JOIN operators o ON o.id=staff.operator_id AND o.status='active'
           WHERE u.id=$1 AND u.role='operator_staff' AND u.account_status='active'`,
          [operatorUserId],
        )
      ).rows[0];
      if (!staff) throw new SessionReviewError('forbidden');
      // Phiên của operator khác trả not_found như phiên không tồn tại: không lộ dữ liệu liên-operator.
      const session = (
        await c.query<{ status: string; received_stopped_at: Date | null }>(
          `SELECT s.status,s.received_stopped_at FROM sessions s
           JOIN charge_points cp ON cp.id=s.charge_point_id JOIN sites st ON st.id=cp.site_id
           WHERE s.id=$1 AND st.operator_id=$2 FOR UPDATE OF s`,
          [sessionId, staff.operator_id],
        )
      ).rows[0];
      if (!session) throw new SessionReviewError('not_found');
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
}
