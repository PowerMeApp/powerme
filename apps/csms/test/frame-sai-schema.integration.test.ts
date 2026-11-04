/**
 * Test tích hợp G12 / BM02 F42 — frame sai schema phải vào `ocpp_message_log`.
 *
 * Vì sao tồn tại: ocpp-rpc ở strict mode loại CALL sai schema TRƯỚC handler nên trước đây nhật ký
 * không có chúng, trái với tuyên bố "mọi frame nhận được đều được ghi". Test dùng server thật
 * (cổng thật) + client `ocpp-rpc` thật (strictMode TẮT ở phía client để nó gửi được frame sai) +
 * Postgres thật, rồi khẳng định:
 *   - frame đúng vẫn ghi đúng một dòng, validation_error NULL (như cũ);
 *   - CALL sai schema: đúng một dòng 'in' mang validation_error, trụ nhận CALLERROR, dòng CALLERROR
 *     chiều ra cũng được ghi, kết nối còn sống, handler KHÔNG chạy;
 *   - frame không phải JSON: một dòng message_type NULL, raw là chuỗi nguyên văn;
 *   - lỗi ghi log của frame bị từ chối không làm sập kết nối.
 *
 * Cần DATABASE_URL (DROP SCHEMA public — dùng DB `powerme_test`); thiếu thì skip.
 */
import { createServer } from 'node:net';
import { Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { RPCClient } from 'ocpp-rpc';
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { chargePoints, ocppMessageLog, sessions } from '../src/db/schema/index.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`không thấy: ${what}`);
}

