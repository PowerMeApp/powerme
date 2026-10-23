/**
 * ConsoleCommands — hai lệnh điều khiển duy nhất của bảng điều khiển demo.
 *
 * Vì sao tồn tại: để trình diễn Review 2 (a) mô phỏng sự cố phía server — đóng socket một trụ,
 * rồi xem phiên sang `orphaned` và đối soát khi trụ nối lại — và (b) dừng một phiên từ xa bằng
 * RemoteStopTransaction. Cả hai đi qua đường có sẵn: đóng socket kích hoạt sự kiện `close` của
 * OcppServer (registry.close → SessionsService.onStationOffline), nên KHÔNG tự sửa trạng thái
 * phiên ở đây. Không ghi DB.
 *
 * Mã lỗi: 404 trụ/phiên không tồn tại hoặc trụ không nối · 409 trạng thái phiên không cho phép
 * dừng hoặc trụ của phiên đang offline · 502 trụ trả lỗi/quá hạn.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module.js';
import { chargePoints, sessions } from '../db/schema/index.js';
import { ConnectionRegistry } from '../ocpp-gateway/connection-registry.js';
import { ConsoleError } from './console.http.js';

/** Trạng thái phiên còn "sống" — RemoteStop chỉ có nghĩa với các trạng thái này. */
const STOPPABLE = new Set(['pending', 'active', 'paused', 'stopping']);
const REMOTE_STOP_TIMEOUT_MS = 15_000;

@Injectable()
export class ConsoleCommands {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly registry: ConnectionRegistry,
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
}
