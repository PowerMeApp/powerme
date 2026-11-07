/**
 * OcppMessageLogger — ghi mọi frame OCPP hai chiều vào `ocpp_message_log` (ADR-0005).
 *
 * Vì sao tồn tại: nhật ký thô là thứ duy nhất tái dựng được chuyện gì đã xảy ra (EXP-01) và là
 * ground truth để đo tỉ lệ mất dữ liệu. Gateway gọi `log()` cho CALL chiều vào TRƯỚC khi handler
 * chạy (id trả về đi theo InboundContext), và cho mọi frame khác từ sự kiện `message` của
 * ocpp-rpc. Bảng append-only, partition theo tháng trên received_at (ADR-0007).
 *
 * Frame bị ocpp-rpc loại TRƯỚC handler (CALL sai schema, frame hỏng cấu trúc — G12 / BM02 F42)
 * vẫn được ghi, với `validationError` có giá trị (cột `validation_error`, migration 0013): gateway
 * gọi `logRejected()` từ sự kiện `strictValidationFailure` / `badMessage`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB, Db } from '../db/db.module.js';
import { ocppMessageLog } from '../db/schema/index.js';
import type { MessageType } from './ocpp-types.js';

export interface MessageLogEntry {
  chargePointId: number;
  epoch: number;
  direction: 'in' | 'out';
  /** Null chỉ khi `validationError` có giá trị và frame không xác định được loại. */
  messageType: MessageType | null;
  uniqueId: string;
  /** Chỉ có với CALL (type 2); CHECK trong DB bắt (type = 2) = (action IS NOT NULL). */
  action: string | null;
  cpTimestamp: Date | null;
  receivedAt: Date;
  /** Frame đã parse ([type, id, ...]). */
  raw: unknown;
  /**
   * Phán quyết ReplayDetector — PHẢI truyền lúc INSERT (bảng append-only, không UPDATE được).
   * null/bỏ qua = không phân loại được (không có cp_timestamp, hoặc không phải CALL chiều vào).
   */
  replayed?: boolean | null;
  /** Lý do ocpp-rpc từ chối frame; bỏ qua/null = frame hợp lệ. Truyền lúc INSERT. */
  validationError?: string | null;
}

/**
 * Độ dài cột `ocpp_message_log.unique_id` / `action` (varchar(36) / varchar(40), migration 0014).
 * Frame hỏng hay sai schema (G12) có thể mang UniqueId/action dài tuỳ ý; INSERT sẽ bị 22001 và dòng
 * kiểm toán mất đúng lúc cần nhất. Cắt hai trường định danh này cho vừa cột — frame nguyên văn vẫn
 * nằm đủ trong `raw`.
 */
const UNIQUE_ID_MAX = 36;
const ACTION_MAX = 40;
const clamp = <T extends string | null>(value: T, max: number): T =>
  (typeof value === 'string' && value.length > max ? value.slice(0, max) : value) as T;

@Injectable()
export class OcppMessageLogger {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** INSERT một dòng, trả id. Ném lỗi nếu DB từ chối — gateway quyết định xử lý tiếp. */
  async log(entry: MessageLogEntry): Promise<number> {
    const [row] = await this.db
      .insert(ocppMessageLog)
      .values({
        chargePointId: entry.chargePointId,
        epoch: entry.epoch,
        direction: entry.direction,
        messageType: entry.messageType,
        uniqueId: clamp(entry.uniqueId, UNIQUE_ID_MAX),
        action: entry.messageType === 2 ? clamp(entry.action, ACTION_MAX) : null,
        cpTimestamp: entry.cpTimestamp,
        receivedAt: entry.receivedAt,
        raw: entry.raw,
        replayed: entry.replayed ?? null,
        validationError: entry.validationError ?? null,
      })
      .returning({ id: ocppMessageLog.id });
    if (!row) throw new Error('INSERT ocpp_message_log không trả về id');
    return row.id;
  }
}
