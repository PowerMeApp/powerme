/**
 * ConnectionRegistry — sổ đăng ký kết nối: identity (serial_number) → client ocpp-rpc, epoch,
 * epoch_opened_at. Port từ `lab/csms-ctl.mjs` (stations Map) + `trace.mjs` (epoch), thêm DB.
 *
 * Vì sao tồn tại:
 *   - ADR-0004 #2: ocpp-rpc không xử lý trụ nối lại cùng identity khi socket cũ còn treo → ở
 *     đây đóng socket cũ (1012) trước khi nhận socket mới.
 *   - T13 mục 6: epoch PHẢI khởi tạo từ DB (`MAX(epoch) + 1` trong charge_point_connections),
 *     không đếm trong RAM — EXP-01 chính là ca CSMS chết, registry mất sạch.
 *   - STM-3: socket mở = `in_service` (không chờ BootNotification — EXP-01 trụ nối lại không
 *     gửi Boot); socket đóng = `offline`. Lifecycle của trụ ghi ở đây vì đây là nơi quan sát
 *     được sự kiện socket.
 *
 * Mỗi lần mở = một dòng charge_point_connections (opened_at, remote_address); đóng = closed_at +
 * close_reason. `epoch_opened_at` giữ trong bộ nhớ để ReplayDetector phân loại không cần đọc DB.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB, Db } from '../db/db.module.js';
import { chargePointConnections, chargePoints } from '../db/schema/index.js';

/** Phần của RPCServerClient mà registry cần — tối thiểu để test thay bằng stub. */
export interface OcppClientLike {
  readonly identity: string | undefined;
  call(method: string, params?: unknown, options?: Record<string, unknown>): Promise<unknown>;
  close(options?: { code?: number; reason?: string }): Promise<unknown>;
}

export interface Connection {
  identity: string;
  chargePointId: number;
  epoch: number;
  epochOpenedAt: Date;
  client: OcppClientLike;
  remoteAddress: string | null;
}

/** Mã đóng dùng khi CSMS thay socket cũ bằng socket mới cùng identity. */
export const CLOSE_SUPERSEDED = { code: 1012, reason: 'Thay the boi ket noi moi' } as const;

@Injectable()
export class ConnectionRegistry {
  private readonly logger = new Logger(ConnectionRegistry.name);
  private readonly byIdentity = new Map<string, Connection>();

  constructor(@Inject(DB) private readonly db: Db) {}

  /** id trụ theo serial_number, null nếu chưa onboard (auth từ chối 404). */
  async findChargePointId(identity: string): Promise<number | null> {
    const [row] = await this.db
      .select({ id: chargePoints.id })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, identity))
      .limit(1);
    return row?.id ?? null;
  }

  get(identity: string): Connection | undefined {
    return this.byIdentity.get(identity);
  }

  get size(): number {
    return this.byIdentity.size;
  }

  /**
   * Mở epoch mới cho trụ. Đóng socket cũ cùng identity nếu còn. `openedAt` chỉ để test tích hợp
   * phát lại trace với mốc thời gian thật; app dùng mặc định `new Date()`.
   */
  async open(
    identity: string,
    client: OcppClientLike,
    opts: { remoteAddress?: string | null; openedAt?: Date } = {},
  ): Promise<Connection> {
    const chargePointId = await this.findChargePointId(identity);
    if (chargePointId === null)
      throw new Error(`Trụ "${identity}" chưa đăng ký trong charge_points`);
    const openedAt = opts.openedAt ?? new Date();

    const old = this.byIdentity.get(identity);
    if (old && old.client !== client) {
      this.logger.warn(
        `${identity} nối lại khi kết nối cũ (epoch ${old.epoch}) còn treo — đóng kết nối cũ`,
      );
      this.byIdentity.delete(identity);
      await this.markClosed(old, openedAt, `${CLOSE_SUPERSEDED.code} superseded`);
      await old.client.close(CLOSE_SUPERSEDED).catch(() => undefined);
    }

    const epoch = await this.db.transaction(async (tx) => {
      const [agg] = await tx
        .select({ max: sql<number>`coalesce(max(${chargePointConnections.epoch}), 0)` })
        .from(chargePointConnections)
        .where(eq(chargePointConnections.chargePointId, chargePointId));
      const next = Number(agg?.max ?? 0) + 1;
      await tx.insert(chargePointConnections).values({
        chargePointId,
        epoch: next,
        openedAt,
        remoteAddress: opts.remoteAddress ?? null,
      });
      await tx
        .update(chargePoints)
        .set({
          currentEpoch: next,
          lifecycle: 'in_service',
          lastMessageAt: openedAt,
          updatedAt: openedAt,
        })
        .where(eq(chargePoints.id, chargePointId));
      return next;
    });

    const conn: Connection = {
      identity,
      chargePointId,
      epoch,
      epochOpenedAt: openedAt,
      client,
      remoteAddress: opts.remoteAddress ?? null,
    };
    this.byIdentity.set(identity, conn);
    this.logger.log(`▶ ${identity} kết nối (epoch ${epoch}, ${opts.remoteAddress ?? 'địa chỉ ?'})`);
    return conn;
  }

  /**
   * Socket đóng. Trả về Connection vừa đóng nếu đó là kết nối hiện hành (để gateway kéo phiên
   * sang orphaned); null nếu là socket cũ đã bị thay thế (đã xử lý lúc open).
   */
  async close(
    client: OcppClientLike,
    opts: { code?: number; reason?: string; closedAt?: Date } = {},
  ): Promise<Connection | null> {
    const identity = client.identity;
    if (!identity) return null;
    const conn = this.byIdentity.get(identity);
    if (!conn || conn.client !== client) return null;
    this.byIdentity.delete(identity);
    const closedAt = opts.closedAt ?? new Date();
    await this.markClosed(conn, closedAt, `${opts.code ?? '?'} ${opts.reason ?? ''}`.trim());
    await this.db
      .update(chargePoints)
      .set({ lifecycle: 'offline', updatedAt: closedAt })
      .where(eq(chargePoints.id, conn.chargePointId));
    this.logger.warn(
      `■ ${identity} ngắt (epoch ${conn.epoch}, ${opts.code ?? '?'} ${opts.reason ?? ''})`,
    );
    return conn;
  }

  /** Cập nhật last_message_at — mỗi CALL chiều vào (STM-3 mục 3.4). */
  async touch(conn: Connection, at: Date): Promise<void> {
    await this.db
      .update(chargePoints)
      .set({ lastMessageAt: at })
      .where(eq(chargePoints.id, conn.chargePointId));
  }

  private async markClosed(conn: Connection, closedAt: Date, closeReason: string): Promise<void> {
    await this.db
      .update(chargePointConnections)
      .set({ closedAt, closeReason })
      .where(
        and(
          eq(chargePointConnections.chargePointId, conn.chargePointId),
          eq(chargePointConnections.epoch, conn.epoch),
          isNull(chargePointConnections.closedAt),
        ),
      );
  }

  /** Epoch gần nhất đã ghi trong DB (để kiểm tra / quan sát). */
  async latestEpoch(chargePointId: number): Promise<number> {
    const [row] = await this.db
      .select({ epoch: chargePointConnections.epoch })
      .from(chargePointConnections)
      .where(eq(chargePointConnections.chargePointId, chargePointId))
      .orderBy(desc(chargePointConnections.epoch))
      .limit(1);
    return row?.epoch ?? 0;
  }
}
