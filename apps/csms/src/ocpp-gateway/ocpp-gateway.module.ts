/**
 * Module `ocpp-gateway` — tầng giao thức OCPP-J: socket, registry, log frame, tuần tự hoá, handler.
 *
 * Nhập SessionsModule (handler gọi nghiệp vụ) và ReconciliationModule (ReplayDetector). Không
 * module nào nhập ngược lại gateway (chỉ có import kiểu `InboundContext`).
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StationsModule } from '../stations/stations.module.js';
import { ConnectionRegistry } from './connection-registry.js';
import { InboundSerializer } from './inbound-serializer.js';
import { OcppHandlers } from './ocpp-handlers.js';
import { OcppMessageLogger } from './ocpp-message-logger.js';
import { OcppServer } from './ocpp-server.js';
import { OfflineGraceService } from './offline-grace.service.js';

@Module({
  imports: [DbModule, SessionsModule, ReconciliationModule, StationsModule],
  providers: [
    ConnectionRegistry,
    InboundSerializer,
    OcppMessageLogger,
    OcppHandlers,
    OfflineGraceService,
    OcppServer,
  ],
  exports: [OcppServer, ConnectionRegistry, OfflineGraceService],
})
export class OcppGatewayModule {}
