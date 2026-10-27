import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ChargeSettlementService } from './charge-settlement.service.js';

@Injectable()
export class ChargeRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChargeRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly settlement: ChargeSettlementService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // WP3/T72: the timer only wakes work; PostgreSQL retains pending jobs across restarts.
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.settlement.retryPending();
    } catch {
      this.logger.error('WP3/T72 settlement recovery unavailable; retained jobs will retry');
    } finally {
      this.running = false;
    }
  }
}
