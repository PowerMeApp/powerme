/**
 * PillarOnboardingService — WF-05 "Onboard a pillar and bring it into service", back-end half.
 *
 * Why it exists: FR-09 / UC-OPS-01 (operator onboards a pillar and receives its credential) and
 * the registry part of FR-15 / UC-ADM-03 (Admin registers the serial first). Build spec: CD-5 and
 * SD-5a in Report 4 §3.6; AD-8 v2.0; STM-3 #1–#2.
 *
 *   registerDevice  Admin adds a serial to the device registry          → lifecycle `registered`
 *   onboard         Operator staff links it to one of THEIR sites,     → `awaiting_connection`
 *                   creates 1–2 connectors (`Unavailable`), gets the
 *                   Basic-auth credential once
 *
 * The actor is passed as a user id and resolved from the DB (role, operator), never trusted from
 * the request body: an operator can only onboard onto its own sites (FR-09 scoping, NFR security
 * "operators see only their own data"). The HTTP controller + JWT guard come with the `users`
 * module; until then this service is driven by tests and the demo.
 *
 * Not here (declared in the PR): audit-log table (rejections are logged with Logger.warn),
 * display-code province rules beyond the site-code prefix, disable/enable/decommission endpoints
 * (STM-3 #4–#6 exist in PillarLifecyclePolicy and are unit-tested).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, like, sql } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db } from '../db/db.module.js';
import { chargePoints, connectors, operatorStaff, sites, users } from '../db/schema/index.js';
import { generatePillarPassword, hashPillarPassword } from './pillar-credential.js';
import { PillarLifecycle, PillarLifecyclePolicy } from './pillar-lifecycle-policy.js';

export type OnboardingErrorCode =
  | 'invalid_input'
  | 'forbidden_role'
  | 'site_not_found'
  | 'site_of_other_operator'
  | 'serial_already_registered'
  | 'serial_not_registered'
  | 'already_onboarded';

/** HTTP status the future controller returns for each error (SD-5a: 403 / 409). */
export const ONBOARDING_ERROR_STATUS: Record<OnboardingErrorCode, 400 | 403 | 404 | 409> = {
  invalid_input: 400,
  forbidden_role: 403,
  site_not_found: 404,
  site_of_other_operator: 403,
  serial_already_registered: 409,
  serial_not_registered: 409,
  already_onboarded: 409,
};

export class OnboardingError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(
    readonly code: OnboardingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingError';
    this.status = ONBOARDING_ERROR_STATUS[code];
  }
}

export interface RegisterDeviceInput {
  serialNumber: string;
  model?: string | null;
  ratedPowerKw?: number | null;
}

export interface ConnectorInput {
  connectorNo: number;
  connectorType?: 'ccs2' | 'chademo' | 'gbt' | 'type2';
  maxPowerKw?: number | null;
}

export interface OnboardInput {
  serialNumber: string;
  siteId: number;
  connectors: ConnectorInput[];
}

export interface OnboardResult {
  chargePointId: number;
  displayCode: string;
  lifecycle: PillarLifecycle;
  /** Where the pillar must connect: `{ocppBaseUrl}/{serialNumber}`. */
  ocppUrl: string;
  /** Basic-auth user name = OCPP identity = serial number. */
  identity: string;
  /** Basic-auth password, shown ONCE (only the hash is stored). */
  password: string;
}

/** OCPP identity rules: printable ASCII without ':' (it is also the Basic-auth user name). */
const SERIAL_RE = /^[A-Za-z0-9._-]{3,48}$/;

