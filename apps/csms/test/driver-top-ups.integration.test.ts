/**
 * T32 Phần 5 — route top-up của app tài xế qua HTTP thật (`createDriverListener`) + Postgres.
 *
 * Vì sao tồn tại: tầng route quyết định mã HTTP, dạng JSON (snake_case, id chuỗi), header
 * Idempotency-Key, body lạ, CORS preflight và 503 khi chưa cấu hình VNPay. Luật nghiệp vụ đã kiểm
 * ở `billing-top-up.integration.test.ts`; ở đây chỉ kiểm mỗi nhóm lỗi một ca qua HTTP.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
import type { VnpayConfig } from '../src/billing/vnpay.config.js';
import { createDb, Db } from '../src/db/db.module.js';
import type { DriverApiConfig } from '../src/driver/driver-auth.js';
import { createDriverListener } from '../src/driver/driver.http.js';
import type { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const secret = randomBytes(32);
const API: DriverApiConfig = {
  secret,
  issuer: 'powerme-t32p5-test',
  audience: 'powerme-driver-test',
  devAuth: false,
};
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const PATH = '/api/driver/v1/billing/top-ups';

/**
 * POST bằng node:http với headers dạng mảng phẳng `[tên, giá trị, …]`: giữ nguyên từng dòng header
 * (fetch gộp header trùng tên thành một dòng "a, b").
 */
