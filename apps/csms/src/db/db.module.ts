/**
 * Module DB: cung cấp một Drizzle `db` (node-postgres Pool) cho toàn app qua token `DB`.
 *
 * Vì sao tồn tại: ADR-0008 chọn Drizzle ORM để truy vấn, migration viết tay bằng SQL trong
 * `drizzle/`. Đây là điểm duy nhất tạo Pool; service khác chỉ nhận `Db` qua DI, không tự mở
 * kết nối — để test tích hợp thay bằng DB test và để đóng Pool gọn khi tắt app.
 *
 * `Tx` là kiểu của transaction Drizzle (`db.transaction(async (tx) => ...)`); `DbExecutor` là
 * "db hoặc tx" để một hàm dùng được trong cả hai ngữ cảnh.
 */
import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { CONFIG, CsmsConfig } from '../config.js';
import * as schema from './schema/index.js';

/** Tạo db từ chuỗi kết nối — dùng chung cho app và test tích hợp. `db.$client` là Pool. */
export function createDb(connectionString: string) {
  return drizzle(new Pool({ connectionString }), { schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbExecutor = Db | Tx;

/** Token DI cho Drizzle db (dùng `@Inject(DB)`). */
export const DB = Symbol('DB');

@Module({
  providers: [
    {
      provide: DB,
      useFactory: (config: CsmsConfig) => createDb(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.$client.end();
  }
}
