/**
 * Module `sessions` — phiên sạc, chuỗi đo, trạng thái connector (STM-1, STM-2).
 *
 * SessionStateMachine là provider thuần (không phụ thuộc gì); SessionsService cần db và
 * ReconciliationService. Export SessionsService cho `ocpp-gateway`.
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { SessionStateMachine } from './session-state-machine.js';
import { CHARGE_POLICY } from './charge-settlement.service.js';
import { loadChargePolicy } from './charge-policy.config.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [DbModule, ReconciliationModule],
  providers: [
    SessionStateMachine,
    SessionsService,
    { provide: CHARGE_POLICY, useFactory: () => loadChargePolicy() },
  ],
  exports: [SessionsService, SessionStateMachine],
})
export class SessionsModule {}
