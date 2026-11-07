/**
 * Module `stations` — charge point registry and onboarding (WF-05, owner Trần Đức Ân, WP1).
 *
 * This first slice holds the onboarding service and the connection check used by ocpp-gateway.
 * Per ADR-0016 D-F, Nghĩa's FaultService (WF-04, FE-04) lives here too: the gateway calls it on
 * StatusNotification and the console calls it for acknowledge / reset / close. The gateway depends
 * on this module, never the other way round, so sending the Reset CALL stays with the caller.
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { FaultService } from './faults/fault.service.js';
import { OfflineAlertService } from './faults/offline-alert.service.js';
import { ChargePointAuthService } from './charge-point-auth.service.js';
import { ChargePointLoginLimiter } from './charge-point-login-limiter.js';
import { ChargePointOnboardingService } from './charge-point-onboarding.service.js';

@Module({
  imports: [DbModule],
  providers: [
    ChargePointOnboardingService,
    ChargePointAuthService,
    { provide: ChargePointLoginLimiter, useFactory: () => new ChargePointLoginLimiter() },
    FaultService,
    // G10: quét trụ im lặng quá OFFLINE_ALERT_S → sự cố Offline (NFR-OCPP-07).
    OfflineAlertService,
  ],
  exports: [ChargePointOnboardingService, ChargePointAuthService, FaultService],
})
export class StationsModule {}
