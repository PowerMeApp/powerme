/**
 * ConsoleCommands — các lệnh điều khiển của bảng điều khiển demo.
 *
 * Vì sao tồn tại: để trình diễn Review 2 (a) mô phỏng sự cố phía server — đóng socket một trụ,
 * rồi xem phiên sang `orphaned` và đối soát khi trụ nối lại — và (b) dừng một phiên từ xa bằng
 * RemoteStopTransaction. Cả hai đi qua đường có sẵn: đóng socket kích hoạt sự kiện `close` của
 * OcppServer (registry.close → SessionsService.onStationOffline), nên KHÔNG tự sửa trạng thái
 * phiên ở đây. Không ghi DB.
 *
 * WF-04 (FE-04) thêm cảnh báo sự cố: danh sách + acknowledge / reset / close. Logic nằm ở
 * `fault-actions.ts` (dùng chung với operator API, D37); ở đây chỉ đổi lỗi sang ConsoleError.
 *
 * Mã lỗi: 404 trụ/phiên/sự cố không tồn tại hoặc trụ không nối · 409 trạng thái phiên/sự cố không
 * cho phép, trụ đang offline, hoặc trụ còn phiên đang sạc khi Reset (trừ khi `force`) · 502 trụ trả
 * lỗi/quá hạn.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module.js';
import { chargePoints, sessions } from '../db/schema/index.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { FaultService, ResetType } from '../stations/faults/fault.service.js';
import { FaultActionError, FaultActions } from './fault-actions.js';
import {
  SessionReviewError,
  SessionReviewErrorCode,
  SessionReviewService,
} from '../sessions/session-review.service.js';
import {
  UnattributedErrorCode,
  UnattributedSessionError,
  UnattributedSessionService,
} from '../sessions/unattributed-session.service.js';
import { AssignInput, CloseInput, ConsoleError, ResolveInput } from './console.http.js';

/** Mô tả ngắn cho từng mã lỗi quyết định (BE-24). */
const DECISION_DETAIL: Record<SessionReviewErrorCode | UnattributedErrorCode, string> = {
  invalid_input:
    'Tham số không hợp lệ (mã lý do: a-z, 0-9, _, tối đa 40 ký tự; ghi chú 1–500 ký tự)',
  forbidden: 'Người gọi không phải nhân viên vận hành đang hoạt động',
  not_found: 'Không có phiên này trong các trụ của operator',
  not_in_review: 'Phiên không ở trạng thái review',
  not_unattributed: 'Phiên không phải unattributed',
  session_not_stopped: 'Phiên chưa có StopTransaction — chưa quyết định được',
  free_vend_not_billable: 'Phiên free vend không bao giờ tính tiền (BR-P08) — chỉ đóng được',
  wallet_card_not_billable: 'Phiên của thẻ ví đã trả tiền tại trụ (BR-P08) — chỉ đóng được',
  driver_not_eligible: 'Tài xế không hoạt động hoặc không có Charging Credit đang mở',
  already_resolved: 'Phiên đã có quyết định khác',
};

/** Trạng thái phiên còn "sống" — RemoteStop chỉ có nghĩa với các trạng thái này. */
const STOPPABLE = new Set(['pending', 'active', 'paused', 'stopping']);
const REMOTE_STOP_TIMEOUT_MS = 15_000;

