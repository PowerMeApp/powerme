/**
 * ConsoleCommands — các lệnh điều khiển của bảng điều khiển demo.
 *
 * Vì sao tồn tại: để trình diễn Review 2 (a) mô phỏng sự cố phía server — đóng socket một trụ,
 * rồi xem phiên sang `orphaned` và đối soát khi trụ nối lại — và (b) dừng một phiên từ xa bằng
 * RemoteStopTransaction. Cả hai đi qua đường có sẵn: đóng socket kích hoạt sự kiện `close` của
 * OcppServer (registry.close → SessionsService.onStationOffline), nên KHÔNG tự sửa trạng thái
 * phiên ở đây. Không ghi DB.
 *
 * WF-04 (FE-04) thêm cảnh báo sự cố: danh sách + acknowledge / reset / close. Trạng thái sự cố do
 * FaultService (module stations) giữ; ở đây chỉ GỬI CALL Reset qua ConnectionRegistry vì stations
 * không được import gateway (ADR-0016 D-F) — cùng cách RemoteStop bên dưới.
 *
 * Mã lỗi: 404 trụ/phiên/sự cố không tồn tại hoặc trụ không nối · 409 trạng thái phiên/sự cố không
 * cho phép, trụ đang offline, hoặc trụ còn phiên đang sạc khi Reset (trừ khi `force`) · 502 trụ trả
 * lỗi/quá hạn.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray, ne, or, isNull } from 'drizzle-orm';
import { DB, Db } from '../db/db.module.js';
import { chargePoints, connectors, faultEvents, sessions } from '../db/schema/index.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import {
  FaultNotFoundError,
  FaultService,
  InvalidFaultTransitionError,
  ResetType,
} from '../stations/faults/fault.service.js';
import { ConsoleError } from './console.http.js';

/** Trạng thái phiên còn "sống" — RemoteStop chỉ có nghĩa với các trạng thái này. */
const STOPPABLE = new Set(['pending', 'active', 'paused', 'stopping']);
/**
 * Phiên mà Reset (luôn áp cho CẢ trụ, OCPP 1.6) sẽ cắt ngang: đang cấp điện, sắp bắt đầu
 * (`pending` — RemoteStart đã Accepted, tài xế sắp cắm), hoặc `orphaned` — trụ nối lại nhưng phiên
 * chưa có bản tin live (STM-1 #18) nên vẫn có thể đang sạc thật. Phiên orphaned cũ (tới hạn 24 h)
 * cũng chặn: operator thấy tên phiên trong 409 và dùng `force`.
 */
const CHARGING = ['pending', 'active', 'paused', 'stopping', 'orphaned'] as const;
const REMOTE_STOP_TIMEOUT_MS = 15_000;
const RESET_CALL_TIMEOUT_MS = 15_000;

