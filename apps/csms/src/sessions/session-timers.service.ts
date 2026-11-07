/**
 * SessionTimersService (BE-18) — hai chuyển STM-1 do THỜI GIAN kích hoạt, trước đây chưa ai gọi:
 *   - #4  START_TIMEOUT        pending  → failed   (SESSION_START_TIMEOUT_S, mặc định 120 s)
 *   - #16a HARD_CAP_EXCEEDED   orphaned → review   (SESSION_HARD_CAP_H, mặc định 24 h)
 *
 * Theo mẫu ChargeRecoveryService/BE-17: bộ quét theo DB, KHÔNG timer trong bộ nhớ. Trạng thái
 * "đã quá hạn chưa" luôn suy ra từ dữ liệu bền (mốc thời gian trong DB), nên restart không làm mất
 * hạn và không cần cột mới. `ChargeRecoveryService.tick()` gọi hai bộ quét này mỗi 10 s và đã chặn chạy
 * chồng; bên trong, mỗi phiên còn bị khoá `FOR UPDATE` + kiểm lại điều kiện nên hai bộ quét (hai
 * tiến trình CSMS) cũng không áp một chuyển hai lần.
 *
 * START_TIMEOUT sống ở intent chứ không ở `sessions` (xem DriverChargingService.expireStaleStarts):
 * `pending` chưa có dòng `sessions`. Service này chỉ cấp ngưỡng từ cấu hình.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql, SQL } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import { sessions, sessionStatusHistory } from '../db/schema/index.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { DriverChargingService } from './driver-charging.service.js';
import { SessionStateMachine } from './session-state-machine.js';

/**
 * MỐC ĐẾM của hard cap: lần VÀO orphaned gần nhất của phiên (`s` là bí danh của bảng sessions).
 *
 * Không dùng thẳng `sessions.orphaned_at` vì cột đó giữ lần ĐẦU phiên sang orphaned và không đổi
 * khi orphaned → active (#18). Phiên orphaned 30 h trước, sống lại, rồi orphaned lần nữa vài phút
 * trước sẽ bị hard cap ngay nếu lấy orphaned_at. Lần vào gần nhất lấy từ session_status_history
 * (cùng transaction với UPDATE status nên luôn khớp); orphaned_at là phương án dự phòng cho dữ
 * liệu cũ không có lịch sử, rồi updated_at.
 * CHỜ ÂN XÁC NHẬN MỐC — muốn đổi (vd đếm từ orphaned_at, hay từ bản tin cuối) chỉ sửa hàm này.
 */
export function orphanedSinceSql(): SQL {
  return sql`coalesce(
    (SELECT max(h.occurred_at) FROM session_status_history h
      WHERE h.session_id = s.id AND h.to_status = 'orphaned'),
    s.orphaned_at, s.updated_at)`;
}

@Injectable()
export class SessionTimersService {
  private readonly logger = new Logger(SessionTimersService.name);
  private readonly stateMachine = new SessionStateMachine();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly driverCharging: DriverChargingService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** STM-1 #4: nhả các lệnh RemoteStart đã Accepted nhưng không có StartTransaction. */
  expireStaleStarts(): Promise<number> {
    return this.driverCharging.expireStaleStarts(this.config.sessionStartTimeoutS);
  }

  /** STM-1 #16a: phiên orphaned quá SESSION_HARD_CAP_H → review. Trả số phiên đã chuyển. */
  async expireHardCapped(limit = 50): Promise<number> {
    const capH = this.config.sessionHardCapH;
    if (!Number.isFinite(capH) || capH <= 0) throw new Error('invalid_session_hard_cap');
    const due = sql`s.status = 'orphaned' AND ${orphanedSinceSql()} <= now() - (${capH}::float8 * interval '1 hour')`;
    const candidates = (
      await this.db.execute<{ id: string }>(
        sql`SELECT s.id FROM sessions s WHERE ${due} ORDER BY s.id LIMIT ${limit}`,
      )
    ).rows;
    let moved = 0;
    for (const candidate of candidates) {
      const sessionId = Number(candidate.id);
      const done = await this.db.transaction(async (tx) => {
        const row = (
          await tx.execute<{ since_ms: number; transaction_no: number }>(
            sql`SELECT (extract(epoch FROM ${orphanedSinceSql()}) * 1000)::float8 AS since_ms, s.transaction_no FROM sessions s
                WHERE s.id = ${sessionId} AND ${due} FOR UPDATE OF s`,
          )
        ).rows[0];
        if (!row) return false; // đã có bản tin live (#18), StopTransaction hoặc bộ quét khác
        const since = new Date(Number(row.since_ms));
        const now = new Date();
        const to = this.stateMachine.apply('orphaned', 'HARD_CAP_EXCEEDED');
        await tx
          .update(sessions)
          .set({ status: to, updatedAt: now })
          .where(eq(sessions.id, sessionId));
        await tx.insert(sessionStatusHistory).values({
          sessionId,
          fromStatus: 'orphaned',
          toStatus: to,
          event: 'HARD_CAP_EXCEEDED',
          actor: 'system',
          note: `orphaned_since=${since.toISOString()} cap_h=${capH}`,
          occurredAt: now,
        });
        await this.reconciliation.recordHardCap(tx, sessionId, since, now, capH);
        this.logger.warn(
          JSON.stringify({
            event: 'session_hard_cap_exceeded',
            sessionId,
            transactionNo: row.transaction_no,
            orphanedSince: since.toISOString(),
            capH,
          }),
        );
        return true;
      });
      if (done) moved++;
    }
    return moved;
  }
}
