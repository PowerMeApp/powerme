/**
 * Test tích hợp bảng điều khiển vận hành (BE-08) trên DỮ LIỆU THẬT của trace EXP-01.
 *
 * Vì sao tồn tại: chứng minh các endpoint `/api/admin/*` đọc đúng những gì đường xử lý sẵn có của
 * gateway đã ghi — cùng fixture và cùng cách phát lại với `wf03-exp01.integration.test.ts`
 * (áp migration 0000 + 0001 lên DB sạch, tạo trụ RH24D1-00001 + 2 súng, đưa 75 CALL chiều vào qua
 * `OcppServer.processCall`, hai epoch như EXP-01). Sau đó bật ConsoleServer trên cổng ngẫu nhiên
 * và gọi HTTP thật.
 *
 * Helper phát lại ở đây là bản rút gọn của `play()` trong test WF-03 (file đó không export
 * helper); không sửa test cũ để tránh làm vỡ thứ không chạy được tại chỗ.
 *
 * Cần DATABASE_URL (CI có Postgres 16); thiếu thì cả describe bị skip.
 *
 * Số liệu kỳ vọng lấy từ khẳng định (a)–(f) của test WF-03: 4 phiên (tx1, tx2 reconciled; tx3
 * review; tx4 active — tx4 là StartTransaction c2 phát lại nên là phiên thứ 4, không phải 3),
 * 75 frame CALL chiều vào, 8 frame phát lại, tx3 có 7 bản ghi conflict với chênh 801 Wh
 * (meterStop 242 vs chuỗi 1042,64).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, Db } from '../src/db/db.module.js';
import { chargePoints, connectors } from '../src/db/schema/index.js';
import {
  Connection,
  ConnectionRegistry,
  OcppClientLike,
} from '../src/ocpp-gateway/connection-registry.js';
import { InboundSerializer } from '../src/ocpp-gateway/inbound-serializer.js';
import { OcppHandlers } from '../src/ocpp-gateway/ocpp-handlers.js';
import { OcppMessageLogger } from '../src/ocpp-gateway/ocpp-message-logger.js';
import { OcppServer } from '../src/ocpp-gateway/ocpp-server.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { ReplayDetector } from '../src/reconciliation/replay-detector.js';
import { SessionStateMachine } from '../src/sessions/session-state-machine.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

interface TraceFrame {
  received_at: string;
  cp: string;
  dir: 'in' | 'out';
  type: 2 | 3 | 4;
  id: string;
  action: string | null;
  raw: string;
}

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const CP = 'RH24D1-00001';
const FIXTURE = path.join(__dirname, 'fixtures', 'exp1-disconnect-81s.jsonl');

const SOCKET_CLOSED_AT = new Date('2026-09-16T14:19:01.000Z');
const EPOCH2_OPENED_AT = new Date('2026-09-16T14:20:22.978Z');

const CONFIG: CsmsConfig = {
  databaseUrl: DATABASE_URL ?? '',
  ocppPort: 0,
  heartbeatIntervalS: 60,
  sessionStartTimeoutS: 120,
  sessionHardCapH: 24,
  replaySkewThresholdS: 5,
  meterValueSampleIntervalS: 10,
  reconcileGapFactor: 3,
  reconcileEnergyToleranceWh: 1,
  consoleEnabled: true,
  consoleHost: '127.0.0.1',
  consolePort: 0,
};

class StubClient implements OcppClientLike {
  closed = false;
  readonly calls: { method: string; params: unknown }[] = [];
  constructor(readonly identity: string) {}
  async call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return { status: 'Accepted' };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Các kiểu tối thiểu của JSON phản hồi — chỉ trường mà test đọc. */
interface SessionJson {
  id: number;
  transaction_no: number;
  station: string;
  status: string;
  has_conflict: boolean;
  meter_stop_wh: number | null;
  energy_wh: number | null;
  meter_value_count: number;
}
interface RecordJson {
  record_no: number;
  kind: string;
  record_type: string;
  energy_difference_wh: number | null;
  meter_stop_minus_start_wh: number | null;
  series_last_wh: number | null;
}
interface MessageJson {
  id: number;
  direction: string;
  epoch: number;
  action: string | null;
  replayed: boolean | null;
}