@Injectable()
export class ConsoleCommands {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ConnectionRegistry,
    /** WF-04. Optional để test BE-08 cũ dựng console không cần nó (khi đó API sự cố trả 503). */
    @Optional() faultService?: FaultService,
    /** BE-24. Optional cùng lý do; thiếu thì các API hàng đợi/quyết định trả 503. */
    @Optional() private readonly review?: SessionReviewService,
    @Optional() private readonly unattributed?: UnattributedSessionService,
  ) {
    this.faultActions = new FaultActions(db, registry, faultService);
  }

  /** WF-04 fault actions, shared with the operator API (D37). */
  readonly faultActions: FaultActions;

  // -------------------------------------------------------------------------------------------
  // BE-24 — phiên unattributed (F-12, FR-13) và phiên review (STM-1 #17). operatorUserId tới từ
  // thân JSON (TẠM, console chưa đăng nhập — F-13); quyền do service kiểm, console không bỏ qua.
  // -------------------------------------------------------------------------------------------

  async unattributedQueue(limit: number) {
    return this.mapDecisionErrors(() => this.requireUnattributed().listPending(limit));
  }

  async reviewQueue(limit: number) {
    return this.mapDecisionErrors(() => this.requireReview().listInReview(limit));
  }

  async assignUnattributed(sessionId: number, input: AssignInput) {
    const r = await this.mapDecisionErrors(() =>
      this.requireUnattributed().assign(
        sessionId,
        input.operatorUserId,
        input.driverId,
        input.note,
      ),
    );
    return {
      session_id: r.sessionId,
      decision: r.decision,
      driver_id: r.driverId,
      payment_mode: r.paymentMode,
      already_resolved: r.alreadyResolved,
      records_reviewed: r.recordsReviewed,
      settlement: r.settlement,
    };
  }

  async closeUnattributed(sessionId: number, input: CloseInput) {
    const r = await this.mapDecisionErrors(() =>
      this.requireUnattributed().close(sessionId, input.operatorUserId, input.reason, input.note),
    );
    return {
      session_id: r.sessionId,
      decision: r.decision,
      reason: r.reason,
      payment_mode: r.paymentMode,
      already_resolved: r.alreadyResolved,
      records_reviewed: r.recordsReviewed,
    };
  }

  async resolveReview(sessionId: number, input: ResolveInput) {
    const r = await this.mapDecisionErrors(() =>
      this.requireReview().resolveReview(
        sessionId,
        input.operatorUserId,
        input.resolution,
        input.note,
      ),
    );
    return {
      session_id: r.sessionId,
      status: r.status,
      records_reviewed: r.recordsReviewed,
      settlement: r.settlement,
    };
  }

  private requireReview(): SessionReviewService {
    if (!this.review) {
      throw new ConsoleError(503, 'review_unavailable', 'SessionReviewService chưa được nạp');
    }
    return this.review;
  }

  private requireUnattributed(): UnattributedSessionService {
    if (!this.unattributed) {
      throw new ConsoleError(
        503,
        'unattributed_unavailable',
        'UnattributedSessionService chưa được nạp',
      );
    }
    return this.unattributed;
  }

  /**
   * Lỗi miền của SessionReviewService / UnattributedSessionService → mã HTTP: 400 tham số sai ·
   * 403 không phải operator_staff active · 404 không có phiên hoặc phiên của operator khác ·
   * 422 tài xế không nhận được phiên · 409 mọi quy tắc trạng thái còn lại.
   */
  private async mapDecisionErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SessionReviewError || err instanceof UnattributedSessionError) {
        const status =
          err.code === 'invalid_input'
            ? 400
            : err.code === 'forbidden'
              ? 403
              : err.code === 'not_found'
                ? 404
                : err.code === 'driver_not_eligible'
                  ? 422
                  : 409;
        throw new ConsoleError(status, err.code, DECISION_DETAIL[err.code]);
      }
      throw err;
    }
  }

  /** Đóng socket phía CSMS (mã 1001 "going away"). 404 nếu trụ không đang nối. */
  async disconnect(serial: string) {
    const conn = this.registry.get(serial);
    if (!conn) throw new ConsoleError(404, 'not_connected', `Trụ ${serial} không đang nối`);
    await conn.client.close({ code: 1001, reason: 'Console: mo phong su co phia CSMS' });
    return { serial, epoch: conn.epoch, closed: true };
  }

  async remoteStop(sessionId: number) {
    const [row] = await this.db
      .select({
        transactionNo: sessions.transactionNo,
        status: sessions.status,
        serial: chargePoints.serialNumber,
      })
      .from(sessions)
      .innerJoin(chargePoints, eq(chargePoints.id, sessions.chargePointId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) throw new ConsoleError(404, 'not_found', `Không có phiên id=${sessionId}`);
    if (!STOPPABLE.has(row.status)) {
      throw new ConsoleError(
        409,
        'session_not_stoppable',
        `Phiên đang ở trạng thái ${row.status}, không dừng từ xa được`,
      );
    }
    const conn = this.registry.get(row.serial);
    if (!conn) {
      throw new ConsoleError(409, 'station_offline', `Trụ ${row.serial} đang offline`);
    }
    let reply: unknown;
    try {
      reply = await conn.client.call(
        'RemoteStopTransaction',
        { transactionId: row.transactionNo },
        { timeoutMs: REMOTE_STOP_TIMEOUT_MS },
      );
    } catch (err) {
      throw new ConsoleError(
        502,
        'station_error',
        `Trụ ${row.serial} không trả lời hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const status = (reply as { status?: unknown } | null)?.status;
    if (status !== 'Accepted' && status !== 'Rejected') {
      throw new ConsoleError(502, 'station_error', `Trụ ${row.serial} trả status lạ`);
    }
    return { session_id: sessionId, transaction_no: row.transactionNo, serial: row.serial, status };
  }

  // -------------------------------------------------------------------------------------------
  // WF-04 — cảnh báo sự cố (FE-04)
  // -------------------------------------------------------------------------------------------

  async faults(filter: 'open' | 'all', limit: number) {
    const rows = await this.consoleFault(() => this.faultActions.list(filter, limit));
    return rows.map((f) => ({
      id: f.id,
      event_no: f.eventNo,
      station: f.serial,
      connector_no: f.connectorNo,
      source: f.source,
      error_code: f.errorCode,
      severity: f.severity,
      hint: f.hint,
      status: f.status,
      raised_at: f.raisedAt.toISOString(),
      acknowledged_at: f.acknowledgedAt?.toISOString() ?? null,
      resolved_at: f.resolvedAt?.toISOString() ?? null,
      reset_command_id: f.resetCommandId,
      reset_command_status: f.resetCommandStatus,
      station_online: f.isOnline,
    }));
  }

  /** t2. The console has no login → acknowledged_by = null. */
  async acknowledgeFault(id: number) {
    return this.consoleFault(() => this.faultActions.acknowledge(id, null));
  }

  /** t7 OPERATOR_CLOSE. */
  async closeFault(id: number) {
    return this.consoleFault(() => this.faultActions.close(id, null));
  }

  /** t4 + Reset CALL; checks and outcomes in {@link FaultActions.reset}. */
  async resetFault(id: number, type: ResetType, force = false) {
    return this.consoleFault(() => this.faultActions.reset(id, type, force, null));
  }

  /** FaultActionError → ConsoleError (same status, code and detail). */
  private async consoleFault<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FaultActionError)
        throw new ConsoleError(err.status, err.code, err.message);
      throw err;
    }
  }
}
