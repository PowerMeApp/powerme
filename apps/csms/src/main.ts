/**
 * Điểm vào CSMS. Iteration 1 chưa có HTTP, nên dùng application context của Nest (không
 * platform-express): DI + vòng đời (OcppServer mở cổng ở onApplicationBootstrap, đóng ở shutdown).
 *
 * Chạy: `npm run build -w @powerme/csms && npm run start -w @powerme/csms` với DATABASE_URL,
 * OCPP_PORT (xem infra/.env.example). Trụ nối tới ws://host:OCPP_PORT/ocpp/{serialNumber}.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  await app.init();
  new Logger('main').log('CSMS Iteration 1 sẵn sàng (gateway + sessions + reconciliation)');
}

bootstrap().catch((err: unknown) => {
  new Logger('main').error(
    `không khởi động được: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
