/**
 * PillarAuthService — decides at the WebSocket upgrade whether a pillar may connect (SD-5b
 * steps 1–4, AD-8 "unknown identity or wrong credential → reject and log").
 *
 * Rules, in order:
 *   1. identity not in `charge_points`                   → 404 (unchanged from Iteration 1)
 *   2. lifecycle `registered` (not onboarded) or
 *      `decommissioned` (retired)                        → 403
 *   3. a credential was issued at onboarding (hash set) → Basic-auth password must match, else 401
 *   4. no credential on file (pillars seeded before WF-05, e.g. demo/seed.sql):
 *        - `ALLOW_LEGACY_NO_CREDENTIAL=true`  → accepted with a warning (demo, WF-03 trace)
 *        - otherwise (default)                → 401. Anyone who knows the serial could connect, so
 *          this stays off outside the demo (review of PR #33, decision 2).
 *
 * The STM-3 #3 move `awaiting_connection → in_service` happens in ConnectionRegistry.open() when
 * the socket is accepted (WP2 design: a reconnecting pillar does not always send BootNotification).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import { chargePoints } from '../db/schema/index.js';
import { verifyPillarPassword } from './pillar-credential.js';
import { PillarLifecyclePolicy } from './pillar-lifecycle-policy.js';

export type PillarAuthResult =
  | { ok: true; chargePointId: number; credentialChecked: boolean }
  | { ok: false; status: 401 | 403 | 404; reason: string };

@Injectable()
export class PillarAuthService {
  private readonly logger = new Logger(PillarAuthService.name);
  private readonly policy = new PillarLifecyclePolicy();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
  ) {}

  async verify(identity: string, password: Buffer | string | undefined): Promise<PillarAuthResult> {
    const [cp] = await this.db
      .select({
        id: chargePoints.id,
        lifecycle: chargePoints.lifecycle,
        hash: chargePoints.basicAuthPasswordHash,
      })
      .from(chargePoints)
      .where(eq(chargePoints.serialNumber, identity))
      .limit(1);
    if (!cp) return { ok: false, status: 404, reason: 'Charge point chua dang ky' };
    if (!this.policy.mayConnect(cp.lifecycle)) {
      return {
        ok: false,
        status: 403,
        reason:
          cp.lifecycle === 'registered'
            ? 'Charge point not onboarded'
            : 'Charge point decommissioned',
      };
    }
    if (cp.hash) {
      const match = await verifyPillarPassword(password ?? null, cp.hash);
      if (!match) return { ok: false, status: 401, reason: 'Invalid credential' };
      return { ok: true, chargePointId: cp.id, credentialChecked: true };
    }
    if (!this.config.allowLegacyNoCredential) {
      return { ok: false, status: 401, reason: 'No credential on file' };
    }
    this.logger.warn(
      `${identity}: no credential on file (onboarded before WF-05) — accepted without Basic auth (ALLOW_LEGACY_NO_CREDENTIAL=true)`,
    );
    return { ok: true, chargePointId: cp.id, credentialChecked: false };
  }
}
