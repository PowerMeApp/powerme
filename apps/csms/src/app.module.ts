/**
 * AppModule — gốc của CSMS Iteration 1: config + db + ba module nghiệp vụ.
 *
 * Chưa có HTTP API, realtime, billing (ADR-0002 modular monolith: thêm module sau, không đổi gốc).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from './config.js';
import { DbModule } from './db/db.module.js';
import { OcppGatewayModule } from './ocpp-gateway/ocpp-gateway.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { SessionsModule } from './sessions/sessions.module.js';

@Module({
  imports: [ConfigModule, DbModule, ReconciliationModule, SessionsModule, OcppGatewayModule],
})
export class AppModule {}
