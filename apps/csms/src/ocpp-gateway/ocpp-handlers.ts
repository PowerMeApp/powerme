/**
 * OcppHandlers — ánh xạ action OCPP 1.6 chiều vào → SessionsService (và FaultService cho
 * StatusNotification, WF-04), trả payload `.conf`.
 *
 * Vì sao tồn tại: tách "giao thức" (ở đây) khỏi "nghiệp vụ" (sessions). File này chỉ biết
 * mỗi action nhận gì và trả gì theo OCPP 1.6J; không có state machine, không có đối soát.
 * Mọi handler nhận InboundContext do OcppServer dựng SAU khi đã ghi ocpp_message_log (ADR-0005).
 *
 * Payload đã được ocpp-rpc strictMode validate theo schema OCA (ADR-0004), nên ép kiểu ở đây là
 * an toàn. Action không hỗ trợ → CALLERROR NotImplemented (như lab csms-ctl.mjs).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createRPCError } from 'ocpp-rpc';
import { CONFIG, CsmsConfig } from '../config.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { DriverChargingService } from '../sessions/driver-charging.service.js';
import { FaultService } from '../stations/faults/fault.service.js';
import type { InboundContext } from './inbound-context.js';
import type {
  AuthorizeRequest,
  BootNotificationRequest,
  MeterValuesRequest,
  StartTransactionRequest,
  StatusNotificationRequest,
  StopTransactionRequest,
} from './ocpp-types.js';

@Injectable()
export class OcppHandlers {
  private readonly logger = new Logger(OcppHandlers.name);

  constructor(
    private readonly sessions: SessionsService,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    @Optional() private readonly driverCharging?: DriverChargingService,
    /** WF-04 (FE-04). Optional để test WF-03/WF-05/T61 dựng handler không cần nó. */
    @Optional() private readonly faults?: FaultService,
  ) {}

  /** Trả payload CALLRESULT; ném lỗi (RPCError) để ocpp-rpc gửi CALLERROR. */
  async dispatch(
    action: string,
    params: unknown,
    ctx: InboundContext,
  ): Promise<Record<string, unknown>> {
    switch (action) {
      case 'BootNotification':
        return this.bootNotification(params as BootNotificationRequest, ctx);
      case 'Heartbeat':
        return { currentTime: ctx.receivedAt.toISOString() };
      case 'StatusNotification': {
        const req = params as StatusNotificationRequest;
        await this.sessions.onStatusNotification(req, ctx);
        // Sau khi đã phản chiếu connector: Faulted → sự cố, súng hoạt động lại → kết thúc sự cố
        // (STM-6). Lỗi ghi cảnh báo không được làm trụ nhận CALLERROR cho một StatusNotification đã
        // ghi xong (CSMS phản chiếu, không từ chối — T13): chỉ log, frame vẫn nằm trong
        // ocpp_message_log. Bản phát lại mang giờ trụ: sự cố ghi theo lúc nó xảy ra (review #61).
        try {
          await this.faults?.onConnectorStatus({
            chargePointId: ctx.chargePointId,
            connectorNo: req.connectorId,
            status: req.status,
            errorCode: req.errorCode,
            receivedAt: ctx.receivedAt,
            occurredAt: ctx.replay.replayed && ctx.cpTimestamp ? ctx.cpTimestamp : ctx.receivedAt,
          });
        } catch (err) {
          this.logger.error(
            `${ctx.identity} c${req.connectorId}: ghi sự cố lỗi (log id ${ctx.messageLogId}): ${String(err)}`,
          );
        }
        return {};
      }
      case 'Authorize': {
        const idTag = (params as AuthorizeRequest).idTag;
        const appStatus = await this.driverCharging?.authorizeAppTag(idTag, ctx);
        const status = appStatus ?? (await this.sessions.authorize(idTag));
        return { idTagInfo: { status } };
      }
      case 'StartTransaction': {
        const { transactionId } = await this.sessions.onStartTransaction(
          params as StartTransactionRequest,
          ctx,
        );
        // ADR-0012: phiên đã diễn ra thì luôn ghi nhận → luôn Accepted, kể cả idTag lạ.
        return { transactionId, idTagInfo: { status: 'Accepted' } };
      }
      case 'MeterValues':
        await this.sessions.onMeterValues(params as MeterValuesRequest, ctx);
        // WP3/T31: release the inbound queue before a RemoteStop can produce StopTransaction.
        if (this.driverCharging && (params as MeterValuesRequest).transactionId !== undefined) {
          const transactionNo = (params as MeterValuesRequest).transactionId!;
          setImmediate(() => {
            void this.driverCharging!.onMeter(transactionNo).catch((error) =>
              this.logger.error(`WP3/T31 limit check pending: ${String(error)}`),
            );
          });
        }
        return {};
      case 'StopTransaction':
        await this.sessions.onStopTransaction(params as StopTransactionRequest, ctx);
        try {
          await this.driverCharging?.onStopped((params as StopTransactionRequest).transactionId);
        } catch {
          // WP3/T72: the persisted stop trigger queued settlement before this best-effort attempt.
          this.logger.error('WP3/T72 stop persisted; settlement recovery will retry');
        }
        return { idTagInfo: { status: 'Accepted' } };
      case 'DataTransfer':
        // Chỉ log (đã nằm trong ocpp_message_log); chưa có nghiệp vụ vendor-specific.
        this.logger.log(`DataTransfer từ ${ctx.identity}: ${JSON.stringify(params)}`);
        return { status: 'Accepted' };
      default:
        throw createRPCError('NotImplemented', `${action} chua duoc ho tro`);
    }
  }

  private bootNotification(
    req: BootNotificationRequest,
    ctx: InboundContext,
  ): Record<string, unknown> {
    // STM-3: Boot khi đang in_service (trụ reboot) → giữ in_service; lifecycle đã do registry đặt
    // lúc socket mở. Ở Iteration 1 chỉ ghi nhận model/firmware vào log.
    this.logger.log(
      `BootNotification ${ctx.identity}: ${req.chargePointVendor} ${req.chargePointModel} fw=${req.firmwareVersion ?? '?'}`,
    );
    return {
      status: 'Accepted',
      currentTime: ctx.receivedAt.toISOString(),
      interval: this.config.heartbeatIntervalS,
    };
  }
}
