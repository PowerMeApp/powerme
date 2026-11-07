/**
 * OcppServer — máy chủ OCPP-J 1.6 trên ocpp-rpc 2.2.1 (ADR-0004: strictMode, protocols ocpp1.6).
 *
 * Vì sao tồn tại: đây là chỗ nối ocpp-rpc với phần còn lại của CSMS. Trình tự cho MỖI CALL chiều
 * vào (`handleCall`, cũng là đường test tích hợp phát lại trace EXP-01 gọi thẳng, không mở socket):
 *   1. ghi nhận received_at (đồng hồ CSMS, ADR-0009)
 *   2. xếp vào InboundSerializer theo identity → tuần tự hoá (ADR-0004 #1)
 *   3. ReplayDetector phân loại bằng epoch_opened_at trong registry
 *   4. INSERT ocpp_message_log TRƯỚC khi handler chạy (ADR-0005)
 *   5. OcppHandlers.dispatch → SessionsService
 * Frame chiều ra và CALLRESULT/CALLERROR chiều vào được ghi từ sự kiện `message` của ocpp-rpc.
 * Frame bị ocpp-rpc loại TRƯỚC handler (G12 / BM02 F42, ocpp-rpc 2.2.1): CALL chiều vào sai schema
 * → sự kiện `strictValidationFailure` {outbound:false, isCall:true}, phát đồng bộ ngay sau `message`
 * và trước handler, thư viện tự trả CALLERROR; frame hỏng cấu trúc (không JSON / không mảng /
 * MessageTypeId lạ / method không phải chuỗi) → `badMessage` {buffer, error, response}. Cả hai được
 * ghi vào ocpp_message_log (direction 'in', cột validation_error); lỗi ghi log chỉ được log, không
 * làm sập kết nối. CALLRESULT chiều vào sai schema đã có dòng thô từ sự kiện `message` (không ghi
 * thêm — bảng append-only không cho gắn cờ sau).
 *
 * Vòng đời socket (STM-3, ADR-0016): `client` event → registry.open (epoch = MAX+1 từ DB,
 * is_online=true, awaiting_connection → in_service) → TriggerMessage(StatusNotification) c0/c1/c2
 * best-effort (T13 2.4, EXP-01: trụ nối lại không gửi lại StatusNotification) · `close` event →
 * registry.close (is_online=false, không đụng lifecycle) → OfflineGraceService (hẹn giờ ân hạn;
 * hết hạn mà chưa nối lại mới gọi SessionsService.onStationOffline, #13–#15).
 *
 * Mọi thứ phụ thuộc socket thật nằm trong `start()`; constructor không tạo RPCServer để test
 * dựng được OcppServer mà không mở cổng.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { RPCServer } from 'ocpp-rpc';
import type RPCServerClient from 'ocpp-rpc/lib/server-client';
import type { IHandshakeInterface } from 'ocpp-rpc/lib/server-client';
import { CONFIG, CsmsConfig } from '../config.js';
import { ReplayDetector } from '../reconciliation/replay-detector.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ChargePointAuthService } from '../stations/charge-point-auth.service.js';
import { Connection, ConnectionRegistry } from './connection-registry.js';
import { InboundSerializer } from './inbound-serializer.js';
import type { InboundContext } from './inbound-context.js';
import { OfflineGraceService } from './offline-grace.service.js';
import { OcppHandlers } from './ocpp-handlers.js';
import { MessageLogEntry, OcppMessageLogger } from './ocpp-message-logger.js';
import { cpTimestampOf, InboundCall, MESSAGE_TYPE, parseFrame } from './ocpp-types.js';

/** Payload sự kiện `strictValidationFailure` của ocpp-rpc 2.2.1 (client.js). */
interface StrictValidationFailureEvent {
  messageId?: string;
  method?: string;
  params?: unknown;
  error?: Error;
  outbound?: boolean;
  isCall?: boolean;
}

/** Payload sự kiện `badMessage` của ocpp-rpc 2.2.1 (client.js `_onMessage`). */
interface BadMessageEvent {
  buffer?: Buffer;
  error?: Error;
}

