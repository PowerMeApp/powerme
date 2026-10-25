/**
 * OcppMessageLogger — ghi mọi frame OCPP hai chiều vào `ocpp_message_log` (ADR-0005).
 *
 * Vì sao tồn tại: nhật ký thô là thứ duy nhất tái dựng được chuyện gì đã xảy ra (EXP-01) và là
 * ground truth để đo tỉ lệ mất dữ liệu. Gateway gọi `log()` cho CALL chiều vào TRƯỚC khi handler
 * chạy (id trả về đi theo InboundContext), và cho mọi frame khác từ sự kiện `message` của
 * ocpp-rpc. Bảng append-only, partition theo tháng trên received_at (ADR-0007).
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB, Db } from '../db/db.module.js';
import { ocppMessageLog } from '../db/schema/index.js';
import type { MessageType } from './ocpp-types.js';

export interface MessageLogEntry {
  chargePointId: number;
  epoch: number;
  direction: 'in' | 'out';
  messageType: MessageType;
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
}

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
        uniqueId: entry.uniqueId,
        action: entry.messageType === 2 ? entry.action : null,
        cpTimestamp: entry.cpTimestamp,
        receivedAt: entry.receivedAt,
        raw: entry.raw,
        replayed: entry.replayed ?? null,
      })
      .returning({ id: ocppMessageLog.id });
    if (!row) throw new Error('INSERT ocpp_message_log không trả về id');
    return row.id;
  }
}
