/**
 * T149 — route điểm thưởng của app tài xế qua HTTP thật (`createDriverListener`) + Postgres.
 *
 * Vì sao tồn tại: màn Loyalty (UC-PAY-04, SRS màn hình 15) phải hiện điểm còn dùng được tính bằng
 * phát lại lô tại `now()` của DB (D11), **không** đọc `points_balance` (lô quá hạn còn nằm trong đó
 * tới khi job hết hạn Phần 13 chạy). Số này phải bằng `points_available` của quote top-up. Lịch sử
 * là dòng thô `loyalty_transactions`, phân trang giống `/credit/transactions`.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
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
  issuer: 'powerme-t149-test',
  audience: 'powerme-driver-test',
  devAuth: false,
};
const SUMMARY = '/api/driver/v1/loyalty';
const HISTORY = '/api/driver/v1/loyalty/transactions';
const SUMMARY_KEYS = [
  'status',
  'points_available',
  'points_expiring_soon',
  'expiring_within_days',
  'expiring_soon',
  'points_earned_total',
  'points_redeemed_total',
  'as_of',
].sort();
const ENTRY_KEYS = [
  'transaction_id',
  'entry_no',
  'transaction_type',
  'points',
  'expires_at',
  'session_id',
  'top_up_id',
  'created_at',
].sort();

type Json = Record<string, unknown>;

describeDb('T149: route điểm thưởng tài xế qua HTTP', () => {
  let db: Db;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  const servers: Server[] = [];
  let base: string;
  let bareBase: string;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Json[];

  async function newDriver(): Promise<number> {
    seq += 1;
    const id = Number(
      (
        await q("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `loyalty${seq}@t149.test`,
        ])
      )[0]!['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [id],
    );
    return id;
  }

  async function jwt(sub: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: String(sub),
      iss: API.issuer,
      aud: API.audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }

  async function listen(services: Parameters<typeof createDriverListener>[5]): Promise<string> {
    const server = createServer(
      createDriverListener(db, {} as DriverChargingService, API, undefined, undefined, services),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Dòng earn hết hạn sau `interval` tính từ now() của DB (âm = đã quá hạn). */
  async function seedEarn(loyaltyAccountId: number, points: number, interval: string) {
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,now()+$3::interval
       FROM loyalty_transactions WHERE loyalty_account_id=$1`,
      [loyaltyAccountId, points, interval],
    );
    await q('UPDATE loyalty_accounts SET points_balance=points_balance+$2 WHERE id=$1', [
      loyaltyAccountId,
      points,
    ]);
  }

  async function newTopUp(creditAccountId: number, points: number, amount = 500000) {
    seq += 1;
    return Number(
      (
        await q(
          `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,points_redeemed,
           points_discount_vnd,amount_paid_vnd,status,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,'credited',$7,now()+interval '15 minutes') RETURNING id`,
          [
            `GW-T149-${seq}`,
            creditAccountId,
            amount,
            points,
            points * 10,
            amount - points * 10,
            `idem-t149-${seq}`,
          ],
        )
      )[0]!['id'],
    );
  }

  const get = async (path: string, token: string | null, at = base) => {
    const res = await fetch(`${at}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { res, body: (await res.json()) as Json };
  };

  const pointsBalance = async (driverId: number) =>
    Number(
      (await q('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [driverId]))[0]![
        'points_balance'
      ],
    );

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    ledger = new CreditLedgerService(db);
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    const topUps = new TopUpService(
      db,
      ledger,
      loyalty,
      new VnpayAdapter({
        configured: true,
        tmnCode: 'TESTTMN1',
        hashSecret: 'TESTSECRETNOTREAL',
        payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
        returnUrl: 'http://localhost:3000/billing/vnpay/return',
      }),
    );
    base = await listen({ topUps, loyalty });
    bareBase = await listen({ topUps });
  });
  beforeEach(async () => {
    await resetAndMigrate(db.$client);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await db?.$client.end();
  });

  it('chưa có tài khoản loyalty → status none, số 0, lịch sử rỗng, GET không tạo tài khoản', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);

    const { res, body } = await get(SUMMARY, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(SUMMARY_KEYS);
    expect(body).toMatchObject({
      status: 'none',
      points_available: 0,
      points_expiring_soon: 0,
      expiring_within_days: 30,
      expiring_soon: [],
      points_earned_total: 0,
      points_redeemed_total: 0,
    });
    expect(Math.abs(Date.parse(String(body['as_of'])) - Date.now())).toBeLessThan(60_000);

    const history = await get(HISTORY, token);
    expect(history.res.status).toBe(200);
    expect(history.body).toEqual({ items: [], total: 0, page: 1, page_size: 20 });

    expect(await q('SELECT 1 FROM loyalty_accounts WHERE driver_id=$1', [driver])).toEqual([]);
  });

  it('lô quá hạn chưa có dòng expire bị loại; points_available ≠ points_balance, = quote; sắp hết hạn chỉ lô ≤ 30 ngày', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);
    const { loyaltyAccountId } = await ledger.ensureAccounts(driver);
    await seedEarn(loyaltyAccountId, 400, '-1 day'); // đã quá hạn, chưa có expire
    await seedEarn(loyaltyAccountId, 300, '10 days'); // trong cửa sổ 30 ngày
    await seedEarn(loyaltyAccountId, 1000, '200 days'); // xa

    const { res, body } = await get(SUMMARY, token);
    expect(res.status).toBe(200);
    const soon = (
      await q(
        'SELECT expires_at FROM loyalty_transactions WHERE loyalty_account_id=$1 AND points=300',
        [loyaltyAccountId],
      )
    )[0]!['expires_at'] as Date;
    expect(body).toMatchObject({
      status: 'active',
      points_available: 1300,
      points_expiring_soon: 300,
      expiring_within_days: 30,
      expiring_soon: [{ expires_at: soon.toISOString(), points: 300 }],
      points_earned_total: 1700,
      points_redeemed_total: 0,
    });
    expect(await pointsBalance(driver)).toBe(1700);
    expect(body['points_available']).not.toBe(await pointsBalance(driver));

    const quote = await get('/api/driver/v1/billing/top-ups/quote?amount_vnd=200000', token);
    expect(quote.res.status).toBe(200);
    expect(quote.body['points_available']).toBe(body['points_available']);

    // Đọc không ghi gì.
    expect(
      await q('SELECT 1 FROM loyalty_transactions WHERE transaction_type=$1', ['expire']),
    ).toEqual([]);
    expect(await pointsBalance(driver)).toBe(1700);
  });

  it('redeem thiếu điểm (adjust 0) → points_redeemed_total ròng; lịch sử có dòng adjust 0, id chuỗi', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);
    const { creditAccountId, loyaltyAccountId } = await ledger.ensureAccounts(driver);
    await seedEarn(loyaltyAccountId, 600, '-1 day');
    await seedEarn(loyaltyAccountId, 1000, '200 days');
    const topUp = await newTopUp(creditAccountId, 1200);
    const c = await db.$client.connect();
    try {
      await c.query('BEGIN');
      const r = await loyalty.redeemForTopUp(c, driver, topUp);
      await c.query('COMMIT');
      expect(r).toMatchObject({ redeemedPoints: 1000, shortfallPoints: 200 });
    } finally {
      c.release();
    }

    const { body } = await get(SUMMARY, token);
    expect(body).toMatchObject({
      status: 'active',
      points_available: 0,
      points_earned_total: 1600,
      points_redeemed_total: 1000,
      expiring_soon: [],
    });

    const history = await get(HISTORY, token);
    expect(history.res.status).toBe(200);
    const items = history.body['items'] as Json[];
    expect(history.body['total']).toBe(4);
    expect(items.map((i) => [i['entry_no'], i['transaction_type'], i['points']])).toEqual([
      [4, 'adjust', 0],
      [3, 'redeem', -1000],
      [2, 'earn', 1000],
      [1, 'earn', 600],
    ]);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(ENTRY_KEYS);
    expect(items[0]).toMatchObject({
      expires_at: null,
      top_up_id: String(topUp),
      session_id: null,
    });
    expect(typeof items[0]!['transaction_id']).toBe('string');
    expect(typeof items[1]!['expires_at']).toBe('string');
    expect(items[2]!['top_up_id']).toBeNull();
  });

  it('lịch sử: entry_no giảm dần, phân trang, trang vượt cuối giữ total; tham số sai / lạ → 400', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);
    const { loyaltyAccountId } = await ledger.ensureAccounts(driver);
    for (let i = 1; i <= 5; i++) await seedEarn(loyaltyAccountId, i * 100, `${i * 40} days`);

    const page = async (p: number) => {
      const { res, body } = await get(`${HISTORY}?page=${p}&page_size=2`, token);
      expect(res.status).toBe(200);
      return body;
    };
    const entries = (b: Json) => (b['items'] as Json[]).map((i) => i['entry_no']);
    const p1 = await page(1);
    expect(p1).toMatchObject({ total: 5, page: 1, page_size: 2 });
    expect(entries(p1)).toEqual([5, 4]);
    expect(entries(await page(2))).toEqual([3, 2]);
    expect(entries(await page(3))).toEqual([1]);
    expect(await page(4)).toEqual({ items: [], total: 5, page: 4, page_size: 2 });

    for (const bad of [
      `${HISTORY}?page=0`,
      `${HISTORY}?page=abc`,
      `${HISTORY}?page=100001`,
      `${HISTORY}?page_size=0`,
      `${HISTORY}?page_size=101`,
      `${HISTORY}?page=1&page=2`,
      `${HISTORY}?foo=1`,
      `${SUMMARY}?page=1`,
      `${SUMMARY}?x`,
    ]) {
      const { res, body } = await get(bad, token);
      expect([bad, res.status, body['error']]).toEqual([bad, 400, 'invalid_input']);
    }
  });

  it('chỉ thấy sổ của chính mình', async () => {
    const a = await newDriver();
    const b = await newDriver();
    const accA = (await ledger.ensureAccounts(a)).loyaltyAccountId;
    const accB = (await ledger.ensureAccounts(b)).loyaltyAccountId;
    await seedEarn(accA, 700, '100 days');
    await seedEarn(accA, 800, '120 days');
    await seedEarn(accB, 50, '20 days');
    const tokenB = await jwt(b);

    const summary = await get(SUMMARY, tokenB);
    expect(summary.body).toMatchObject({
      points_available: 50,
      points_earned_total: 50,
      points_expiring_soon: 50,
    });
    const history = await get(HISTORY, tokenB);
    expect(history.body['total']).toBe(1);
    expect((history.body['items'] as Json[]).map((i) => i['points'])).toEqual([50]);
  });

  it('sổ hỏng → 500 internal_error đã làm sạch + log error có cấu trúc; lịch sử vẫn đọc được', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);
    const { loyaltyAccountId } = await ledger.ensureAccounts(driver);
    await seedEarn(loyaltyAccountId, 800, '100 days');
    // redeem lệch 1 µs so với lô earn → unknown_lot khi phát lại.
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       SELECT $1,2,'redeem',-100,expires_at + interval '1 microsecond'
       FROM loyalty_transactions WHERE loyalty_account_id=$1 AND entry_no=1`,
      [loyaltyAccountId],
    );
    await q('UPDATE loyalty_accounts SET points_balance=700 WHERE id=$1', [loyaltyAccountId]);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { res, body } = await get(SUMMARY, token);
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'internal_error', detail: 'Lỗi nội bộ của CSMS' });
    const logged = errors.mock.calls.map((c) => String(c[0]));
    const entry = logged
      .map((l) => {
        try {
          return JSON.parse(l) as Json;
        } catch {
          return null;
        }
      })
      .find((l) => l?.['event'] === 'driver_loyalty_ledger_corrupt');
    expect(entry).toEqual({
      event: 'driver_loyalty_ledger_corrupt',
      reason: 'unknown_lot',
      entry_no: 2,
      driver_id: driver,
    });

    const history = await get(HISTORY, token);
    expect(history.res.status).toBe(200);
    expect(history.body['total']).toBe(2);
  });

  it('401 không token, 405 sai method, 404 đường con lạ, preflight GET, thiếu LoyaltyService → 503', async () => {
    const driver = await newDriver();
    const token = await jwt(driver);

    const anon = await get(SUMMARY, null);
    expect(anon.res.status).toBe(401);
    expect(anon.res.headers.get('www-authenticate')).toBe('Bearer');

    for (const path of [SUMMARY, HISTORY]) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, OPTIONS');
      expect(await res.json()).toMatchObject({ error: 'method_not_allowed' });
    }

    for (const path of [`${SUMMARY}/x`, `${HISTORY}/1`, `${SUMMARY}/`]) {
      const { res, body } = await get(path, token);
      expect([path, res.status, body['error']]).toEqual([path, 404, 'not_found']);
    }

    const preflight = await fetch(`${base}${HISTORY}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization');

    for (const path of [SUMMARY, HISTORY]) {
      const { res, body } = await get(path, token, bareBase);
      expect([path, res.status, body['error']]).toEqual([path, 503, 'loyalty_unavailable']);
    }
  });
});