/**
 * Mã lỗi ocpp-rpc 2.2.1 gắn lên lỗi (`rpcErrorCode`) KHÁC mã nó gửi cho trụ ở hai chỗ do sai chính
 * tả trong spec OCPP 1.6J (client.js `_onCall`: FormatViolation → FormationViolation,
 * OccurenceConstraintViolation → OccurrenceConstraintViolation). Ghi mã THỰC SỰ trên dây để dòng
 * log khớp CALLERROR trụ nhận.
 */
const WIRE_CODE: Readonly<Record<string, string>> = {
  FormatViolation: 'FormationViolation',
  OccurenceConstraintViolation: 'OccurrenceConstraintViolation',
};

function describeRpcError(error: (Error & { rpcErrorCode?: string }) | undefined): string {
  if (!error) return 'unknown';
  const code = error.rpcErrorCode ?? error.name;
  return `${WIRE_CODE[code] ?? code}: ${error.message}`.slice(0, 2000);
}

@Injectable()
export class OcppServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OcppServer.name);
  private server: RPCServer | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly registry: ConnectionRegistry,
    private readonly messageLog: OcppMessageLogger,
    private readonly serializer: InboundSerializer,
    private readonly replayDetector: ReplayDetector,
    private readonly handlers: OcppHandlers,
    private readonly sessions: SessionsService,
    /** WF-05 (SD-5b): lifecycle + Basic-auth check. Optional so WF-03 tests can build the server without it. */
    @Optional() private readonly chargePointAuth?: ChargePointAuthService,
    /**
     * ADR-0016 D-A: ân hạn trước khi orphan. Optional để test WF-03 dựng server không cần nó —
     * thiếu thì socket đóng orphan NGAY (hành vi trước T61 = ân hạn 0).
     */
    @Optional() private readonly grace?: OfflineGraceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    // Review PR #33 (quyết định 3): `@Optional()` chỉ để test WF-03 dựng server không cần service.
    // Ở app thật, thiếu ChargePointAuthService nghĩa là bắt tay OCPP KHÔNG kiểm mật khẩu (fail-open) —
    // phải kêu to lúc khởi động, không để chạy âm thầm.
    if (!this.chargePointAuth && process.env['NODE_ENV'] !== 'test') {
      this.logger.error(
        'ChargePointAuthService không có trong DI — bắt tay OCPP chạy KHÔNG kiểm credential. Kiểm tra OcppGatewayModule có import StationsModule.',
      );
    }
    const server = new RPCServer({ protocols: ['ocpp1.6'], strictMode: true });
    server.auth(async (accept, reject, handshake) => {
      if (this.chargePointAuth) {
        // WF-05 / SD-5b: unknown → 404, not onboarded or retired → 403, wrong credential → 401,
        // too many failures → 429 (issue #40).
        const clientIp = this.clientIp(handshake);
        const res = await this.chargePointAuth.verify(
          handshake.identity,
          handshake.password,
          clientIp,
        );
        if (!res.ok) {
          this.logger.warn(
            `từ chối ${handshake.identity} từ ${clientIp}: ${res.status} ${res.reason}`,
          );
          reject(res.status, res.reason);
          return;
        }
        accept({ chargePointId: res.chargePointId });
        return;
      }
      // Chỉ nhận trụ đã onboard (có dòng charge_points). Basic Auth (ADR-0011) chưa kiểm ở Iteration 1.
      const chargePointId = await this.registry.findChargePointId(handshake.identity);
      if (chargePointId === null) {
        this.logger.warn(
          `từ chối ${handshake.identity} từ ${handshake.remoteAddress ?? '?'}: chưa đăng ký`,
        );
        reject(404, 'Charge point chua dang ky');
        return;
      }
      accept({ chargePointId });
    });
    server.on('client', (client: RPCServerClient) => this.attach(client));
    server.on('error', (err: Error) => this.logger.error(`RPCServer: ${err.message}`));
    await server.listen(this.config.ocppPort);
    this.server = server;
    this.logger.log(
      `OCPP-J 1.6 lắng nghe ws://0.0.0.0:${this.config.ocppPort}/ocpp/{serialNumber}`,
    );
  }

  /**
   * IP của trụ cho bộ giới hạn đăng nhập sai. Sau Caddy (staging) `remoteAddress` là IP của Caddy,
   * nên khi OCPP_TRUST_PROXY=true lấy giá trị CUỐI của X-Forwarded-For — giá trị do Caddy thêm,
   * trụ không giả được. Không bật khi CSMS lộ thẳng ra internet: khi đó header do client tự đặt.
   */
  private clientIp(handshake: Pick<IHandshakeInterface, 'remoteAddress' | 'headers'>): string {
    if (this.config.ocppTrustProxy) {
      const xff = handshake.headers['x-forwarded-for'];
      const last = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',').pop()?.trim();
      if (last) return last;
    }
    return handshake.remoteAddress ?? 'unknown';
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.close({ code: 1001, reason: 'CSMS tat' });
    this.server = null;
  }

  /** Nối một socket vừa được xác thực vào registry, log và handler. */
  private attach(client: RPCServerClient): void {
    const identity = client.identity ?? '?';
    const remoteAddress = client.handshake.remoteAddress ?? null;

    // Mở epoch TRONG hàng đợi của identity: CALL tới trước khi open xong sẽ chờ phía sau.
    const connPromise = this.serializer.run(identity, () =>
      this.registry.open(identity, client, { remoteAddress }),
    );
    connPromise
      .then((conn) => this.syncConnectorStatus(conn))
      .catch((err: unknown) => {
        this.logger.error(`không mở được kết nối cho ${identity}: ${String(err)}`);
        void client.close({ code: 1011, reason: 'Khong mo duoc ket noi' });
      });

    client.handle(({ messageId, method, params }) => {
      const receivedAt = new Date();
      const call: InboundCall = { messageId: messageId ?? '', action: method ?? '', params };
      return this.serializer.run(identity, async () => {
        const conn = await connPromise;
        return this.processCall(conn, call, receivedAt);
      });
    });

    client.on('message', ({ message, outbound }: { message: string; outbound: boolean }) => {
      const receivedAt = new Date();
      const frame = parseFrame(message);
      if (!frame) return;
      // CALL chiều vào được ghi trong processCall (trước handler) — tránh ghi hai lần.
      if (!outbound && frame.messageType === MESSAGE_TYPE.CALL) return;
      connPromise
        .then((conn) =>
          this.messageLog.log({
            chargePointId: conn.chargePointId,
            epoch: conn.epoch,
            direction: outbound ? 'out' : 'in',
            messageType: frame.messageType,
            uniqueId: frame.uniqueId,
            action: frame.action,
            cpTimestamp: null,
            receivedAt,
            raw: frame.raw,
          }),
        )
        .catch((err: unknown) =>
          this.logger.error(`không ghi được log frame ${identity}: ${String(err)}`),
        );
    });

    client.on('strictValidationFailure', (e: StrictValidationFailureEvent) => {
      this.logger.warn(`${identity} schema ${e.method ?? '?'}: ${e.error?.message ?? '?'}`);
      // Chỉ CALL chiều vào: frame chiều ra là lỗi của chính CSMS; CALLRESULT sai schema đã có dòng thô.
      if (e.outbound || !e.isCall) return;
      const params = e.params;
      this.logRejected(identity, connPromise, new Date(), {
        messageType: MESSAGE_TYPE.CALL,
        uniqueId: e.messageId ?? '-1',
        action: e.method ?? null,
        cpTimestamp: e.method ? cpTimestampOf(e.method, params) : null,
        raw: [MESSAGE_TYPE.CALL, e.messageId ?? '-1', e.method ?? null, params ?? null],
        validationError: describeRpcError(e.error),
      });
    });
    client.on('badMessage', (e: BadMessageEvent) => {
      this.logger.warn(`${identity} bản tin hỏng: ${e.error?.message ?? '?'}`);
      const text = e.buffer ? e.buffer.toString('utf8') : '';
      const frame = parseFrame(text);
      // CALLRESULT/CALLERROR parse được đã có dòng thô từ sự kiện `message`; còn CALL hỏng (method
      // không phải chuỗi) và frame không parse được thì chưa có dòng nào → ghi ở đây.
      if (frame && frame.messageType !== MESSAGE_TYPE.CALL) return;
      this.logRejected(identity, connPromise, new Date(), {
        messageType: frame && frame.action !== null ? MESSAGE_TYPE.CALL : null,
        uniqueId: frame?.uniqueId ?? '-1',
        action: frame?.action ?? null,
        cpTimestamp: null,
        raw: frame ? frame.raw : text,
        validationError: describeRpcError(e.error),
      });
    });

    client.on('close', ({ code, reason }: { code?: number; reason?: string }) => {
      const closedAt = new Date();
      void this.serializer.run(identity, async () => {
        const conn = await this.registry.close(client, { code, reason, closedAt });
        if (!conn) return; // socket cũ đã bị thay thế — không phải trụ mất kết nối
        if (this.grace) await this.grace.onSocketClosed(conn.chargePointId, conn.epoch, closedAt);
        else await this.sessions.onStationOffline(conn.chargePointId, closedAt);
      });
    });
  }

  /**
   * Ghi một frame chiều vào bị ocpp-rpc từ chối. Lỗi ghi chỉ được log — không ném, không đóng
   * kết nối (trụ đã nhận CALLERROR; mất một dòng log tệ hơn là mất cả kết nối).
   */
  private logRejected(
    identity: string,
    connPromise: Promise<Connection>,
    receivedAt: Date,
    frame: Pick<
      MessageLogEntry,
      'messageType' | 'uniqueId' | 'action' | 'cpTimestamp' | 'raw' | 'validationError'
    >,
  ): void {
    connPromise
      .then((conn) =>
        this.messageLog.log({
          chargePointId: conn.chargePointId,
          epoch: conn.epoch,
          direction: 'in',
          receivedAt,
          ...frame,
        }),
      )
      .catch((err: unknown) =>
        this.logger.error(`không ghi được log frame bị từ chối ${identity}: ${String(err)}`),
      );
  }

  /**
   * Xử lý một CALL đã được tuần tự hoá: phân loại phát lại → ghi log → handler.
   * Public để test tích hợp phát lại trace gọi thẳng với receivedAt thật của EXP-01.
   */
  async processCall(
    conn: Connection,
    call: InboundCall,
    receivedAt: Date,
  ): Promise<Record<string, unknown>> {
    const cpTimestamp = cpTimestampOf(call.action, call.params);
    const replay = this.replayDetector.classify({
      cpTimestamp,
      receivedAt,
      epochOpenedAt: conn.epochOpenedAt,
    });
    const messageLogId = await this.messageLog.log({
      chargePointId: conn.chargePointId,
      epoch: conn.epoch,
      direction: 'in',
      messageType: MESSAGE_TYPE.CALL,
      uniqueId: call.messageId,
      action: call.action,
      cpTimestamp,
      receivedAt,
      raw: [MESSAGE_TYPE.CALL, call.messageId, call.action, call.params],
      // Không có cp_timestamp → ReplayDetector không phân loại được → null (không phải false).
      replayed: replay.skewS === null ? null : replay.replayed,
    });
    await this.registry.touch(conn, receivedAt);
    const ctx: InboundContext = {
      identity: conn.identity,
      chargePointId: conn.chargePointId,
      epoch: conn.epoch,
      epochOpenedAt: conn.epochOpenedAt,
      receivedAt,
      cpTimestamp,
      messageId: call.messageId,
      messageLogId,
      replay,
    };
    if (replay.replayed) {
      this.logger.warn(
        `▶ in  ${conn.identity} CALL ${call.action} PHÁT LẠI (${replay.reason}, skew ${replay.skewS?.toFixed(1) ?? '?'} s)`,
      );
    } else {
      this.logger.debug(`▶ in  ${conn.identity} CALL ${call.action}`);
    }
    try {
      return await this.handlers.dispatch(call.action, call.params, ctx);
    } catch (err) {
      this.logger.error(
        `handler ${call.action} của ${conn.identity} lỗi: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /** T13 2.4: epoch mới → đồng bộ trạng thái súng bằng TriggerMessage, lỗi thì chỉ log. */
  async syncConnectorStatus(conn: Connection): Promise<void> {
    for (const connectorId of [0, 1, 2]) {
      try {
        const res = await conn.client.call('TriggerMessage', {
          requestedMessage: 'StatusNotification',
          connectorId,
        });
        this.logger.log(
          `TriggerMessage StatusNotification c${connectorId} → ${JSON.stringify(res)}`,
        );
      } catch (err) {
        this.logger.warn(
          `TriggerMessage StatusNotification c${connectorId} thất bại (${err instanceof Error ? err.message : String(err)}) — bỏ qua`,
        );
      }
    }
  }
}