describeDb('G12 — frame sai schema được ghi vào ocpp_message_log', () => {
  let db: Db;
  let server: OcppServer;
  let client: RPCClient;
  let logger: OcppMessageLogger;
  let chargePointId: number;

  async function rows() {
    return db
      .select()
      .from(ocppMessageLog)
      .where(eq(ocppMessageLog.chargePointId, chargePointId))
      .orderBy(asc(ocppMessageLog.id));
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: 'G12-PILLAR', model: 'D1-120', lifecycle: 'awaiting_connection' })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    chargePointId = cp.id;

    const config: CsmsConfig = {
      databaseUrl: DATABASE_URL as string,
      ocppPort: await freePort(),
      heartbeatIntervalS: 300,
      sessionStartTimeoutS: 120,
      sessionHardCapH: 24,
      replaySkewThresholdS: 5,
      meterValueSampleIntervalS: 10,
      reconcileGapFactor: 3,
      reconcileEnergyToleranceWh: 1,
      consoleEnabled: false,
      consoleHost: '127.0.0.1',
      consolePort: 0,
    };
    const sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, config),
      config,
    );
    logger = new OcppMessageLogger(db);
    server = new OcppServer(
      config,
      new ConnectionRegistry(db),
      logger,
      new InboundSerializer(),
      new ReplayDetector(5),
      new OcppHandlers(sessionsService, config),
      sessionsService,
    );
    await server.start();
    client = new RPCClient({
      endpoint: `ws://127.0.0.1:${config.ocppPort}/ocpp`,
      identity: 'G12-PILLAR',
      protocols: ['ocpp1.6'],
      // Client KHÔNG strict: nếu strict thì chính nó chặn frame sai trước khi gửi.
      strictMode: false,
      reconnect: false,
    } as unknown as ConstructorParameters<typeof RPCClient>[0]);
    client.handle('TriggerMessage', async () => ({ status: 'Accepted' }));
    await client.connect();
    // Chờ TriggerMessage c0/c1/c2 của syncConnectorStatus xong để các dòng log không lẫn vào phép đếm.
    await until(
      async () => (await rows()).filter((r) => r.action === 'TriggerMessage').length >= 3,
      'TriggerMessage x3',
    );
    await until(
      async () =>
        (await rows()).filter((r) => r.direction === 'in' && r.messageType === 3).length >= 3,
      'CALLRESULT x3',
    );
  });

  afterAll(async () => {
    await client?.close({ code: 1000, reason: 'test xong' }).catch(() => undefined);
    await server?.stop();
    await db?.$client.end();
  });

  it('frame hợp lệ (Heartbeat) vẫn ghi đúng một dòng chiều vào, validation_error NULL', async () => {
    const before = (await rows()).length;
    await client.call('Heartbeat', {});
    await until(async () => (await rows()).length >= before + 2, 'Heartbeat in + CALLRESULT out');
    const added = (await rows()).slice(before);
    const heartbeats = added.filter((r) => r.action === 'Heartbeat');
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ direction: 'in', messageType: 2, validationError: null });
    expect(added.filter((r) => r.validationError !== null)).toHaveLength(0);
  });

  it('CALL sai schema (Authorize thiếu idTag): CALLERROR cho trụ, đúng một dòng log đánh dấu lỗi, handler không chạy', async () => {
    const before = (await rows()).length;
    let rpcCode: string | undefined;
    await client.call('Authorize', {}).then(
      () => {
        throw new Error('server phải từ chối CALL sai schema');
      },
      (err: Error & { rpcErrorCode?: string }) => {
        rpcCode = err.rpcErrorCode;
      },
    );
    // Giá trị THẬT của ocpp-rpc 2.2.1 cho "thiếu trường bắt buộc" (ghi nhận từ lần chạy này).
    expect(rpcCode).toBe('OccurrenceConstraintViolation');

    await until(async () => {
      const added = (await rows()).slice(before);
      return (
        added.some((r) => r.direction === 'out') && added.some((r) => r.validationError !== null)
      );
    }, 'CALLERROR chiều ra và dòng bị từ chối');
    const added = (await rows()).slice(before);
    const rejected = added.filter((r) => r.validationError !== null);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      direction: 'in',
      messageType: 2,
      action: 'Authorize',
      cpTimestamp: null,
      replayed: null,
    });
    expect(rejected[0]?.validationError).toMatch(/^OccurrenceConstraintViolation: /);
    // raw nguyên văn: [2, <uniqueId>, 'Authorize', {}]
    expect(rejected[0]?.raw).toEqual([2, rejected[0]?.uniqueId, 'Authorize', {}]);
    // Còn lại chỉ là CALLERROR chiều ra (type 4) — không có dòng 'in' thứ hai cho CALL này.
    expect(added.filter((r) => r.direction === 'in')).toHaveLength(1);
    const callError = added.find((r) => r.direction === 'out');
    expect(callError).toMatchObject({ messageType: 4, uniqueId: rejected[0]?.uniqueId });
    // Handler không chạy: Authorize không để lại phiên nào.
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('CALL sai kiểu dữ liệu (StartTransaction idTag là số) cũng được ghi, kèm mã lỗi của thư viện', async () => {
    const before = (await rows()).length;
    let rpcCode: string | undefined;
    await client
      .call('StartTransaction', {
        connectorId: 1,
        idTag: 12345,
        meterStart: 0,
        timestamp: new Date().toISOString(),
      })
      .catch((err: Error & { rpcErrorCode?: string }) => {
        rpcCode = err.rpcErrorCode;
      });
    expect(rpcCode).toBeDefined();
    await until(
      async () => (await rows()).slice(before).some((r) => r.validationError !== null),
      'dòng StartTransaction bị từ chối',
    );
    const rejected = (await rows()).slice(before).filter((r) => r.validationError !== null);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ action: 'StartTransaction', messageType: 2 });
    expect(rejected[0]?.validationError).toContain(rpcCode as string);
    // cp_timestamp lấy được từ payload sai schema vẫn là đồng hồ trụ hợp lệ.
    expect(rejected[0]?.cpTimestamp).toBeInstanceOf(Date);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('kết nối vẫn sống sau các frame sai: Heartbeat kế tiếp được xử lý', async () => {
    const res = (await client.call('Heartbeat', {})) as { currentTime?: string };
    expect(typeof res.currentTime).toBe('string');
  });

  it('frame không phải JSON: một dòng message_type NULL, raw là chuỗi nguyên văn, trụ nhận CALLERROR', async () => {
    const before = (await rows()).length;
    const garbage = 'khong phai json {';
    // sendRaw: đường gửi chuỗi thô của ocpp-rpc (không qua bước dựng frame).
    (client as unknown as { sendRaw(s: string): void }).sendRaw(garbage);
    await until(
      async () => (await rows()).slice(before).some((r) => r.validationError !== null),
      'dòng frame hỏng',
    );
    const rejected = (await rows()).slice(before).filter((r) => r.validationError !== null);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      direction: 'in',
      messageType: null,
      action: null,
      uniqueId: '-1',
      raw: garbage,
    });
    expect(rejected[0]?.validationError).toMatch(/^RpcFrameworkError: /);
  });

  it('ràng buộc DB (migration 0013): message_type NULL chỉ hợp lệ khi có validation_error; dòng bình thường vẫn bị CHECK cũ chặn', async () => {
    const insert = (messageType: number | null, action: string | null, error: string | null) =>
      db.$client.query(
        `INSERT INTO ocpp_message_log(charge_point_id, epoch, direction, message_type, unique_id, action, raw, validation_error)
         VALUES ($1, 1, 'in', $2, 'x', $3, '"raw"'::jsonb, $4)`,
        [chargePointId, messageType, action, error],
      );
    await expect(insert(null, null, null)).rejects.toThrow(/message_type_check/);
    await expect(insert(2, null, null)).rejects.toThrow(/action_check/);
    await expect(insert(3, 'Heartbeat', null)).rejects.toThrow(/action_check/);
    await expect(insert(null, null, 'RpcFrameworkError: x')).resolves.toBeDefined();
  });

  it('lỗi ghi log của frame bị từ chối KHÔNG làm sập kết nối', async () => {
    const original = logger.log.bind(logger);
    const spy = jest.spyOn(logger, 'log').mockImplementation(async (entry) => {
      if (entry.validationError) throw new Error('DB từ chối (giả lập)');
      return original(entry);
    });
    try {
      await client.call('Authorize', {}).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const res = (await client.call('Heartbeat', {})) as { currentTime?: string };
      expect(typeof res.currentTime).toBe('string');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
