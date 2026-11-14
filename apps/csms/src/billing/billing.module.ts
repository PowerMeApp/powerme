/**
 * BillingModule (WF-02, WP5). Phần 3: sổ cái credit và loyalty earn — export để WP3
 * (`charge-settlement`) gọi thay SQL thô (D9). Phần 12: `BackgroundWorkRunner` (worker quét DB, D7);
 * các service việc nền (Phần 7–9) gọi `register` trong `onModuleInit`. Phần 5: `TopUpService`
 * (tạo top-up, SD-2a) + `VnpayAdapter`, cấu hình `VNPAY_CONFIG`. Phần 8: `TopUpService` tự đăng ký việc nền
 * `top-up-timeout` (querydr), cấu hình gọi API `VNPAY_API_CONFIG`.
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
import { TopUpService } from './top-up.service.js';
import { VnpayAdapter } from './vnpay.adapter.js';
import {
  loadVnpayApiConfig,
  loadVnpayConfig,
  VNPAY_API_CONFIG,
  VNPAY_CONFIG,
} from './vnpay.config.js';

@Module({
  imports: [DbModule],
  providers: [
    CreditLedgerService,
    LoyaltyService,
    BackgroundWorkRunner,
    TopUpService,
    VnpayAdapter,
    { provide: LOYALTY_POLICY, useFactory: () => loadLoyaltyPolicy() },
    { provide: BACKGROUND_WORK_CONFIG, useFactory: () => loadBackgroundWorkConfig() },
    { provide: VNPAY_CONFIG, useFactory: () => loadVnpayConfig() },
    { provide: VNPAY_API_CONFIG, useFactory: () => loadVnpayApiConfig() },
  ],
  exports: [
    CreditLedgerService,
    LoyaltyService,
    LOYALTY_POLICY,
    BackgroundWorkRunner,
    // Phần 5: route tài xế (driver/top-ups.http.ts) qua ConsoleServer.
    TopUpService,
  ],
})
export class BillingModule {}
