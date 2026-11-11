/**
 * ConsoleServer — provider Nest mở cổng HTTP của bảng điều khiển bằng `node:http` thuần
 * (không @nestjs/platform-express, không thêm dependency), cùng kiểu vòng đời với OcppServer:
 * mở ở onModuleInit, đóng ở onModuleDestroy.
 *
 * CHƯA CÓ XÁC THỰC — xem console.http.ts. Vì vậy chỉ bind `config.consoleHost`
 * (mặc định 127.0.0.1). Tắt hẳn bằng CONSOLE_ENABLED=false. Nếu cổng bận, CSMS vẫn chạy và
 * chỉ log lỗi (console là phần phụ, không được kéo sập gateway OCPP).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONFIG, CsmsConfig } from '../config.js';
import { ConsoleCommands } from './console.commands.js';
import { ConsoleError, createConsoleListener } from './console.http.js';
import { ConsoleQueries } from './console.queries.js';
import { TopUpService } from '../billing/top-up.service.js';
import { createDriverListener } from '../driver/driver.http.js';
import { createOperatorApiListener, OPERATOR_API_PATH } from '../operator-api/operator-api.http.js';
import { DB, Db } from '../db/db.module.js';
import { DriverChargingService } from '../sessions/driver-charging.service.js';
import { ChargePointOnboardingService } from '../stations/charge-point-onboarding.service.js';
import { FaultService } from '../stations/faults/fault.service.js';

@Injectable()
export class ConsoleServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleServer.name);
  private server: Server | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly queries: ConsoleQueries,
    private readonly commands: ConsoleCommands,
    @Optional() @Inject(DB) private readonly db?: Db,
    @Optional() private readonly driver?: DriverChargingService,
    @Optional() private readonly onboarding?: ChargePointOnboardingService,
    /** T32 Phần 5: route top-up của tài xế (BillingModule). */
    @Optional() private readonly topUps?: TopUpService,
    /** FE-17: driver fault reports (UC-CHG-05) on the Driver API. */
    @Optional() private readonly faults?: FaultService,
  ) {}

  /** WF-05 (T119): the onboarding service, or 503 when this server was built without it (tests). */
  private onboardingService(): ChargePointOnboardingService {
    if (!this.onboarding) {
      throw new ConsoleError(503, 'onboarding_unavailable', 'Onboarding service not wired');
    }
    return this.onboarding;
  }

  /** Cổng thực tế đang nghe (khác config khi consolePort = 0); null nếu chưa mở. */
  get port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? (addr as AddressInfo).port : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.consoleEnabled) {
      this.logger.log('Bảng điều khiển tắt (CONSOLE_ENABLED=false)');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Public để test tích hợp bật console trên cổng ngẫu nhiên. Lỗi nghe cổng → log, không ném. */
  async start(): Promise<void> {
    // WP3: the shared port still hosts unauthenticated admin operations.
    if (
      !['127.0.0.1', '::1'].includes(this.config.consoleHost) &&
      !this.config.consoleAllowNonLoopback
    )
      throw new Error(
        'Console and Driver shared listener requires a loopback bind (or CONSOLE_ALLOW_NON_LOOPBACK=true behind a closed network)',
      );
    const admin = createConsoleListener(
      {
        health: () => this.queries.health(),
        stations: () => this.queries.stations(),
        sessions: (limit) => this.queries.sessions(limit),
        session: (id) => this.queries.session(id),
        reconciliation: (limit) => this.queries.reconciliation(limit),
        messages: (limit, after) => this.queries.messages(limit, after),
        summary: () => this.queries.summary(),
        disconnect: (serial) => this.commands.disconnect(serial),
        remoteStop: (id) => this.commands.remoteStop(id),
        faults: (filter, limit) => this.commands.faults(filter, limit),
        acknowledgeFault: (id) => this.commands.acknowledgeFault(id),
        resetFault: (id, type, force) => this.commands.resetFault(id, type, force),
        closeFault: (id) => this.commands.closeFault(id),
        unattributedQueue: (limit) => this.commands.unattributedQueue(limit),
        reviewQueue: (limit) => this.commands.reviewQueue(limit),
        assignUnattributed: (id, input) => this.commands.assignUnattributed(id, input),
        closeUnattributed: (id, input) => this.commands.closeUnattributed(id, input),
        resolveReview: (id, input) => this.commands.resolveReview(id, input),
        registerChargePoint: async (adminId, input) => {
          const r = await this.onboardingService().registerDevice(adminId, input);
          return {
            charge_point_id: r.chargePointId,
            serial_number: r.serialNumber,
            lifecycle: r.lifecycle,
          };
        },
        onboardChargePoint: async (staffId, input) => {
          const r = await this.onboardingService().onboard(staffId, input);
          return {
            charge_point_id: r.chargePointId,
            display_code: r.displayCode,
            lifecycle: r.lifecycle,
            ocpp_url: r.ocppUrl,
            identity: r.identity,
            password: r.password,
          };
        },
      },
      {
        adminUserId: this.config.consoleActorAdminId ?? null,
        staffUserId: this.config.consoleActorStaffId ?? null,
      },
    );
    const driver =
      this.db && this.driver
        ? createDriverListener(
            this.db,
            this.driver,
            this.config.driverApi ?? { devAuth: false },
            undefined,
            undefined,
            this.topUps,
            this.faults,
          )
        : null;
    // FE-01a: /api/{auth,operator,admin}/v1 → operator-api (JWT, ADR-0018). Matched before the
    // console so `/api/admin/v1/*` never reaches the unauthenticated `/api/admin/*` routes.
    const operatorApi = this.db
      ? createOperatorApiListener(
          this.db,
          this.config.dashboardAuth ?? {},
          this.config.driverApi ?? { devAuth: false },
        )
      : null;
    const server = createServer((req, res) => {
      if (OPERATOR_API_PATH.test(req.url ?? '')) {
        if (operatorApi) operatorApi(req, res);
        else {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(
            JSON.stringify({ error: 'auth_unavailable', detail: 'Operator API unavailable' }),
          );
        }
      } else if (/^\/api\/driver(?:\/|\?|$)/.test(req.url ?? '')) {
        if (driver) driver(req, res);
        else {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'auth_unavailable', detail: 'Driver API unavailable' }));
        }
      } else admin(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.consolePort, this.config.consoleHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.logger.error(
        `không mở được bảng điều khiển ${this.config.consoleHost}:${this.config.consolePort}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.server = server;
    this.logger.log(
      `Bảng điều khiển http://${this.config.consoleHost}:${this.port} (demo, CHƯA có xác thực)`,
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
