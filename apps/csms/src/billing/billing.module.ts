/**
 * BillingModule (WF-02, WP5). Phần 3: sổ cái credit và loyalty earn — export để WP3
 * (`charge-settlement`) gọi thay SQL thô (D9).
 *
 * DbModule không @Global nên phải import (giống SessionsModule, StationsModule).
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { CreditLedgerService } from './credit-ledger.service.js';
import { LOYALTY_POLICY, loadLoyaltyPolicy } from './loyalty-policy.config.js';
import { LoyaltyService } from './loyalty.service.js';

@Module({
  imports: [DbModule],
  providers: [
    CreditLedgerService,
    LoyaltyService,
    { provide: LOYALTY_POLICY, useFactory: () => loadLoyaltyPolicy() },
  ],
  exports: [CreditLedgerService, LoyaltyService, LOYALTY_POLICY],
})
export class BillingModule {}
