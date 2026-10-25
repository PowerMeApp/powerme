/**
 * Module `stations` — pillar registry and onboarding (WF-05, owner Trần Đức Ân, WP1).
 *
 * This first slice holds the onboarding service and the connection check used by ocpp-gateway.
 * Per ADR-0016 D-F, Nghĩa's FaultService and the remote-command service also live in `stations`
 * when they land; the gateway depends on this module, never the other way round.
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { PillarAuthService } from './pillar-auth.service.js';
import { PillarOnboardingService } from './pillar-onboarding.service.js';

@Module({
  imports: [DbModule],
  providers: [PillarOnboardingService, PillarAuthService],
  exports: [PillarOnboardingService, PillarAuthService],
})
export class StationsModule {}
