/**
 * OcppHandlers — ánh xạ action OCPP 1.6 chiều vào → SessionsService, trả payload `.conf`.
 *
 * Vì sao tồn tại: tách "giao thức" (ở đây) khỏi "nghiệp vụ" (sessions). File này chỉ biết
 * mỗi action nhận gì và trả gì theo OCPP 1.6J; không có state machine, không có đối soát.
 * Mọi handler nhận InboundContext do OcppServer dựng SAU khi đã ghi ocpp_message_log (ADR-0005).
 *
 * Payload đã được ocpp-rpc strictMode validate theo schema OCA (ADR-0004), nên ép kiểu ở đây là
 * an toàn. Action không hỗ trợ → CALLERROR NotImplemented (như lab csms-ctl.mjs).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRPCError } from 'ocpp-rpc';
import { CONFIG, CsmsConfig } from '../config.js';
import { SessionsService } from '../sessions/sessions.service.js';
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
      case 'StatusNotification':
        await this.sessions.onStatusNotification(params as StatusNotificationRequest, ctx);
        return {};
      case 'Authorize': {
        const status = await this.sessions.authorize((params as AuthorizeRequest).idTag);
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
        return {};
      case 'StopTransaction':
        await this.sessions.onStopTransaction(params as StopTransactionRequest, ctx);
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