function rawPost(
  at: string,
  path: string,
  rawHeaders: string[],
  body: string,
): Promise<{ status: number; text: string }> {
  const url = new URL(at);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        // Mảng thô: Node không tự thêm Host, mà server Node ≥ 20 (requireHostHeader) trả 400 rỗng.
        headers: [
          'Host',
          `127.0.0.1:${url.port}`,
          ...rawHeaders,
          'Content-Length',
          String(Buffer.byteLength(body)),
        ],
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describeDb('T32 Phần 5: route top-up tài xế qua HTTP', () => {
  let db: Db;
  const servers: Server[] = [];
  let base: string;
  let unconfiguredBase: string;
  let bareBase: string;
  let driver: string;
  let other: string;
  let token: string;
  let otherToken: string;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const topUpCount = async () =>
    Number((await q('SELECT count(*)::int AS n FROM top_ups'))[0]!['n']);

  async function newDriver(): Promise<string> {
    seq += 1;
    const id = String(
      (
        await q("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `http${seq}@t32p5.test`,
        ])
      )[0]!['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [id],
    );
    return id;
  }

  async function jwt(sub: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      iss: API.issuer,
      aud: API.audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }

  async function listen(topUps?: TopUpService, config: DriverApiConfig = API): Promise<string> {
    const server = createServer(
      createDriverListener(db, {} as DriverChargingService, config, undefined, undefined, topUps),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (
    body: unknown,
    opts: {
      key?: string | null;
      bearer?: string;
      at?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${opts.at ?? base}${PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.bearer ?? token}`,
        'content-type': 'application/json',
        ...(opts.key === null ? {} : { 'idempotency-key': opts.key ?? `http-key-${++seq}` }),
        ...opts.headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (path: string, bearer = token, at = base) =>
    fetch(`${at}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const ledger = new CreditLedgerService(db);
    const loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    base = await listen(new TopUpService(db, ledger, loyalty, new VnpayAdapter(VNPAY)));
    unconfiguredBase = await listen(
      new TopUpService(
        db,
        ledger,
        loyalty,
        new VnpayAdapter({ ...VNPAY, configured: false, tmnCode: '', hashSecret: '' }),
      ),
    );
    bareBase = await listen(undefined);
    driver = await newDriver();
    other = await newDriver();
    token = await jwt(driver);
    otherToken = await jwt(other);
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await db?.$client.end();
  });

  it('POST tạo mới → 201 TopUp snake_case, id chuỗi; gửi lại cùng key → 200 cùng top-up', async () => {
    const k = 'http-create-0001';
    const res = await post({ amount_vnd: 200_000 }, { key: k });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'top_up_id',
        'status',
        'amount_vnd',
        'points_redeemed',
        'points_discount_vnd',
        'amount_paid_vnd',
        'created_at',
        'expires_at',
        'payment_url',
      ].sort(),
    );
    expect(body).toMatchObject({
      status: 'pending',
      amount_vnd: 200_000,
      points_redeemed: 0,
      points_discount_vnd: 0,
      amount_paid_vnd: 200_000,
    });
    expect(typeof body['top_up_id']).toBe('string');
    expect(new URL(String(body['payment_url'])).searchParams.get('vnp_Amount')).toBe('20000000');
    // IP lấy từ socket của request (127.0.0.1 khi gọi local)
    expect(new URL(String(body['payment_url'])).searchParams.get('vnp_IpAddr')).toBe('127.0.0.1');

    const again = await post({ amount_vnd: 200_000, points_to_redeem: 0 }, { key: k });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);

    // GET của mình → 200 cùng nội dung
    const one = await get(`${PATH}/${String(body['top_up_id'])}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(body);
  });

  it('409 top_up_pending mang top_up_id + payment_url; 409 idempotency_conflict', async () => {
    const res = await post({ amount_vnd: 300_000 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('top_up_pending');
    expect(typeof body['detail']).toBe('string');
    expect(typeof body['top_up_id']).toBe('string');
    expect(String(body['payment_url'])).toContain('vnp_SecureHash=');

    const conflict = await post({ amount_vnd: 300_000 }, { key: 'http-create-0001' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'idempotency_conflict' });
  });

  it('409 pending_top_up_confirming không có payment_url', async () => {
    await q(
      `UPDATE top_ups SET created_at = now() - interval '30 minutes', expires_at = now() - interval '15 minutes'
       WHERE credit_account_id = (SELECT id FROM credit_accounts WHERE driver_id=$1)`,
      [driver],
    );
    const res = await post({ amount_vnd: 100_000 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('pending_top_up_confirming');
    expect(body).not.toHaveProperty('payment_url');
    expect(typeof body['top_up_id']).toBe('string');
  });

  it('422 lỗi luật nghiệp vụ (BR-P22 / BR-P35)', async () => {
    const res = await post({ amount_vnd: 49_999 }, { bearer: otherToken });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'amount_out_of_range' });
    const pts = await post({ amount_vnd: 100_000, points_to_redeem: 600 }, { bearer: otherToken });
    expect(pts.status).toBe(422);
    expect(await pts.json()).toMatchObject({ error: 'points_below_minimum' });
  });

  it('GET của người khác / không có → 404; id sai dạng → 400', async () => {
    const [row] = await q(
      `SELECT t.id FROM top_ups t JOIN credit_accounts a ON a.id=t.credit_account_id WHERE a.driver_id=$1`,
      [driver],
    );
    const foreign = await get(`${PATH}/${String(row!['id'])}`, otherToken);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: 'not_found' });
    expect((await get(`${PATH}/999999999`)).status).toBe(404);
    expect((await get(`${PATH}/abc`)).status).toBe(400);
    expect((await get(`${PATH}/1/x`)).status).toBe(404);
  });

  it('quote: 200 TopUpQuote; amount_vnd thiếu / sai → 400; ngoài khoảng → 422', async () => {
    const res = await get(`${PATH}/quote?amount_vnd=200000`, otherToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ points_available: 0, max_points: 0, max_discount_vnd: 0 });
    for (const qs of [
      '',
      '?amount_vnd=abc',
      '?amount_vnd=1.5',
      '?amount_vnd=1&amount_vnd=2',
      '?x=1',
    ])
      expect((await get(`${PATH}/quote${qs}`)).status).toBe(400);
    const out = await get(`${PATH}/quote?amount_vnd=2000001`);
    expect(out.status).toBe(422);
    expect(await out.json()).toMatchObject({ error: 'amount_out_of_range' });
  });

  it('401 không token', async () => {
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'no-token-0001' },
      body: '{"amount_vnd":100000}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await get(`${PATH}/quote?amount_vnd=100000`, '')).status).toBe(401);
  });

  it('400 thiếu / sai / hai header Idempotency-Key; 400 body sai (trường lạ, kiểu sai); không ghi dòng', async () => {
    const before = await topUpCount();
    for (const opts of [
      { key: null },
      { key: 'short' },
      { key: 'k'.repeat(101) },
      { key: 'has space key' },
    ]) {
      const res = await post({ amount_vnd: 100_000 }, { ...opts, bearer: otherToken });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_idempotency_key' });
    }
    // Hai dòng header Idempotency-Key thật (mỗi giá trị đều hợp lệ): headerKey đếm rawHeaders.
    const dup = await rawPost(
      base,
      PATH,
      [
        'Authorization',
        `Bearer ${otherToken}`,
        'Content-Type',
        'application/json',
        'Idempotency-Key',
        'dup-key-aaaaaaaa',
        'Idempotency-Key',
        'dup-key-bbbbbbbb',
      ],
      '{"amount_vnd":100000}',
    );
    // (Node server gộp hai dòng thành "a, b" — giá trị đó cũng không khớp regex, nên ca này bảo vệ
    // kết quả 400 chứ không tách riêng được nhánh đếm rawHeaders.)
    expect(dup.status).toBe(400);
    expect(JSON.parse(dup.text)).toMatchObject({ error: 'invalid_idempotency_key' });
    for (const body of [
      { amount_vnd: 100_000, extra: 1 },
      { amount_vnd: '100000' },
      { amount_vnd: 100_000.5 },
      { amount_vnd: 100_000, points_to_redeem: -1 },
      { amount_vnd: 100_000, points_to_redeem: '600' },
      {},
      [],
      'not json',
    ]) {
      const res = await post(body, { bearer: otherToken });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    }
    expect(await topUpCount()).toBe(before);
    // Đối chứng: cùng tài xế, một header hợp lệ → tạo được.
    expect((await post({ amount_vnd: 100_000 }, { bearer: otherToken })).status).toBe(201);
    expect(await topUpCount()).toBe(before + 1);
  });

  it('415 không phải JSON; 413 body quá 16 KiB; 400 có query trên POST', async () => {
    const media = await post('{"amount_vnd":100000}', {
      bearer: otherToken,
      headers: { 'content-type': 'text/plain' },
    });
    expect(media.status).toBe(415);
    expect(await media.json()).toMatchObject({ error: 'unsupported_media_type' });
    const big = await post(
      { amount_vnd: 100_000, pad: 'x'.repeat(17 * 1024) },
      { bearer: otherToken },
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: 'payload_too_large' });
    const query = await fetch(`${base}${PATH}?x=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'query-key-0001',
      },
      body: '{"amount_vnd":100000}',
    });
    expect(query.status).toBe(400);
  });

  it('405 sai method kèm Allow', async () => {
    const put = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('POST, OPTIONS');
    const postQuote = await fetch(`${base}${PATH}/quote?amount_vnd=100000`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(postQuote.status).toBe(405);
    expect(postQuote.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('503 payment_unconfigured khi thiếu cấu hình VNPay (và khi server không có billing); không ghi dòng', async () => {
    const before = await topUpCount();
    const d = await newDriver();
    const t = await jwt(d);
    for (const at of [unconfiguredBase, bareBase]) {
      const res = await post({ amount_vnd: 100_000 }, { bearer: t, at });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'payment_unconfigured' });
    }
    expect(await topUpCount()).toBe(before);
    expect(await q('SELECT 1 FROM credit_accounts WHERE driver_id=$1', [d])).toEqual([]);
  });

  it('preflight OPTIONS: POST /top-ups có Content-Type + Idempotency-Key; GET /quote thì không', async () => {
    const origin = 'http://localhost:5173';
    const write = await fetch(`${base}${PATH}`, { method: 'OPTIONS', headers: { origin } });
    expect(write.status).toBe(204);
    expect(write.headers.get('access-control-allow-origin')).toBe(origin);
    expect(write.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(write.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, Idempotency-Key',
    );
    const read = await fetch(`${base}${PATH}/quote`, { method: 'OPTIONS', headers: { origin } });
    expect(read.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(read.headers.get('access-control-allow-headers')).toBe('Authorization');
  });

  /**
   * Preflight sau khi ghép route top-up (T32) với route xe (BE-34) trong `driver.http.ts`: ba nhóm
   * header khác nhau. Idempotency-Key chỉ cho route có key (charges, sessions/stop, top-ups); route xe
   * ghi chỉ cần Content-Type (biển số là khoá tự nhiên, không có key); route GET không cần cả hai.
   */
  describe('preflight: Idempotency-Key chỉ khai cho route có key (top-up, charges), không cho route xe', () => {
    const API_ROOT = '/api/driver/v1';
    const origin = 'http://localhost:5173';
    const CASES: [string, string, string][] = [
      // [đường dẫn, Allow-Methods, Allow-Headers]
      ['/billing/top-ups', 'POST, OPTIONS', 'Authorization, Content-Type, Idempotency-Key'],
      ['/billing/top-ups/quote', 'GET, OPTIONS', 'Authorization'],
      ['/billing/top-ups/41', 'GET, OPTIONS', 'Authorization'],
      ['/billing/top-ups/abc', 'GET, OPTIONS', 'Authorization'], // id sai dạng: không khớp route ghi
      ['/charges', 'POST, OPTIONS', 'Authorization, Content-Type, Idempotency-Key'],
      ['/sessions/5/stop', 'POST, OPTIONS', 'Authorization, Content-Type, Idempotency-Key'],
      ['/sessions/5/progress', 'GET, OPTIONS', 'Authorization'],
      ['/vehicles', 'POST, OPTIONS', 'Authorization, Content-Type'],
      ['/vehicles/12', 'PATCH, DELETE, OPTIONS', 'Authorization, Content-Type'],
      ['/vehicle-models', 'GET, OPTIONS', 'Authorization'],
      ['/credit', 'GET, OPTIONS', 'Authorization'],
    ];
    const preflight = async (at: string, path: string) => {
      const res = await fetch(`${at}${API_ROOT}${path}`, {
        method: 'OPTIONS',
        headers: { origin },
      });
      expect(res.status).toBe(204);
      return {
        methods: res.headers.get('access-control-allow-methods'),
        headers: res.headers.get('access-control-allow-headers'),
      };
    };

    it.each(CASES)('%s → %s; %s', async (path, methods, headers) => {
      expect(await preflight(base, path)).toEqual({ methods, headers });
    });

    it('Idempotency-Key không bao giờ xuất hiện ở route xe (POST /vehicles, PATCH/DELETE /vehicles/{id})', async () => {
      for (const path of ['/vehicles', '/vehicles/12']) {
        const { headers } = await preflight(base, path);
        expect(headers).not.toContain('Idempotency-Key');
        expect(headers).toContain('Content-Type');
      }
    });

    it('DRIVER_API_DEV_AUTH: thêm X-Driver-Id ở mọi nhóm, vẫn giữ đúng chỗ của Idempotency-Key', async () => {
      const dev = await listen(undefined, { ...API, devAuth: true });
      expect(await preflight(dev, '/billing/top-ups')).toEqual({
        methods: 'POST, OPTIONS',
        headers: 'Authorization, X-Driver-Id, Content-Type, Idempotency-Key',
      });
      expect(await preflight(dev, '/billing/top-ups/quote')).toEqual({
        methods: 'GET, OPTIONS',
        headers: 'Authorization, X-Driver-Id',
      });
      expect(await preflight(dev, '/vehicles')).toEqual({
        methods: 'POST, OPTIONS',
        headers: 'Authorization, X-Driver-Id, Content-Type',
      });
    });
  });
});
