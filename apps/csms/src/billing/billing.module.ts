/**
 * BillingModule (WF-02, WP5). Phần 3: sổ cái credit và loyalty earn — export để WP3
 * (`charge-settlement`) gọi thay SQL thô (D9). Phần 12: `BackgroundWorkRunner` (worker quét DB, D7);
 * các service việc nền (Phần 7–9) gọi `register` trong `onModuleInit`.
 *
 * DbModule không @Global nên phải import (giống SessionsModule, StationsModule).
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { BackgroundWorkRunner } from './background-work.js';
import { BACKGROUND_WORK_CONFIG, loadBackgroundWorkConfig } from './background-work.config.js';
import { CreditLedgerService } from './credit-ledger.service.js';
import { LOYALTY_POLICY, loadLoyaltyPolicy } from './loyalty-policy.config.js';
import { LoyaltyService } from './loyalty.service.js';

@Module({
  imports: [DbModule],
  providers: [
    CreditLedgerService,
    LoyaltyService,
    BackgroundWorkRunner,
    { provide: LOYALTY_POLICY, useFactory: () => loadLoyaltyPolicy() },
    { provide: BACKGROUND_WORK_CONFIG, useFactory: () => loadBackgroundWorkConfig() },
  ],
  exports: [CreditLedgerService, LoyaltyService, LOYALTY_POLICY, BackgroundWorkRunner],
})
export class BillingModule {}
