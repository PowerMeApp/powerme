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
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [DbModule, ReconciliationModule],
  providers: [SessionStateMachine, SessionsService],
  exports: [SessionsService, SessionStateMachine],
})
export class SessionsModule {}
