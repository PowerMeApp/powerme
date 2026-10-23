/**
 * Module `reconciliation` — engine đối soát (BE-07) và ReplayDetector.
 *
 * ReplayDetector được cung cấp ở đây (lớp thuần, khởi tạo với REPLAY_SKEW_THRESHOLD_S) và
 * export để `ocpp-gateway` phân loại frame ngay lúc tới; ReconciliationService export cho
 * `sessions`. Chiều phụ thuộc: ocpp-gateway → sessions → reconciliation (không vòng).
 */
import { Module } from '@nestjs/common';
import { CONFIG, CsmsConfig } from '../config.js';
import { DbModule } from '../db/db.module.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReplayDetector } from './replay-detector.js';

@Module({
  imports: [DbModule],
  providers: [
    ReconciliationService,
    {
      provide: ReplayDetector,
      useFactory: (config: CsmsConfig) => new ReplayDetector(config.replaySkewThresholdS),
      inject: [CONFIG],
    },
  ],
  exports: [ReconciliationService, ReplayDetector],
})
export class ReconciliationModule {}
