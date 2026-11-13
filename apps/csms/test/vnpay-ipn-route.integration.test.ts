/**
 * Test tích hợp hai đường dẫn VNPay qua cổng HTTP thật của `ConsoleServer` (T32 Phần 6, D8).
 *
 * Vì sao tồn tại: cổng 3000 còn phục vụ console vận hành CHƯA có xác thực. Hỏng âm thầm có thể là:
 * một URL `/billing…` lạ rơi vào console admin (trên staging Caddy chỉ mở hai đường VNPay, nhưng
 * khớp sai ở đây vẫn lộ console qua hai đường đó), IPN trả HTTP khác 200 (VNPay coi là lỗi, gọi lại
 * 10 lần), query bị decode khác cách VNPay ký (`+` = dấu cách), hoặc trang return ghi vào DB.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter, vnpSecureHash, vnpSignData } from '../src/billing/vnpay.adapter.js';
import type { VnpayConfig } from '../src/billing/vnpay.config.js';
import type { CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

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
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};

describeDb('billing: route /billing/vnpay/{ipn,return} trên ConsoleServer (T32 Phần 6)', () => {
  let db: Db;
  let server: ConsoleServer;
  let base: string;
  let service: TopUpService;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

  async function pendingTopUp(): Promise<{ id: number; ref: string; driverId: number }> {
    const u = Number(
      (
        await one("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `route-${Date.now()}-${Math.random()}@t32p6.test`,
        ])
      )['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    const { topUp } = await service.create(
      u,
      `route-key-${u}`,
      { amountVnd: 100_000 },
      '127.0.0.1',
    );
    const ref = String(
      (await one('SELECT gateway_reference FROM top_ups WHERE id=$1', [topUp.topUpId]))[
        'gateway_reference'
      ],
    );
    return { id: topUp.topUpId, ref, driverId: u };
  }

  /** Query string đã ký, encode đúng như VNPay gửi (`vnpSignData`: urlencode, dấu cách → `+`). */
  function signedQuery(ref: string, over: Record<string, string> = {}): string {
    const params: Record<string, string> = {
      vnp_TmnCode: VNPAY.tmnCode,
      vnp_Amount: String(100_000 * 100),
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: `Nap tien PowerMe ${ref} & uu dai 5%`,
      vnp_PayDate: '20261113103000',
      vnp_ResponseCode: '00',
      vnp_TransactionNo: String(80_000_000 + Math.floor(Math.random() * 1_000_000)),
      vnp_TransactionStatus: '00',
      vnp_TxnRef: ref,
      ...over,
    };
    const data = vnpSignData(params);
    return `${data}&vnp_SecureHash=${vnpSecureHash(data, VNPAY.hashSecret)}`;
  }

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    service = new TopUpService(
      db,
      new CreditLedgerService(db),
      new LoyaltyService({ pointsExpiryMonths: 12 }),
      new VnpayAdapter(VNPAY),
    );
    const registry = new ConnectionRegistry(db);
    server = new ConsoleServer(
      CONFIG,
      new ConsoleQueries(db, CONFIG, registry),
      new ConsoleCommands(db, registry),
      db,
      undefined,
      undefined,
      service,
    );
    await server.start();
    base = `http://127.0.0.1:${String(server.port)}`;
  });
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
  });

  it('GET /billing/vnpay/ipn có chữ ký → HTTP 200 JSON {RspCode 00}, top-up credited; gửi lại → 200 {02}', async () => {
    const t = await pendingTopUp();
    const qs = signedQuery(t.ref);
    const r = await call(`/billing/vnpay/ipn?${qs}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(r.text)).toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect((await one('SELECT status FROM top_ups WHERE id=$1', [t.id]))['status']).toBe(
      'credited',
    );
    expect(JSON.parse((await call(`/billing/vnpay/ipn?${qs}`)).text).RspCode).toBe('02');
  });

  it.each([
    ['không có tham số', ''],
    ['chữ ký sai', 'vnp_TxnRef=PMX&vnp_SecureHash=00'],
  ])('IPN %s → vẫn HTTP 200, RspCode 97', async (_label, qs) => {
    const r = await call(`/billing/vnpay/ipn?${qs}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ RspCode: '97', Message: 'Invalid signature' });
  });

  it('IPN có tham số vnp_ lặp hai lần → 97, không ghi gì', async () => {
    const t = await pendingTopUp();
    const r = await call(`/billing/vnpay/ipn?${signedQuery(t.ref)}&vnp_Amount=1`);
    expect(JSON.parse(r.text).RspCode).toBe('97');
    expect((await one('SELECT status FROM top_ups WHERE id=$1', [t.id]))['status']).toBe('pending');
  });

  it('GET /billing/vnpay/return → trang HTML tĩnh, không đổi DB dù tham số có chữ ký hợp lệ', async () => {
    const t = await pendingTopUp();
    const before = await one('SELECT * FROM top_ups WHERE id=$1', [t.id]);
    const r = await call(`/billing/vnpay/return?${signedQuery(t.ref)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.text).toContain('Đang xác nhận thanh toán');
    expect(await one('SELECT * FROM top_ups WHERE id=$1', [t.id])).toEqual(before);
    expect(
      (await one('SELECT count(*)::int AS n FROM credit_transactions WHERE top_up_id=$1', [t.id]))[
        'n'
      ],
    ).toBe(0);
  });

  it.each(['/billing/vnpay/ipn', '/billing/vnpay/return'])(
    'POST %s → 405, Allow: GET',
    async (path) => {
      const r = await call(path, { method: 'POST', body: '{}' });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET');
    },
  );

  it.each([
    '/billing',
    '/billing?x=1',
    '/billing/',
    '/billing/khac',
    '/billing/vnpay',
    '/billing/vnpay/ipn/x',
  ])('%s → 404 JSON của listener VNPay, không rơi vào console admin', async (path) => {
    const r = await call(path);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toEqual({ error: 'not_found' });
  });

  it('console vẫn phục vụ đường của nó (không bị nhánh VNPay chặn nhầm)', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
  });
});
