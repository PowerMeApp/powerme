/**
 * ConsoleServer — provider Nest mở cổng HTTP của bảng điều khiển bằng `node:http` thuần
 * (không @nestjs/platform-express, không thêm dependency), cùng kiểu vòng đời với OcppServer:
 * mở ở onModuleInit, đóng ở onModuleDestroy.
 *
 * CHƯA CÓ XÁC THỰC — xem console.http.ts. Vì vậy chỉ bind `config.consoleHost`
 * (mặc định 127.0.0.1). Tắt hẳn bằng CONSOLE_ENABLED=false. Nếu cổng bận, CSMS vẫn chạy và
 * chỉ log lỗi (console là phần phụ, không được kéo sập gateway OCPP).
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONFIG, CsmsConfig } from '../config.js';
import { ConsoleCommands } from './console.commands.js';
import { createConsoleListener } from './console.http.js';
import { ConsoleQueries } from './console.queries.js';

@Injectable()
export class ConsoleServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsoleServer.name);
  private server: Server | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: CsmsConfig,
    private readonly queries: ConsoleQueries,
    private readonly commands: ConsoleCommands,
  ) {}

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
    const server = createServer(
      createConsoleListener({
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
      }),
    );
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
