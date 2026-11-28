/**
 * BillingModule (WF-02, WP5). Phần 3: sổ cái credit và loyalty earn — export để WP3
 * (`charge-settlement`) gọi thay SQL thô (D9). Phần 12: `BackgroundWorkRunner` (worker quét DB, D7);
 * các service việc nền (Phần 7–9) gọi `register` trong `onModuleInit`. Phần 5: `TopUpService`
 * (tạo top-up, SD-2a) + `VnpayAdapter`, cấu hình `VNPAY_CONFIG`. Phần 8: `TopUpService` tự đăng ký việc nền
 * `top-up-timeout` (querydr), cấu hình gọi API `VNPAY_API_CONFIG`. Phần 7: `EInvoiceService` (tạo hoá
 * đơn trong transaction cộng tiền, việc nền `e-invoice-issue`) + nhà cung cấp `E_INVOICE_PROVIDER`
 * (T144: `EINVOICE_PROVIDER=stub` mặc định | `sepay`, sai cấu hình thì không khởi động).
 * `RefundService`: hoàn tiền thủ công (D1, D-AC), Admin ghi nhận confirm / fail / redo; không có việc
 * nền refund. Phần 9b: `InvoiceAdjustmentService` (việc nền `invoice-adjustment-issue`, gửi điều chỉnh
 * hoá đơn khi hoàn tiền); `RefundService` được tiêm `EInvoiceService` để tạo điều chỉnh trong
 * transaction ghi nhận `done`.
 *
 * DbModule không @Global nên phải import (giống SessionsModule, StationsModule).
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { BackgroundWorkRunner } from './background-work.js';
import { BACKGROUND_WORK_CONFIG, loadBackgroundWorkConfig } from './background-work.config.js';
import { CreditLedgerService } from './credit-ledger.service.js';
import { E_INVOICE_PROVIDER } from './e-invoice-provider.js';
import { EInvoiceService } from './e-invoice.service.js';
import { InvoiceAdjustmentService } from './invoice-adjustment.service.js';
import { LOYALTY_POLICY, loadLoyaltyPolicy } from './loyalty-policy.config.js';
import { LoyaltyService } from './loyalty.service.js';
import { RefundService } from './refund.service.js';
import { createEInvoiceProvider } from './sepay-einvoice.config.js';
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
    EInvoiceService,
    InvoiceAdjustmentService,
    RefundService,
    { provide: E_INVOICE_PROVIDER, useFactory: () => createEInvoiceProvider() },
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
    // Phần 7: Admin retry hoá đơn (route ở Phần 10).
    EInvoiceService,
    // Hoàn tiền thủ công: route Admin ghi nhận confirm / fail / redo (operator-api).
    RefundService,
    // Phần 9b: Admin retry điều chỉnh hoá đơn (route ở PR sau).
    InvoiceAdjustmentService,
  ],
})
export class BillingModule {}
