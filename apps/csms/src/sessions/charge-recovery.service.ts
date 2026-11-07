import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ChargeSettlementService } from './charge-settlement.service.js';
import { DriverChargingService } from './driver-charging.service.js';

@Injectable()
export class ChargeRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChargeRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly settlement: ChargeSettlementService,
    private readonly driverCharging: DriverChargingService,
  ) {}

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
    }
    try {
      // BE-17: RemoteStop timeout → gửi lại có giới hạn; trạng thái nằm trong DB nên restart không mất.
      await this.driverCharging.retryUnknownStops();
    } catch {
      this.logger.error('BE-17 stop retry sweep unavailable; unknown stops will be retried');
    } finally {
      this.running = false;
    }
  }
}