@Injectable()
export class PillarOnboardingService {
  private readonly logger = new Logger(PillarOnboardingService.name);
  private readonly policy = new PillarLifecyclePolicy();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
  ) {}

  /** UC-ADM-03: Admin adds a serial to the registry (STM-3 #1). */
  async registerDevice(adminUserId: number, input: RegisterDeviceInput) {
    await this.requireRole(adminUserId, 'admin');
    const serialNumber = input.serialNumber?.trim() ?? '';
    if (!SERIAL_RE.test(serialNumber)) {
      throw new OnboardingError('invalid_input', 'serialNumber must be 3–48 chars [A-Za-z0-9._-]');
    }
    const lifecycle = this.policy.transition(null, 'REGISTER');
    const [row] = await this.db
      .insert(chargePoints)
      .values({
        serialNumber,
        model: input.model ?? null,
        ratedPowerKw: input.ratedPowerKw == null ? null : String(input.ratedPowerKw),
        lifecycle,
      })
      .onConflictDoNothing({ target: chargePoints.serialNumber })
      .returning({ id: chargePoints.id, lifecycle: chargePoints.lifecycle });
    if (!row) {
      throw new OnboardingError(
        'serial_already_registered',
        `${serialNumber} is already registered`,
      );
    }
    this.logger.log(`registry: ${serialNumber} registered by admin ${adminUserId}`);
    return { chargePointId: row.id, serialNumber, lifecycle: row.lifecycle };
  }

  /** UC-OPS-01 / SD-5a: operator staff onboard a registered pillar (STM-3 #2). */
  async onboard(staffUserId: number, input: OnboardInput): Promise<OnboardResult> {
    const operatorId = await this.operatorOf(staffUserId);
    const serialNumber = input.serialNumber?.trim() ?? '';
    this.validateConnectors(input.connectors);

    const [site] = await this.db
      .select({ id: sites.id, operatorId: sites.operatorId, siteCode: sites.siteCode })
      .from(sites)
      .where(eq(sites.id, input.siteId))
      .limit(1);
    if (!site) {
      this.reject(staffUserId, serialNumber, 'site_not_found');
      throw new OnboardingError('site_not_found', `site ${input.siteId} does not exist`);
    }
    if (site.operatorId !== operatorId) {
      this.reject(staffUserId, serialNumber, 'site_of_other_operator');
      throw new OnboardingError('site_of_other_operator', 'site belongs to another operator');
    }

    const password = generatePillarPassword();
    const passwordHash = await hashPillarPassword(password);

    const result = await this.db
      .transaction(async (tx) => {
        // Row lock: two staff onboarding the same serial at once → the second sees awaiting_connection.
        const [cp] = await tx
          .select({
            id: chargePoints.id,
            lifecycle: chargePoints.lifecycle,
            model: chargePoints.model,
          })
          .from(chargePoints)
          .where(eq(chargePoints.serialNumber, serialNumber))
          .for('update')
          .limit(1);
        if (!cp) {
          throw new OnboardingError(
            'serial_not_registered',
            `${serialNumber} is not in the registry`,
          );
        }
        if (!this.policy.canApply(cp.lifecycle, 'ONBOARD')) {
          throw new OnboardingError(
            'already_onboarded',
            `${serialNumber} is ${cp.lifecycle}, only a registered pillar can be onboarded`,
          );
        }
        const lifecycle = this.policy.transition(cp.lifecycle, 'ONBOARD');
        const displayCode = await this.nextDisplayCode(tx, cp.model, site.siteCode);
        await tx
          .update(chargePoints)
          .set({
            siteId: site.id,
            lifecycle,
            displayCode,
            basicAuthPasswordHash: passwordHash,
            updatedAt: new Date(),
          })
          .where(eq(chargePoints.id, cp.id));
        await tx.insert(connectors).values(
          input.connectors.map((c) => ({
            chargePointId: cp.id,
            connectorNo: c.connectorNo,
            connectorType: c.connectorType ?? 'ccs2',
            maxPowerKw: c.maxPowerKw == null ? null : String(c.maxPowerKw),
            status: 'Unavailable' as const,
          })),
        );
        return { chargePointId: cp.id, displayCode, lifecycle };
      })
      .catch((err: unknown) => {
        if (err instanceof OnboardingError) this.reject(staffUserId, serialNumber, err.code);
        throw err;
      });

    this.logger.log(
      `onboard: ${serialNumber} → site ${site.siteCode} (${result.displayCode}) by staff ${staffUserId}`,
    );
    return {
      ...result,
      ocppUrl: `${this.ocppBaseUrl()}/${serialNumber}`,
      identity: serialNumber,
      password,
    };
  }

  private ocppBaseUrl(): string {
    const base = this.config.ocppPublicUrl ?? `ws://localhost:${this.config.ocppPort}/ocpp`;
    return base.replace(/\/+$/, '');
  }

  private validateConnectors(list: ConnectorInput[] | undefined): void {
    if (!Array.isArray(list) || list.length < 1 || list.length > 2) {
      throw new OnboardingError('invalid_input', 'a pillar has 1 or 2 connectors');
    }
    const nos = list.map((c) => c.connectorNo);
    if (nos.some((n) => n !== 1 && n !== 2) || new Set(nos).size !== nos.length) {
      throw new OnboardingError('invalid_input', 'connectorNo must be 1 or 2, without duplicates');
    }
  }

  /**
   * `PM-{model}-{province}-{nnnn}` (ADR-0009). Model = text before the first '-' of the model
   * (D1-120 → D1); province = text before the first '-' of the site code (HCM-DEMO-01 → HCM).
   */
  private async nextDisplayCode(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    model: string | null,
    siteCode: string,
  ): Promise<string> {
    const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = clean((model ?? '').split('-')[0] ?? '') || 'XX';
    const prov = clean(siteCode.split('-')[0] ?? '') || 'VN';
    const [agg] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(chargePoints)
      .where(like(chargePoints.displayCode, `PM-%-${prov}-%`));
    const seq = String(Number(agg?.n ?? 0) + 1).padStart(4, '0');
    return `PM-${m}-${prov}-${seq}`;
  }

  private async requireRole(userId: number, role: 'admin' | 'operator_staff'): Promise<void> {
    const [u] = await this.db
      .select({ role: users.role, status: users.accountStatus })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u || u.role !== role || u.status !== 'active') {
      throw new OnboardingError('forbidden_role', `user ${userId} is not an active ${role}`);
    }
  }

  private async operatorOf(staffUserId: number): Promise<number> {
    const [row] = await this.db
      .select({ operatorId: operatorStaff.operatorId })
      .from(operatorStaff)
      .innerJoin(users, eq(users.id, operatorStaff.userId))
      .where(and(eq(operatorStaff.userId, staffUserId), eq(users.accountStatus, 'active')))
      .limit(1);
    if (!row) {
      throw new OnboardingError(
        'forbidden_role',
        `user ${staffUserId} is not active operator staff`,
      );
    }
    return row.operatorId;
  }

  private reject(userId: number, serial: string, code: OnboardingErrorCode): void {
    this.logger.warn(`onboard rejected: ${code} (staff ${userId}, serial "${serial}")`);
  }
}
