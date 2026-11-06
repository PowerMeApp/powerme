/**
 * AppModule — gốc của CSMS Iteration 1: config + db + ba module nghiệp vụ.
 *
 * ConsoleModule (BE-08) là bảng điều khiển vận hành demo: HTTP thuần, chưa xác thực. Chưa có
 * API công khai, realtime. BillingModule (WF-02) hiện chỉ có sổ cái credit/loyalty (ADR-0002 modular monolith: thêm module sau, không đổi gốc).
 */
import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module.js';
import { ConfigModule } from './config.js';
import { ConsoleModule } from './console/console.module.js';
import { DbModule } from './db/db.module.js';
import { OcppGatewayModule } from './ocpp-gateway/ocpp-gateway.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { StationsModule } from './stations/stations.module.js';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    ReconciliationModule,
    SessionsModule,
    StationsModule,
    BillingModule,
    OcppGatewayModule,
    ConsoleModule,
  ],
})
export class AppModule {}