@Injectable()
export class ConsoleCommands {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ConnectionRegistry,
    /** WF-04. Optional để test BE-08 cũ dựng console không cần nó (khi đó API sự cố trả 503). */
    @Optional() private readonly faultService?: FaultService,
  ) {}

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
    const rows = await this.requireFaults().list(filter, limit);
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

  /** t2. Console chưa có đăng nhập → acknowledged_by = null (ADR-0011 chưa làm). */
  async acknowledgeFault(id: number) {
    return this.mapFaultErrors(() => this.requireFaults().acknowledge(id, null));
  }

  /** t7 OPERATOR_CLOSE. */
  async closeFault(id: number) {
    return this.mapFaultErrors(() => this.requireFaults().close(id, null));
  }

  /**
   * t4 rồi gửi CALL Reset. Kiểm trước (không ghi gì): sự cố phải `acknowledged`, trụ phải đang
   * nối, và trụ không còn phiên đang sạc trên súng KHÁC — Reset của OCPP 1.6 khởi động lại cả trụ,
   * tài xế ở súng bên cạnh sẽ bị cắt ngang không báo trước (review #61, BR-P07 "communicated
   * downtime"). Operator xác nhận lần hai thì gửi `force` và lệnh ghi `payload.force = true`.
   * Phiên trên chính súng lỗi không tính: WF-04 bước 1 đã đóng nó (StopTransaction reason Other).
   * Accepted → sự cố giữ `resetting` chờ súng hồi phục / hết hạn; Rejected → `acknowledged` (t6);
   * trụ không trả lời hợp lệ → lệnh `failed`, sự cố `acknowledged`, HTTP 502.
   */
  async resetFault(id: number, type: ResetType, force = false) {
    const faults = this.requireFaults();
    const fault = await this.mapFaultErrors(() => faults.get(id));
    if (!faults.canApply(fault.status, 'RESET_SENT')) {
      throw new ConsoleError(
        409,
        'fault_not_acknowledged',
        `Sự cố đang ở trạng thái ${fault.status}; chỉ Reset được khi đã acknowledged`,
      );
    }
    const conn = this.registry.get(fault.serial);
    if (!conn) {
      throw new ConsoleError(409, 'station_offline', `Trụ ${fault.serial} đang offline`);
    }
    // Sự cố khác trên cùng trụ đang chờ Reset: trụ đang (hoặc sắp) khởi động lại — Reset thứ hai
    // giữa lúc reboot chỉ làm rối kết quả của lệnh đầu.
    const [busy] = await this.db
      .select({ id: faultEvents.id })
      .from(faultEvents)
      .where(
        and(
          eq(faultEvents.chargePointId, fault.chargePointId),
          eq(faultEvents.status, 'resetting'),
          ne(faultEvents.id, id),
        ),
      )
      .limit(1);
    if (busy) {
      throw new ConsoleError(
        409,
        'reset_in_progress',
        `Trụ ${fault.serial} đang chờ kết quả Reset của sự cố #${busy.id}; đợi xong rồi thử lại`,
      );
    }
    const charging = await this.chargingSessionsBesideFault(id);
    if (charging.length > 0 && !force) {
      const list = charging.map((s) => `súng ${s.connectorNo} (phiên ${s.sessionId})`).join(', ');
      throw new ConsoleError(
        409,
        'sessions_active',
        `Trụ ${fault.serial} đang có phiên sạc ở ${list}; Reset sẽ cắt các phiên này. Gửi lại với force=true nếu chắc chắn.`,
      );
    }
    const begun = await this.mapFaultErrors(() =>
      faults.beginReset(id, { type, requestedBy: null, force: charging.length > 0 }),
    );
    await faults.markSent(begun.commandId);
    let reply: unknown;
    try {
      reply = await conn.client.call('Reset', { type }, { timeoutMs: RESET_CALL_TIMEOUT_MS });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await faults.onResetResult(begun.commandId, { error: detail });
      throw new ConsoleError(
        502,
        'station_error',
        `Trụ ${fault.serial} không trả lời Reset hợp lệ: ${detail}`,
      );
    }
    const status = (reply as { status?: unknown } | null)?.status;
    if (status !== 'Accepted' && status !== 'Rejected') {
      await faults.onResetResult(begun.commandId, { error: 'status lạ trong Reset.conf' });
      throw new ConsoleError(502, 'station_error', `Trụ ${fault.serial} trả status lạ`);
    }
    const result = await faults.onResetResult(begun.commandId, { status, response: reply });
    return {
      fault_id: id,
      command_id: begun.commandId,
      serial: fault.serial,
      reset_status: status,
      fault_status: result.faultStatus,
      forced: charging.length > 0,
    };
  }

  /**
   * Phiên đang sạc trên trụ của sự cố, trừ súng của chính sự cố. Sự cố connector 0 (cả trụ,
   * connector_id null) thì mọi phiên đều tính.
   */
  private async chargingSessionsBesideFault(
    faultId: number,
  ): Promise<{ sessionId: number; connectorNo: number }[]> {
    return this.db
      .select({ sessionId: sessions.id, connectorNo: connectors.connectorNo })
      .from(faultEvents)
      .innerJoin(sessions, eq(sessions.chargePointId, faultEvents.chargePointId))
      .innerJoin(connectors, eq(connectors.id, sessions.connectorId))
      .where(
        and(
          eq(faultEvents.id, faultId),
          inArray(sessions.status, [...CHARGING]),
          or(isNull(faultEvents.connectorId), ne(sessions.connectorId, faultEvents.connectorId)),
        ),
      )
      .orderBy(connectors.connectorNo);
  }

  private requireFaults(): FaultService {
    if (!this.faultService) {
      throw new ConsoleError(503, 'faults_unavailable', 'FaultService chưa được nạp');
    }
    return this.faultService;
  }

  /** Lỗi miền của FaultService → mã HTTP của console. */
  private async mapFaultErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FaultNotFoundError) throw new ConsoleError(404, 'not_found', err.message);
      if (err instanceof InvalidFaultTransitionError) {
        throw new ConsoleError(409, 'invalid_transition', err.message);
      }
      throw err;
    }
  }
}
