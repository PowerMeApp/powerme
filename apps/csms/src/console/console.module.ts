/**
 * Module `console` (BE-08) — bảng điều khiển vận hành demo: vài endpoint HTTP chỉ-đọc, hai lệnh
 * điều khiển và một trang web một file. CHƯA CÓ XÁC THỰC (RolesGuard là việc sau — ADR-0011).
 *
 * Nhập DbModule (Drizzle), OcppGatewayModule (ConnectionRegistry để biết trụ nào đang nối và
 * để đóng socket / gửi RemoteStop, Reset) và StationsModule (FaultService — WF-04, FE-04).
 * Không module nào nhập ngược lại console.
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { OcppGatewayModule } from '../ocpp-gateway/ocpp-gateway.module.js';
import { StationsModule } from '../stations/stations.module.js';
import { ConsoleCommands } from './console.commands.js';
import { ConsoleQueries } from './console.queries.js';
import { ConsoleServer } from './console.server.js';

@Module({
  imports: [DbModule, OcppGatewayModule, StationsModule],
  providers: [ConsoleQueries, ConsoleCommands, ConsoleServer],
})
export class ConsoleModule {}
