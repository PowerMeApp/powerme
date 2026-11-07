import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:net';
import { AppModule } from '../src/app.module.js';
import { createDb } from '../src/db/db.module.js';
import {
  CHARGE_POLICY,
  ChargeSettlementService,
} from '../src/sessions/charge-settlement.service.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { ChargeRecoveryService } from '../src/sessions/charge-recovery.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('WP3/T72 actual Nest charging composition', () => {
  it('starts the application with validated policy, OCPP gateway and durable recovery worker', async () => {
    if (!url || new URL(url).pathname !== '/powerme_test') throw new Error('requires powerme_test');
    const db = createDb(url);
    await resetAndMigrate(db.$client);
    await db.$client.end();
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const names = ['OCPP_PORT', 'CONSOLE_ENABLED', 'CHARGE_MINIMUM_START_VND'];
    const saved = names.map((name) => process.env[name]);
    process.env['OCPP_PORT'] = String(port);
    process.env['CONSOLE_ENABLED'] = 'false';
    process.env['CHARGE_MINIMUM_START_VND'] = '60000';
    Logger.overrideLogger(['error']);
    try {
      const app = await NestFactory.createApplicationContext(AppModule, {
        logger: ['error'],
        abortOnError: false,
      });
      try {
        expect(app.get(CHARGE_POLICY).minimumStartVnd).toBe(60000);
        expect(app.get(DriverChargingService)).toBeInstanceOf(DriverChargingService);
        expect(app.get(ChargeSettlementService)).toBeInstanceOf(ChargeSettlementService);
        expect(app.get(ChargeRecoveryService)).toBeInstanceOf(ChargeRecoveryService);
        await app.get(ChargeRecoveryService).tick();
      } finally {
        await app.close();
      }
    } finally {
      names.forEach((name, index) =>
        saved[index] === undefined ? delete process.env[name] : (process.env[name] = saved[index]),
      );
    }
  });
});
