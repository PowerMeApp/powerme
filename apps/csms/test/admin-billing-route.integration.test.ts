/**
 * T32 Phần 10a — route Admin billing qua HTTP thật (ConsoleServer → operator-api) + Postgres:
 *   GET  /api/admin/v1/billing/exceptions
 *   POST /api/admin/v1/billing/e-invoices/{id}/retry
 *   POST /api/admin/v1/billing/top-ups/{id}/recheck
 *   POST /api/admin/v1/billing/top-ups/{id}/exception-reviewed
 *   POST /api/admin/v1/billing/payment-conflicts/{id}/review   body {note}
 * Hoàn tiền thủ công (WF-02 D1, D-AC / BR-P51):
 *   POST /api/admin/v1/billing/top-ups/{id}/refund | late-refund
 *   GET  /api/admin/v1/billing/refunds[?status=requested|failed]
 *   POST /api/admin/v1/billing/refunds/{id}/confirm {gateway_refund_no} | fail {reason} | redo
 * Phân quyền (RolesGuard admin), mã HTTP từng nhánh. Không có route retry refund:
 * `…/refunds/{id}/retry` → 404 như đường lạ.
 * Điều kiện lọc của danh sách: `billing-exceptions.integration.test.ts`. Cần DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { TopUpRejected } from '../src/billing/billing-errors.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import type { EInvoiceProviderAdapter } from '../src/billing/e-invoice-provider.js';
import { EInvoiceService } from '../src/billing/e-invoice.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { RefundService } from '../src/billing/refund.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter, type QueryResult } from '../src/billing/vnpay.adapter.js';
import type { VnpayApiConfig, VnpayConfig } from '../src/billing/vnpay.config.js';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { hashChargePointPassword } from '../src/stations/charge-point-credential.js';
import { FaultService } from '../src/stations/faults/fault.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import { buildRevenueFixture } from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'mat-khau-dashboard-1';
const DASH = { secret: new Uint8Array(randomBytes(32)), issuer: 'p10a', audience: 'dashboard' };
const DRIVER = { secret: new Uint8Array(randomBytes(32)), issuer: 'p10a-app', audience: 'app' };
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const API: VnpayApiConfig = { apiUrl: 'https://vnpay.test/api', serverIp: '127.0.0.1' };
const WORK: BackgroundWorkConfig = {
  enabled: false,
  intervalMs: 60_000,
  batchSize: 20,
  leaseMs: 120_000,
};
const B = '/admin/v1/billing';

describeDb('T32 Phần 10a: route Admin billing qua HTTP', () => {
  let db: Db;
  let server: ConsoleServer;
  let base = '';
  let fx: Record<string, string>;
  let admin: number;
  let seq = 0;
  const tokens: Record<string, string> = {};
  let vnpay: VnpayAdapter;
  let topUps: TopUpService;
  let ledger: CreditLedgerService;
  const runner = { register: jest.fn(), kick: jest.fn() } as unknown as BackgroundWorkRunner;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const id = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))['id']);

  async function call(
    method: string,
    path: string,
    opts: {
      token?: string | null;
      body?: unknown;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const token = opts.token === undefined ? tokens['admin'] : opts.token;
    const headers: Record<string, string> = { ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body:
        opts.body === undefined
          ? undefined
          : typeof opts.body === 'string'
            ? opts.body
            : JSON.stringify(opts.body),
    });
    const text = await r.text();
    return {
      status: r.status,
      headers: r.headers,
      body: text ? (JSON.parse(text) as Record<string, any>) : null,
    };
  }
  const post = (path: string, body?: unknown, token?: string | null) =>
    call('POST', path, { body, token });

  async function newAccount(): Promise<{ driver: number; account: number }> {
    seq += 1;
    const driver = await id(
      `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
      [`p10a-route-${seq}@t32.test`],
    );
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [driver],
    );
    const account = await id('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [
      driver,
    ]);
    await q('INSERT INTO loyalty_accounts (driver_id) VALUES ($1)', [driver]);
    return { driver, account };
  }

  async function topUp(
    opts: { status?: string; late?: string | null; exception?: string | null } = {},
  ): Promise<{ id: number; ref: string; account: number }> {
    const { status = 'refunded', late = null, exception = null } = opts;
    const owner = await newAccount();
    seq += 1;
    const ref = `P10AR${seq}`;
    const paid = status === 'credited' || status === 'refunded';
    const topUpId = await id(
      `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
         status, gateway_transaction_no, idempotency_key, expires_at, created_at, completed_at,
         refunded_at, late_gateway_ref, late_paid_at, late_amount_vnd, exception_kind)
       VALUES ($1, $2, 100000, 100000, $3::top_up_status, $4, $5, now() - interval '30 minutes',
         now() - interval '1 hour', now() - interval '20 minutes',
         CASE WHEN $3 = 'refunded' THEN now() END,
         $6, CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() - interval '10 minutes' END,
         CASE WHEN $6::varchar IS NULL THEN NULL ELSE 100000 END, $7::top_up_exception_kind)
       RETURNING id`,
      [
        ref,
        owner.account,
        status,
        paid ? String(60_000_000 + seq) : null,
        `p10a-r-${seq}`,
        late,
        exception,
      ],
    );
    return { id: topUpId, ref, account: owner.account };
  }

  /** Top-up `credited` đã cộng tiền thật vào ví (đủ để hoàn). */
  async function creditedTopUp(late: string | null = null) {
    const t = await topUp({ status: 'credited', late });
    await ledger.post(db.$client, t.account, 'top_up', 100_000, { topUpId: t.id });
    return t;
  }

  async function failedRefund(
    kind: 'top_up' | 'late_payment' | 'account_closure' = 'top_up',
    status = 'failed',
  ) {
    const t = await topUp({ late: kind === 'late_payment' ? String(66_000_000 + seq) : null });
    const refundId = await id(
      `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, requested_by, next_attempt_at,
         completed_at, confirmed_via_query, attempt_count, unfinished_claims, last_error_kind,
         last_error_message, last_attempt_at, failure_reason)
       VALUES ($1, $2::refund_kind, 100000, $3::refund_status,
         CASE WHEN $2 = 'account_closure' THEN NULL ELSE $4::bigint END,
         CASE WHEN $3 = 'requested' THEN now() + interval '1 day' END,
         CASE WHEN $3 = 'done' THEN now() END, $3 = 'done', 4, 3,
         'transient', 'retry_exhausted', now(),
         CASE WHEN $3 = 'failed' THEN 'cổng từ chối' END)
       RETURNING id`,
      [t.id, kind, status, admin],
    );
    return { refundId, ref: t.ref, topUpId: t.id };
  }
  async function driverToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(fx['driver']!)
      .setIssuer(DRIVER.issuer)
      .setAudience(DRIVER.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(DRIVER.secret);
  }

  let logSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    ledger = new CreditLedgerService(db);
    fx = (await buildRevenueFixture(db, await hashChargePointPassword(PASSWORD))).ids;
    admin = Number(fx['admin']);
    const config: CsmsConfig = {
      ...loadConfig({ DATABASE_URL }),
      consolePort: 0,
      dashboardAuth: DASH,
      driverApi: { ...DRIVER, devAuth: false },
    };
    vnpay = new VnpayAdapter(VNPAY, API, (async () => {
      throw new Error('no network in this test');
    }) as unknown as typeof fetch);
    const eInvoices = new EInvoiceService(db, {} as EInvoiceProviderAdapter, runner, WORK);
    const refunds = new RefundService(db, eInvoices);
    topUps = new TopUpService(
      db,
      ledger,
      new LoyaltyService({ pointsExpiryMonths: 12 }),
      vnpay,
      runner,
      WORK,
      eInvoices,
      refunds,
    );
    const registry = new ConnectionRegistry(db);
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry, new FaultService(db, config)),
      db,
      undefined,
      undefined,
      topUps,
      undefined,
      undefined,
      eInvoices,
      refunds,
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    for (const key of ['admin', 'staffa']) {
      const r = await fetch(`${base}/api/auth/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${key}@fe16.test`, password: PASSWORD }),
      });
      tokens[key] = ((await r.json()) as any).access_token;
    }
  });
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  const ROUTES: [string, string, unknown][] = [
    ['GET', `${B}/exceptions`, undefined],
    ['POST', `${B}/e-invoices/1/retry`, undefined],
    ['POST', `${B}/top-ups/1/recheck`, undefined],
    ['POST', `${B}/top-ups/1/exception-reviewed`, undefined],
    ['POST', `${B}/payment-conflicts/1/review`, { note: 'x' }],
    ['POST', `${B}/top-ups/1/refund`, undefined],
    ['POST', `${B}/top-ups/1/late-refund`, undefined],
    ['GET', `${B}/refunds`, undefined],
    ['POST', `${B}/refunds/1/confirm`, { gateway_refund_no: 'RF1' }],
    ['POST', `${B}/refunds/1/fail`, { reason: 'x' }],
    ['POST', `${B}/refunds/1/redo`, undefined],
  ];

  describe('phân quyền và dạng request', () => {
    it.each(ROUTES)(
      '%s %s: không token 401; operator_staff / driver 403',
      async (m, path, body) => {
        expect((await call(m, path, { body, token: null })).status).toBe(401);
        expect((await call(m, path, { body, token: tokens['staffa'] })).status).toBe(403);
        expect((await call(m, path, { body, token: await driverToken() })).status).toBe(403);
      },
    );

    it('sai method → 405 kèm Allow', async () => {
      const a = await call('POST', `${B}/exceptions`, { body: {} });
      expect(a.status).toBe(405);
      expect(a.headers.get('allow')).toBe('GET, OPTIONS');
      const b = await call('GET', `${B}/e-invoices/1/retry`);
      expect(b.status).toBe(405);
      expect(b.headers.get('allow')).toBe('POST, OPTIONS');
    });

    it('route có body: Content-Type khác JSON → 415', async () => {
      const c = await call('POST', `${B}/payment-conflicts/1/review`, {
        body: 'note=x',
        contentType: 'text/plain',
      });
      expect(c.status).toBe(415);
    });

    it('id sai dạng, query string, đường lạ → 400 / 404', async () => {
      for (const bad of ['abc', '0', '-1', '1.5', '01'])
        expect((await post(`${B}/top-ups/${bad}/recheck`)).body).toMatchObject({
          error: 'invalid_input',
        });
      expect((await call('GET', `${B}/exceptions?limit=5`)).status).toBe(400);
      expect((await post(`${B}/top-ups/1/refund?x=1`)).status).toBe(400);
      expect((await post(`${B}/refunds/1/cancel`)).status).toBe(404);
      expect((await call('GET', `${B}/nothing`)).status).toBe(404);
    });

    it('route retry refund đã gỡ (hoàn thủ công, D1) → 404 not_found như đường lạ', async () => {
      const f = await failedRefund();
      for (const path of [`${B}/refunds/1/retry`, `${B}/refunds/${f.refundId}/retry`]) {
        const r = await post(path, {});
        expect(r.status).toBe(404);
        expect(r.body).toMatchObject({ error: 'not_found' });
      }
      const row = await one('SELECT status::text, attempt_count FROM refunds WHERE id=$1', [
        f.refundId,
      ]);
      expect(row).toEqual({ status: 'failed', attempt_count: 4 });
    });
  });

  describe('GET /exceptions', () => {
    it('200 đúng bốn mục, không có failed_refunds (kể cả khi có refund failed)', async () => {
      await failedRefund();
      const r = await call('GET', `${B}/exceptions`);
      expect(r.status).toBe(200);
      const keys = [
        'late_payments',
        'invoices_needs_review',
        'top_up_exceptions',
        'payment_conflicts',
      ];
      expect(Object.keys(r.body!).sort()).toEqual(['generated_at', 'limit', ...keys].sort());
      expect(r.body).not.toHaveProperty('failed_refunds');
      for (const key of keys)
        expect(r.body![key]).toEqual({ total: expect.any(Number), items: expect.any(Array) });
      expect(r.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('POST /e-invoices/{id}/retry', () => {
    async function invoice(status: string) {
      const t = await topUp({ status: 'credited' });
      return id(
        `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_rate, vat_amount_vnd,
           attempt_count, last_error_kind, last_error_message, last_attempt_at, next_attempt_at)
         VALUES ($1, $2::e_invoice_status, 100000, 8, 7407, 4, 'data', 'mst_sai', now(),
           CASE WHEN $2 IN ('requested','failed') THEN now() END)
         RETURNING id`,
        [t.id, status],
      );
    }

    it('needs_review → 202 requested, giữ attempt_count; lần hai → 409; không có → 404', async () => {
      const inv = await invoice('needs_review');
      const r = await post(`${B}/e-invoices/${inv}/retry`);
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ e_invoice_id: String(inv), status: 'requested', attempt_count: 4 });
      expect(logged(logSpy, 'e_invoice_admin_retry')[0]).toMatchObject({ admin_id: admin });
      const again = await post(`${B}/e-invoices/${inv}/retry`);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'invalid_state' });
      expect((await post(`${B}/e-invoices/999999999/retry`)).status).toBe(404);
    });
  });

  describe('POST /top-ups/{id}/recheck', () => {
    const answer = (r: QueryResult) => jest.spyOn(vnpay, 'queryTransaction').mockResolvedValue(r);

    it('not_paid → 200, log admin_id', async () => {
      const t = await topUp({ status: 'expired', exception: 'unresolved_04' });
      answer({ kind: 'not_found' });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ top_up_id: String(t.id), result: 'not_paid' });
      expect(logged(logSpy, 'top_up_admin_recheck')).toEqual([
        expect.objectContaining({ top_up_id: t.id, admin_id: admin, result: 'not_paid' }),
      ]);
    });

    it('late_payment_recorded → 200', async () => {
      const t = await topUp({ status: 'expired', exception: 'unresolved_07' });
      answer({ kind: 'paid', transactionNo: `T${seq}`, amount: 100000, payDate: null });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'late_payment_recorded' });
    });

    it('already_recorded → 200', async () => {
      const late = `L${seq}`;
      const t = await topUp({ status: 'expired', exception: 'unresolved_04', late });
      answer({ kind: 'paid', transactionNo: late, amount: 100000, payDate: null });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'already_recorded' });
    });

    it('conflicting_result → 200', async () => {
      const t = await topUp({ status: 'expired', exception: 'retry_exhausted', late: `L2${seq}` });
      answer({ kind: 'paid', transactionNo: `OTHER${seq}`, amount: 100000, payDate: null });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'conflicting_result' });
    });

    it('still_unresolved → 200 kèm gợi ý thử lại sau 15 phút', async () => {
      const t = await topUp({ status: 'expired', exception: 'unresolved_04' });
      answer({ kind: 'unresolved', reason: 'response_code', responseCode: '94' });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        top_up_id: String(t.id),
        result: 'still_unresolved',
        reason: 'response_code',
        response_code: '94',
        retry_after_minutes: 15,
      });
      expect(r.body!['hint']).toContain('15 phút');
    });

    it('not_eligible: không có → 404; không đủ điều kiện → 409 kèm reason', async () => {
      const missing = await post(`${B}/top-ups/999999999/recheck`);
      expect(missing.status).toBe(404);
      const t = await topUp({ status: 'credited' });
      const r = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'not_eligible', reason: 'not_expired' });
    });

    it('payment_unconfigured → 503', async () => {
      jest
        .spyOn(topUps, 'recheckTopUp')
        .mockRejectedValue(new TopUpRejected('payment_unconfigured'));
      const r = await post(`${B}/top-ups/1/recheck`);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: 'payment_unconfigured' });
    });
  });

  describe('POST /top-ups/{id}/exception-reviewed', () => {
    it('lần đầu 200; lặp 200 trả mốc cũ; sau đó recheck → 409 already_reviewed', async () => {
      const t = await topUp({ status: 'expired', exception: 'unresolved_04' });
      const first = await post(`${B}/top-ups/${t.id}/exception-reviewed`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        top_up_id: String(t.id),
        exception_kind: 'unresolved_04',
        already_reviewed: false,
      });
      const at = first.body!['exception_reviewed_at'];
      expect(typeof at).toBe('string');
      const again = await post(`${B}/top-ups/${t.id}/exception-reviewed`);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ exception_reviewed_at: at, already_reviewed: true });
      expect(logged(logSpy, 'top_up_exception_reviewed')[0]).toMatchObject({
        top_up_id: t.id,
        admin_id: admin,
      });
      // Hành vi có sẵn (D10): đã xem thì "Kiểm tra lại" không còn chạy.
      const recheck = await post(`${B}/top-ups/${t.id}/recheck`);
      expect(recheck.status).toBe(409);
      expect(recheck.body).toMatchObject({ reason: 'already_reviewed' });
    });

    it('không có ngoại lệ → 409 no_exception; không có top-up → 404', async () => {
      const t = await topUp({ status: 'credited' });
      const r = await post(`${B}/top-ups/${t.id}/exception-reviewed`);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'no_exception' });
      expect(
        (await one('SELECT exception_reviewed_at FROM top_ups WHERE id=$1', [t.id]))[
          'exception_reviewed_at'
        ],
      ).toBeNull();
      expect((await post(`${B}/top-ups/999999999/exception-reviewed`)).status).toBe(404);
    });
  });

  describe('POST /payment-conflicts/{id}/review', () => {
    async function conflict() {
      const t = await topUp({ status: 'expired', late: `CL${seq}` });
      seq += 1;
      return id(
        `INSERT INTO top_up_payment_conflicts (top_up_id, gateway_transaction_no, amount_vnd,
           paid_at, source, reason)
         VALUES ($1, $2, 70000, now(), 'ipn', 'extra_payment') RETURNING id`,
        [t.id, `C${seq}`],
      );
    }

    it.each([
      ['thiếu', {}],
      ['rỗng', { note: '' }],
      ['chỉ khoảng trắng', { note: '   ' }],
      ['không phải chuỗi', { note: 5 }],
      ['quá dài', { note: 'a'.repeat(1001) }],
      ['key lạ', { note: 'ok', extra: 1 }],
    ])('note %s → 400, chưa review', async (_n, body) => {
      const c = await conflict();
      const r = await post(`${B}/payment-conflicts/${c}/review`, body);
      expect(r.status).toBe(400);
      expect(
        (await one('SELECT reviewed_at FROM top_up_payment_conflicts WHERE id=$1', [c]))[
          'reviewed_at'
        ],
      ).toBeNull();
    });

    it('hợp lệ → 200, reviewed_by = admin của token; lần hai → 409; không có → 404', async () => {
      const c = await conflict();
      const r = await post(`${B}/payment-conflicts/${c}/review`, { note: '  đã hoàn tay  ' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        conflict_id: String(c),
        reviewed_by: String(admin),
        review_note: 'đã hoàn tay',
      });
      expect(
        await one(
          'SELECT reviewed_by::int, review_note, reviewed_at IS NOT NULL AS done FROM top_up_payment_conflicts WHERE id=$1',
          [c],
        ),
      ).toEqual({ reviewed_by: admin, review_note: 'đã hoàn tay', done: true });
      expect(logged(logSpy, 'payment_conflict_reviewed')[0]).toMatchObject({
        conflict_id: c,
        admin_id: admin,
      });
      const again = await post(`${B}/payment-conflicts/${c}/review`, { note: 'lần hai' });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'already_reviewed' });
      expect((await post(`${B}/payment-conflicts/999999999/review`, { note: 'x' })).status).toBe(
        404,
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Hoàn tiền thủ công (D1, D-AC / BR-P51, SD-2e v3.0)
  let rfSeq = 0;
  const refundNo = () => `RT${Date.now() % 1_000_000}N${(rfSeq += 1)}`;

  describe('POST /top-ups/{id}/refund và /late-refund', () => {
    it('refund credited → 202 {refund_id, status, amount_vnd}; Idempotency-Key được nhận; lần hai → 409 not_refundable', async () => {
      const t = await creditedTopUp();
      const r = await call('POST', `${B}/top-ups/${t.id}/refund`, {
        headers: { 'Idempotency-Key': 'rf-key-00000001' },
      });
      expect(r.status).toBe(202);
      expect(r.body).toEqual({
        refund_id: expect.stringMatching(/^\d+$/),
        status: 'requested',
        amount_vnd: 100_000,
      });
      expect(
        await one('SELECT kind::text, requested_by::int FROM refunds WHERE id=$1', [
          r.body!['refund_id'],
        ]),
      ).toEqual({ kind: 'top_up', requested_by: admin });
      const again = await post(`${B}/top-ups/${t.id}/refund`);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'not_refundable' });
    });

    it('không có → 404; tài khoản closed → 409; số dư khả dụng thiếu → 422', async () => {
      expect((await post(`${B}/top-ups/999999999/refund`)).body).toMatchObject({
        error: 'not_found',
      });
      const closed = await creditedTopUp();
      await q(`UPDATE credit_accounts SET status='closed', closed_at=now() WHERE id=$1`, [
        closed.account,
      ]);
      const c = await post(`${B}/top-ups/${closed.id}/refund`);
      expect([c.status, c.body!['error']]).toEqual([409, 'account_closed']);
      const poor = await creditedTopUp();
      await ledger.post(db.$client, poor.account, 'adjustment', -1);
      const p = await post(`${B}/top-ups/${poor.id}/refund`);
      expect([p.status, p.body!['error']]).toEqual([422, 'insufficient_available_balance']);
    });

    it('late-refund → 202 với late_amount_vnd; lần hai 409 already_requested; không có khoản trễ 409; không có 404', async () => {
      const t = await topUp({ late: String(67_000_000 + seq) });
      const r = await post(`${B}/top-ups/${t.id}/late-refund`);
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ status: 'requested', amount_vnd: 100_000 });
      const again = await post(`${B}/top-ups/${t.id}/late-refund`);
      expect([again.status, again.body!['error']]).toEqual([409, 'already_requested']);
      const none = await creditedTopUp();
      const n = await post(`${B}/top-ups/${none.id}/late-refund`);
      expect([n.status, n.body!['error']]).toEqual([409, 'no_late_payment']);
      expect((await post(`${B}/top-ups/999999999/late-refund`)).status).toBe(404);
    });

    it('CORS preflight cho phép header Idempotency-Key', async () => {
      const r = await fetch(`${base}/api${B}/top-ups/1/refund`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    });
  });

  describe('GET /refunds (danh sách chờ CSKH)', () => {
    it('mặc định requested + failed (gồm account_closure), cũ nhất trước, đủ thông tin tra cổng; không có done', async () => {
      const a = await failedRefund('top_up', 'requested');
      const b = await failedRefund('late_payment', 'failed');
      const c = await failedRefund('account_closure', 'requested');
      const d = await failedRefund('top_up', 'done');
      const r = await call('GET', `${B}/refunds`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ limit: 200, total: expect.any(Number) });
      const items = r.body!['items'] as Record<string, any>[];
      expect(r.body!['total']).toBe(items.length);
      const ids = items.map((i) => Number(i['refund_id']));
      expect(ids).toEqual(expect.arrayContaining([a.refundId, b.refundId, c.refundId]));
      expect(ids).not.toContain(d.refundId);
      expect(ids.indexOf(a.refundId)).toBeLessThan(ids.indexOf(c.refundId));
      expect(new Set(items.map((i) => i['status']))).toEqual(new Set(['requested', 'failed']));
      const late = items.find((i) => Number(i['refund_id']) === b.refundId)!;
      const lateTop = await one(
        `SELECT gateway_reference, late_gateway_ref, late_paid_at FROM top_ups WHERE id=$1`,
        [b.topUpId],
      );
      expect(late).toMatchObject({
        kind: 'late_payment',
        top_up_id: String(b.topUpId),
        amount_vnd: 100_000,
        status: 'failed',
        requested_by: String(admin),
        failure_reason: 'cổng từ chối',
        gateway_reference: b.ref,
        gateway_transaction_no: lateTop['late_gateway_ref'],
        paid_at: (lateTop['late_paid_at'] as Date).toISOString(),
        driver: { driver_id: expect.any(String), full_name: 'X', phone_number: null },
      });
      const closure = items.find((i) => Number(i['refund_id']) === c.refundId)!;
      expect(closure).toMatchObject({ kind: 'account_closure', requested_by: null });
    });

    it('?status=failed / requested lọc đúng; status lạ, tham số khác, lặp → 400', async () => {
      const f = await failedRefund('top_up', 'failed');
      const q1 = await call('GET', `${B}/refunds?status=failed`);
      const items = q1.body!['items'] as Record<string, any>[];
      expect(items.every((i) => i['status'] === 'failed')).toBe(true);
      expect(items.map((i) => Number(i['refund_id']))).toContain(f.refundId);
      const q2 = await call('GET', `${B}/refunds?status=requested`);
      expect(
        (q2.body!['items'] as Record<string, any>[]).every((i) => i['status'] === 'requested'),
      ).toBe(true);
      for (const bad of ['status=done', 'status=', 'limit=5', 'status=failed&status=requested'])
        expect((await call('GET', `${B}/refunds?${bad}`)).status).toBe(400);
    });
  });

  describe('POST /refunds/{id}/confirm | fail | redo', () => {
    async function requestedRefund() {
      const t = await creditedTopUp();
      const r = await post(`${B}/top-ups/${t.id}/refund`);
      return Number(r.body!['refund_id']);
    }

    it('confirm → 200 done (mã trim); lặp cùng mã → 200 already_done; mã khác → 409 invalid_transition', async () => {
      const id = await requestedRefund();
      const no = refundNo();
      const r = await post(`${B}/refunds/${id}/confirm`, { gateway_refund_no: ` ${no} ` });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        refund_id: String(id),
        status: 'done',
        gateway_refund_no: no,
        completed_at: expect.any(String),
        already_done: false,
      });
      const again = await post(`${B}/refunds/${id}/confirm`, { gateway_refund_no: no });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        already_done: true,
        completed_at: r.body!['completed_at'],
      });
      const other = await post(`${B}/refunds/${id}/confirm`, { gateway_refund_no: refundNo() });
      expect([other.status, other.body!['error']]).toEqual([409, 'invalid_transition']);
    });

    it('mã đã ghi cho refund khác → 409 refund_no_used; không có → 404', async () => {
      const a = await requestedRefund();
      const b = await requestedRefund();
      const no = refundNo();
      expect((await post(`${B}/refunds/${a}/confirm`, { gateway_refund_no: no })).status).toBe(200);
      const r = await post(`${B}/refunds/${b}/confirm`, { gateway_refund_no: no });
      expect([r.status, r.body!['error']]).toEqual([409, 'refund_no_used']);
      expect(
        (await post(`${B}/refunds/999999999/confirm`, { gateway_refund_no: refundNo() })).status,
      ).toBe(404);
    });

    it('body sai dạng → 400 invalid_input (thiếu, key lạ, không phải chuỗi, rỗng, quá dài, ký tự lạ)', async () => {
      const id = await requestedRefund();
      for (const body of [
        {},
        { gateway_refund_no: 'RF1', note: 'x' },
        { gateway_refund_no: 123 },
        { gateway_refund_no: '   ' },
        { gateway_refund_no: 'x'.repeat(21) },
        { gateway_refund_no: 'RF 1' },
        { refund_no: 'RF1' },
      ])
        expect((await post(`${B}/refunds/${id}/confirm`, body)).body).toMatchObject({
          error: 'invalid_input',
        });
      for (const body of [{}, { reason: '' }, { reason: 'x'.repeat(1001) }, { reason: 1 }])
        expect((await post(`${B}/refunds/${id}/fail`, body)).body).toMatchObject({
          error: 'invalid_input',
        });
      const c = await call('POST', `${B}/refunds/${id}/fail`, {
        body: 'reason=x',
        contentType: 'text/plain',
      });
      expect(c.status).toBe(415);
      expect(await one('SELECT status::text FROM refunds WHERE id=$1', [id])).toEqual({
        status: 'requested',
      });
    });

    it('fail → 200 failed kèm lý do, log admin_id; fail lần hai → 409; redo → 200 requested; redo lần hai → 409', async () => {
      const id = await requestedRefund();
      const f = await post(`${B}/refunds/${id}/fail`, { reason: '  Cổng từ chối  ' });
      expect(f.status).toBe(200);
      expect(f.body).toEqual({
        refund_id: String(id),
        status: 'failed',
        failure_reason: 'Cổng từ chối',
      });
      expect(logged(logSpy, 'refund_marked_failed')[0]).toMatchObject({
        refund_id: id,
        admin_id: admin,
      });
      const f2 = await post(`${B}/refunds/${id}/fail`, { reason: 'x' });
      expect([f2.status, f2.body!['error']]).toEqual([409, 'invalid_transition']);
      const c = await post(`${B}/refunds/${id}/confirm`, { gateway_refund_no: refundNo() });
      expect([c.status, c.body!['error']]).toEqual([409, 'invalid_transition']);
      const r = await post(`${B}/refunds/${id}/redo`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ refund_id: String(id), status: 'requested' });
      const r2 = await post(`${B}/refunds/${id}/redo`);
      expect([r2.status, r2.body!['error']]).toEqual([409, 'invalid_transition']);
      expect((await post(`${B}/refunds/999999999/redo`)).status).toBe(404);
      expect((await post(`${B}/refunds/999999999/fail`, { reason: 'x' })).status).toBe(404);
    });

    it('sai method → 405 kèm Allow', async () => {
      const a = await call('GET', `${B}/refunds/1/confirm`);
      expect([a.status, a.headers.get('allow')]).toEqual([405, 'POST, OPTIONS']);
      const b = await call('POST', `${B}/refunds`, { body: {} });
      expect([b.status, b.headers.get('allow')]).toEqual([405, 'GET, OPTIONS']);
    });
  });
});