describeDb('Bảng điều khiển vận hành — dữ liệu thật từ trace EXP-01', () => {
  const allFrames = readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TraceFrame);
  const inbound = allFrames
    .filter((f) => f.dir === 'in' && f.type === 2)
    .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));

  let db: Db;
  let consoleServer: ConsoleServer;
  let base: string;
  let client2: StubClient;
  /** Số frame đã phát qua processCall — đối chiếu với /messages và /summary. */
  let played = 0;

  async function get<T>(p: string): Promise<{ status: number; body: T }> {
    const res = await fetch(base + p);
    return { status: res.status, body: (await res.json()) as T };
  }
  async function post<T>(p: string): Promise<{ status: number; body: T }> {
    const res = await fetch(base + p, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as T };
  }

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);

    const [cp] = await db
      .insert(chargePoints)
      .values({ serialNumber: CP, model: 'D1-120', lifecycle: 'awaiting_connection' })
      .returning({ id: chargePoints.id });
    if (!cp) throw new Error('không tạo được charge_point');
    await db.insert(connectors).values([
      { chargePointId: cp.id, connectorNo: 1 },
      { chargePointId: cp.id, connectorNo: 2 },
    ]);

    const sessionsService = new SessionsService(
      db,
      new SessionStateMachine(),
      new ReconciliationService(db, CONFIG),
      CONFIG,
    );
    const serializer = new InboundSerializer();
    const registry1 = new ConnectionRegistry(db);
    const server = new OcppServer(
      CONFIG,
      registry1,
      new OcppMessageLogger(db),
      serializer,
      new ReplayDetector(CONFIG.replaySkewThresholdS),
      new OcppHandlers(sessionsService, CONFIG),
      sessionsService,
    );

    // id trong trace (mini-CSMS cấp) → transaction_no CSMS thật trả.
    const txMap = new Map<number, number>();
    async function play(frame: TraceFrame, conn: Connection): Promise<void> {
      const raw = JSON.parse(frame.raw) as [number, string, string, Record<string, unknown>];
      const action = raw[2];
      let params = raw[3];
      const traceTx =
        typeof params['transactionId'] === 'number' ? (params['transactionId'] as number) : null;
      if ((action === 'MeterValues' || action === 'StopTransaction') && traceTx !== null) {
        params = { ...params, transactionId: txMap.get(traceTx) ?? traceTx };
      }
      const result = await serializer.run(CP, () =>
        server.processCall(
          conn,
          { messageId: raw[1], action, params },
          new Date(frame.received_at),
        ),
      );
      if (action === 'StartTransaction') {
        const reply = allFrames.find((f) => f.dir === 'out' && f.id === frame.id);
        if (!reply) throw new Error(`trace thiếu CALLRESULT cho StartTransaction ${frame.id}`);
        const assigned = (JSON.parse(reply.raw) as [number, string, { transactionId: number }])[2]
          .transactionId;
        txMap.set(assigned, result['transactionId'] as number);
      }
      played += 1;
    }

    // Epoch 1 → socket đóng (tx3 sang orphaned) → CSMS "khởi động lại" (registry mới) → epoch 2.
    const epoch1 = inbound.filter((f) => Date.parse(f.received_at) < SOCKET_CLOSED_AT.getTime());
    const epoch2 = inbound.filter((f) => Date.parse(f.received_at) >= SOCKET_CLOSED_AT.getTime());
    const first = epoch1[0];
    if (!first) throw new Error('trace rỗng');
    const client1 = new StubClient(CP);
    const conn1 = await registry1.open(CP, client1, {
      remoteAddress: '127.0.0.1',
      openedAt: new Date(Date.parse(first.received_at) - 1000),
    });
    for (const f of epoch1) await play(f, conn1);
    await registry1.close(client1, {
      code: 1006,
      reason: 'mini-CSMS bi tat',
      closedAt: SOCKET_CLOSED_AT,
    });
    await sessionsService.onStationOffline(conn1.chargePointId, SOCKET_CLOSED_AT);

    const registry2 = new ConnectionRegistry(db);
    client2 = new StubClient(CP);
    const conn2 = await registry2.open(CP, client2, {
      remoteAddress: '127.0.0.1',
      openedAt: EPOCH2_OPENED_AT,
    });
    for (const f of epoch2) await play(f, conn2);

    consoleServer = new ConsoleServer(
      CONFIG,
      new ConsoleQueries(db, CONFIG, registry2),
      new ConsoleCommands(db, registry2),
    );
    await consoleServer.start();
    base = `http://127.0.0.1:${String(consoleServer.port)}`;
  });

  afterAll(async () => {
    await consoleServer?.stop();
    await db?.$client.end();
  });

  it('console nghe cổng ngẫu nhiên trên 127.0.0.1 và đã phát lại đủ 75 frame', () => {
    expect(consoleServer.port).toBeGreaterThan(0);
    expect(played).toBe(75);
  });

  it('GET /health: select 1 trên Postgres thật → 200 {ok:true, db:true}', async () => {
    const { status, body } = await get<Record<string, unknown>>('/health');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, db: true });
  });

  it('GET / trả trang HTML', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Bảng điều khiển vận hành');
  });

  it('/api/admin/summary: 4 phiên, ≥ 1 review, 1 trụ online, conflict > 0, 75 frame log', async () => {
    const { status, body } = await get<{
      stations: { total: number; online: number; offline: number };
      sessions_by_status: Record<string, number>;
      sessions_total: number;
      reconciliation_by_type: Record<string, number>;
      reconciliation_conflicts: number;
      message_frames: number;
    }>('/api/admin/summary');
    expect(status).toBe(200);
    expect(body.stations).toEqual({ total: 1, online: 1, offline: 0 });
    expect(Object.keys(body.sessions_by_status)).toHaveLength(9);
    expect(body.sessions_total).toBe(4);
    expect(body.sessions_by_status['review']).toBeGreaterThanOrEqual(1);
    expect(body.sessions_by_status['reconciled']).toBe(2);
    expect(body.sessions_by_status['active']).toBe(1);
    expect(body.reconciliation_by_type['conflict']).toBe(1);
    expect(body.reconciliation_by_type['late_sample']).toBe(6);
    expect(body.reconciliation_by_type['meter_gap']).toBe(0);
    expect(body.reconciliation_conflicts).toBe(7);
    expect(body.message_frames).toBe(75);
  });

  it('/api/admin/stations: trụ đang nối, epoch 2, hai súng', async () => {
    const { body } = await get<
      {
        serial: string;
        connected: boolean;
        current_epoch: number;
        lifecycle: string;
        is_online: boolean;
        last_message_at: string | null;
        connectors: { connector_no: number; status: string }[];
      }[]
    >('/api/admin/stations');
    expect(body).toHaveLength(1);
    const st = body[0];
    expect(st?.serial).toBe(CP);
    expect(st?.connected).toBe(true);
    expect(st?.current_epoch).toBe(2);
    expect(st?.lifecycle).toBe('in_service');
    expect(st?.is_online).toBe(true); // ADR-0016 D-C: kết nối là trường riêng, không gộp vào lifecycle
    expect(st?.last_message_at).not.toBeNull();
    expect(st?.connectors.map((c) => c.connector_no)).toEqual([1, 2]);
    expect(st?.connectors[1]?.status).toBe('Charging'); // (g) c2 Charging cuối trace
  });

  it('/api/admin/sessions: tx3 ở trạng thái review, có cờ conflict, meterStop 242', async () => {
    const { body } = await get<SessionJson[]>('/api/admin/sessions');
    expect(body.map((s) => s.transaction_no)).toEqual([4, 3, 2, 1]); // mới nhất trước
    const tx3 = body.find((s) => s.transaction_no === 3);
    expect(tx3?.status).toBe('review');
    expect(tx3?.has_conflict).toBe(true);
    expect(tx3?.meter_stop_wh).toBe(242);
    expect(tx3?.energy_wh).toBe(242);
    expect(tx3?.station).toBe(CP);
    expect(tx3?.meter_value_count).toBeGreaterThan(0);
    const tx1 = body.find((s) => s.transaction_no === 1);
    expect(tx1?.status).toBe('reconciled');
    expect(tx1?.has_conflict).toBe(false);
    expect(tx1?.energy_wh).toBe(601);

    const limited = await get<SessionJson[]>('/api/admin/sessions?limit=2');
    expect(limited.body).toHaveLength(2);
  });

  it('/api/admin/sessions/:id: tx3 có chuỗi đo (6 mẫu phát lại), 7 bản ghi conflict, không có chuyển trạng thái', async () => {
    const list = (await get<SessionJson[]>('/api/admin/sessions')).body;
    const tx3 = list.find((s) => s.transaction_no === 3);
    const { status, body } = await get<{
      session: SessionJson;
      meter_values: { measurand: string; replayed: boolean | null }[];
      reconciliation_records: RecordJson[];
    }>(`/api/admin/sessions/${String(tx3?.id)}`);
    expect(status).toBe(200);
    expect(body.session.status).toBe('review');
    const energy = body.meter_values.filter((m) => m.measurand === 'Energy.Active.Import.Register');
    expect(energy).toHaveLength(13);
    expect(energy.filter((m) => m.replayed === true)).toHaveLength(6);
    expect(body.reconciliation_records.filter((r) => r.kind === 'conflict')).toHaveLength(7);
    expect(body).not.toHaveProperty('transitions');

    expect((await get('/api/admin/sessions/999999')).status).toBe(404);
    expect((await get('/api/admin/sessions/abc')).status).toBe(400);
  });

  it('/api/admin/reconciliation: có bản ghi conflict phản ánh 242 vs 1042 (chênh 801 Wh)', async () => {
    const { body } = await get<RecordJson[]>('/api/admin/reconciliation');
    const conflicts = body.filter((r) => r.kind === 'conflict');
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    for (const c of conflicts) {
      expect(['conflict', 'late_sample']).toContain(c.record_type);
      expect(c.energy_difference_wh).toBe(801);
      expect(c.meter_stop_minus_start_wh).toBe(242);
      expect(Math.round(c.series_last_wh as number)).toBe(1043); // chuỗi 1042,64 Wh
    }
  });

  it('/api/admin/messages: đủ 75 frame chiều vào, 8 frame phát lại, mọi cờ replayed có cp_timestamp', async () => {
    const { body } = await get<MessageJson[]>('/api/admin/messages?limit=500');
    expect(body).toHaveLength(75);
    expect(body.every((m) => m.direction === 'in')).toBe(true);
    expect(body.map((m) => m.id)).toEqual([...body.map((m) => m.id)].sort((a, b) => a - b));
    expect(body.filter((m) => m.epoch === 1)).toHaveLength(54);
    expect(body.filter((m) => m.epoch === 2)).toHaveLength(21);
    const replayed = body.filter((m) => m.replayed === true);
    expect(replayed).toHaveLength(8);
    expect(replayed.map((m) => m.action).sort()).toEqual(
      [
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'MeterValues',
        'StartTransaction',
        'StopTransaction',
      ].sort(),
    );
    // Không bịa: Heartbeat / StatusNotification không có cp_timestamp → null, không phải false.
    const hb = body.find((m) => m.action === 'Heartbeat');
    expect(hb?.replayed).toBeNull();
  });

  it('/api/admin/messages?after=: chỉ trả dòng id > after, tăng dần, tôn trọng limit', async () => {
    const all = (await get<MessageJson[]>('/api/admin/messages?limit=500')).body;
    const mid = all[40]?.id as number;
    const tail = (await get<MessageJson[]>(`/api/admin/messages?after=${mid}&limit=10`)).body;
    expect(tail).toHaveLength(10);
    expect(tail[0]?.id).toBeGreaterThan(mid);
    expect(tail.map((m) => m.id)).toEqual(
      all
        .filter((m) => m.id > mid)
        .map((m) => m.id)
        .slice(0, 10),
    );
    const newest = (await get<MessageJson[]>('/api/admin/messages?limit=5')).body;
    expect(newest.map((m) => m.id)).toEqual(all.slice(-5).map((m) => m.id));
    const none = (await get<MessageJson[]>(`/api/admin/messages?after=${String(all.at(-1)?.id)}`))
      .body;
    expect(none).toEqual([]);
  });

  it('POST disconnect: 404 khi trụ không nối; 405 với GET', async () => {
    const r = await post<{ error: string }>('/api/admin/stations/KHONG-CO/disconnect');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_connected');
    const res = await fetch(`${base}/api/admin/stations/${CP}/disconnect`);
    expect(res.status).toBe(405);
  });

  it('POST remote-stop: phiên review → 409; không có phiên → 404', async () => {
    const list = (await get<SessionJson[]>('/api/admin/sessions')).body;
    const tx3 = list.find((s) => s.transaction_no === 3);
    const r = await post<{ error: string }>(`/api/admin/sessions/${String(tx3?.id)}/remote-stop`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('session_not_stoppable');
    expect((await post('/api/admin/sessions/999999/remote-stop')).status).toBe(404);
    expect(client2.calls.filter((c) => c.method === 'RemoteStopTransaction')).toHaveLength(0);
  });

  it('POST remote-stop phiên tx4 đang active → gửi RemoteStopTransaction tới trụ và trả Accepted', async () => {
    const list = (await get<SessionJson[]>('/api/admin/sessions')).body;
    const tx4 = list.find((s) => s.transaction_no === 4);
    expect(tx4?.status).toBe('active');
    const r = await post<{ status: string; transaction_no: number }>(
      `/api/admin/sessions/${String(tx4?.id)}/remote-stop`,
    );
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('Accepted');
    expect(client2.calls.find((c) => c.method === 'RemoteStopTransaction')?.params).toEqual({
      transactionId: 4,
    });
  });

  it('POST disconnect trụ đang nối → 200 và socket (stub) bị đóng', async () => {
    const r = await post<{ closed: boolean; epoch: number }>(
      `/api/admin/stations/${CP}/disconnect`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ closed: true, epoch: 2 });
    expect(client2.closed).toBe(true);
  });

  it('tương thích dữ liệu cũ (trước 0001): meter_gap + resolution "conflict…" vẫn được đếm và hiển thị là conflict', async () => {
    // Giả lập một DB demo cũ: bản ghi conflict kiểu cũ trên tx1 (đang reconciled, chưa có conflict).
    const list = (await get<SessionJson[]>('/api/admin/sessions')).body;
    const tx1 = list.find((s) => s.transaction_no === 1);
    expect(tx1?.has_conflict).toBe(false);
    const before = (await get<{ reconciliation_conflicts: number }>('/api/admin/summary')).body;
    await db.$client.query(
      `INSERT INTO reconciliation_records (session_id, record_no, record_type, energy_difference_wh, resolution)
       VALUES ($1, 99, 'meter_gap', 5, 'conflict: meter_stop_minus_start=601 series_last=606 diff=5 samples=3 monotonic=true gaps=0 trigger=stop replayed=false')`,
      [tx1?.id],
    );
    const after = (await get<{ reconciliation_conflicts: number }>('/api/admin/summary')).body;
    expect(after.reconciliation_conflicts).toBe(before.reconciliation_conflicts + 1);
    const tx1After = (await get<SessionJson[]>('/api/admin/sessions')).body.find(
      (s) => s.transaction_no === 1,
    );
    expect(tx1After?.has_conflict).toBe(true);
    const detail = await get<{ reconciliation_records: RecordJson[] }>(
      `/api/admin/sessions/${String(tx1?.id)}`,
    );
    const legacy = detail.body.reconciliation_records.find((r) => r.record_no === 99);
    expect(legacy?.record_type).toBe('meter_gap');
    expect(legacy?.kind).toBe('conflict');
  });
});
