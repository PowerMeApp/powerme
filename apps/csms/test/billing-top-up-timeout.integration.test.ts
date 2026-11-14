/**
 * Test tích hợp vòng quét top-up quá hạn và "Kiểm tra lại" (T32 Phần 8, SD-2d, decisions D4/D7)
 * trên Postgres thật: `TopUpService.runDue` / `onPendingTimeout` (querydr, lease) và `recheckTopUp`.
 *
 * Vì sao tồn tại: querydr là đường thứ hai (cùng IPN) cộng tiền thật vào ví, và là đường DUY NHẤT
 * chuyển `pending → expired`. Hỏng âm thầm có thể là: cộng hai lần khi đua với IPN hoặc hai runner;
 * expire top-up mà VNPay chưa trả lời dứt khoát (tiền thật thành khoản trễ); hỏi querydr dồn khi
 * đánh thức trễ; mất lịch hẹn lại; recheck đổi trạng thái / số dư hoặc ghi khoản trễ hai lần.
 *
 * querydr giả: `fetch` inject vào `VnpayAdapter`, response ký bằng đúng `querydrResponseSignData` /
 * `vnpSecureHash` với cấu hình test (secret giả) — không gọi mạng thật. Mã TC theo Report 5 bản nộp
 * (TC-STM4-01…08): chỉ gắn TC-STM4-04 (bước querydr); ca khác đặt tên theo nội dung.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { claimDue } from '../src/billing/due-rows.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import {
  querydrResponseSignData,
  VnpayAdapter,
  vnpSecureHash,
  vnpSignData,
} from '../src/billing/vnpay.adapter.js';
import type { VnpayApiConfig, VnpayConfig } from '../src/billing/vnpay.config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const IP = '203.0.113.7';
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const API: VnpayApiConfig = { apiUrl: 'https://vnpay.test/api/transaction', serverIp: '127.0.0.1' };
const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};
const WAIT_MS = 5000;

type Params = Record<string, string>;
type Over = Record<string, string | undefined>;
type Handler = (req: Params) => Promise<Response>;

describeDb('billing: quét top-up quá hạn + querydr (T32 Phần 8, SD-2d)', () => {
  let db: Db;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  let service: TopUpService;
  let seq = 0;
  let txn = 80_000_000;
  /** Kịch bản querydr theo `vnp_TxnRef`; thiếu → lỗi mạng. */
  const script = new Map<string, Handler>();
  const amounts = new Map<string, number>();
  let calls: Params[] = [];

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const nextTxn = () => String(++txn);

  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init!.body)) as Params;
    calls.push(req);
    const h = script.get(req['vnp_TxnRef']!);
    if (!h) throw new TypeError('fetch failed');
    return h(req);
  }) as typeof fetch;

  const makeService = (d: Db = db, configured = true) =>
    new TopUpService(
      d,
      new CreditLedgerService(d),
      loyalty,
      new VnpayAdapter(
        configured ? VNPAY : { ...VNPAY, configured: false, tmnCode: '', hashSecret: '' },
        API,
        fakeFetch,
      ),
      undefined,
      WORK,
    );

  /** Response querydr đã ký (mặc định: RC 00, TS 00, giao dịch thanh toán, đúng số tiền). */
  function vnpBody(req: Params, over: Over = {}): Record<string, string> {
    const ref = req['vnp_TxnRef']!;
    const merged: Over = {
      vnp_ResponseId: `R${++seq}`,
      vnp_Command: 'querydr',
      vnp_ResponseCode: '00',
      vnp_Message: 'QueryDR Success',
      vnp_TmnCode: VNPAY.tmnCode,
      vnp_TxnRef: ref,
      vnp_Amount: String((amounts.get(ref) ?? 0) * 100),
      vnp_BankCode: 'NCB',
      vnp_PayDate: '20261113103500',
      vnp_TransactionNo: nextTxn(),
      vnp_TransactionType: '01',
      vnp_TransactionStatus: '00',
      vnp_OrderInfo: `Nap tien PowerMe ${ref}`,
      ...over,
    };
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) body[k] = v;
    // `over.vnp_SecureHash` (ca sai chữ ký) giữ nguyên, không ký lại.
    body['vnp_SecureHash'] =
      over['vnp_SecureHash'] ?? vnpSecureHash(querydrResponseSignData(body), VNPAY.hashSecret);
    return body;
  }
  const reply =
    (over: Over = {}): Handler =>
    async (req) =>
      new Response(JSON.stringify(vnpBody(req, over)), { status: 200 });
  const PAID = reply();
  const FAILED = reply({ vnp_TransactionStatus: '02' });
  const NOT_FOUND = reply({
    vnp_ResponseCode: '91',
    vnp_TransactionStatus: undefined,
    vnp_TransactionNo: undefined,
  });
  const TS = (ts: string) => reply({ vnp_TransactionStatus: ts });
  /** Kịch bản dừng giữa chừng: chờ `open()` rồi mới trả lời. */
  function gated(then: Handler) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const handler: Handler = async (req) => {
      entered();
      await gate;
      return then(req);
    };
    return { handler, open: () => open(), inside };
  }

  async function newDriver(): Promise<number> {
    seq += 1;
    const u = Number(
      (
        await one("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `d${seq}@t32p8.test`,
        ])
      )['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    await ledger.ensureAccounts(u);
    return u;
  }

  async function earn(driverId: number, points: number) {
    const acc = Number(
      (await one('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [driverId]))['id'],
    );
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,now()+interval '6 months'
       FROM loyalty_transactions WHERE loyalty_account_id=$1`,
      [acc, points],
    );
    await q('UPDATE loyalty_accounts SET points_balance=points_balance+$2 WHERE id=$1', [
      acc,
      points,
    ]);
  }

  interface Made {
    driverId: number;
    topUpId: number;
    ref: string;
    amountPaidVnd: number;
    amountVnd: number;
  }

  /**
   * Top-up pending thật qua `create`, rồi dời mốc: `expires_at = now() − pastMin` phút (created_at
   * lùi theo, CHECK `expires_at > created_at`) và `next_attempt_at` đã tới hạn.
   */
  async function dueTopUp(pastMin = 3, amountVnd = 100_000, points = 0, d?: number): Promise<Made> {
    const driverId = d ?? (await newDriver());
    const { topUp } = await service.create(
      driverId,
      `p8-key-${++seq}`,
      { amountVnd, pointsToRedeem: points },
      IP,
    );
    await q(
      `UPDATE top_ups SET created_at = now() - ($2::float8 + 15) * interval '1 minute',
         expires_at = now() - $2::float8 * interval '1 minute',
         next_attempt_at = now() - interval '1 second' WHERE id = $1`,
      [topUp.topUpId, pastMin],
    );
    const ref = String(
      (await one('SELECT gateway_reference FROM top_ups WHERE id=$1', [topUp.topUpId]))[
        'gateway_reference'
      ],
    );
    amounts.set(ref, topUp.amountPaidVnd);
    return {
      driverId,
      topUpId: topUp.topUpId,
      ref,
      amountPaidVnd: topUp.amountPaidVnd,
      amountVnd: topUp.amountVnd,
    };
  }

  /** IPN đã ký (mặc định thành công) — để đua với querydr / tạo khoản trễ. */
  function ipn(t: Made, over: Over = {}): Params {
    const merged: Over = {
      vnp_TmnCode: VNPAY.tmnCode,
      vnp_Amount: String(t.amountPaidVnd * 100),
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: `Nap tien PowerMe ${t.ref}`,
      vnp_PayDate: '20261113103000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: nextTxn(),
      vnp_TxnRef: t.ref,
      ...over,
    };
    const p: Params = {};
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) p[k] = v;
    return { ...p, vnp_SecureHash: vnpSecureHash(vnpSignData(p), VNPAY.hashSecret) };
  }

  const topUpRow = (id: number) => one('SELECT * FROM top_ups WHERE id=$1', [id]);
  const balance = async (driverId: number) =>
    Number(
      (await one('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [driverId]))[
        'balance_vnd'
      ],
    );
  const creditRows = async (topUpId: number) =>
    Number(
      (
        await one('SELECT count(*)::int AS n FROM credit_transactions WHERE top_up_id=$1', [
          topUpId,
        ])
      )['n'],
    );
  /** `next_attempt_at = expires_at + N phút` (so bằng SQL, đủ µs). */
  const nextAt = async (id: number) =>
    (await one(
      `SELECT round(extract(epoch FROM next_attempt_at - expires_at) / 60)::int AS m,
                next_attempt_at - expires_at = round(extract(epoch FROM next_attempt_at - expires_at) / 60) * interval '1 minute' AS exact
         FROM top_ups WHERE id=$1`,
      [id],
    )) as { m: number; exact: boolean };

  const run = (s: TopUpService = service) => s.runDue(20, new AbortController().signal);

  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    ledger = new CreditLedgerService(db);
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    service = makeService();
  });
  beforeEach(async () => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Cô lập: dòng pending của ca trước không được tới hạn trong ca sau.
    await q(
      "UPDATE top_ups SET next_attempt_at = now() + interval '1 day' WHERE status = 'pending'",
    );
    script.clear();
    calls = [];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('kết quả querydr dứt khoát (bảng 3.1)', () => {
    it('TC-STM4-04 (bước querydr): pending quá expires_at, querydr đã trả → credited, số dư +amount, gateway_transaction_no = số querydr, completed_at, next_attempt_at NULL, afterPaymentCommitted', async () => {
      const t = await dueTopUp();
      script.set(t.ref, PAID);
      const after = jest.spyOn(
        service as unknown as { afterPaymentCommitted: (r: unknown) => Promise<void> },
        'afterPaymentCommitted',
      );
      expect(await run()).toBe(1);
      expect(calls).toHaveLength(1);
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({
        status: 'credited',
        gateway_transaction_no: String(txn),
        next_attempt_at: null,
        exception_kind: null,
      });
      expect(row['completed_at']).not.toBeNull();
      expect(await balance(t.driverId)).toBe(100_000);
      expect(await creditRows(t.topUpId)).toBe(1);
      expect(after).toHaveBeenCalledWith({ topUpId: t.topUpId, outcome: 'credited' });
    });

    it('TC-STM4-04 (bước querydr) có điểm → dòng redeem, cộng đủ amount_vnd', async () => {
      const d = await newDriver();
      await earn(d, 1000);
      const t = await dueTopUp(3, 100_000, 600, d);
      script.set(t.ref, PAID);
      await run();
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
      expect(await balance(d)).toBe(100_000);
      expect(
        await q(
          'SELECT transaction_type, points FROM loyalty_transactions WHERE top_up_id=$1 ORDER BY entry_no',
          [t.topUpId],
        ),
      ).toEqual([{ transaction_type: 'redeem', points: '-600' }]);
    });

    it('sổ điểm hỏng → vẫn cộng tiền, exception_kind = loyalty_error, log querydr_loyalty_ledger_corrupt', async () => {
      const d = await newDriver();
      await earn(d, 1000);
      const t = await dueTopUp(3, 100_000, 600, d);
      await q(
        'UPDATE loyalty_accounts SET points_balance = points_balance + 7 WHERE driver_id=$1',
        [d],
      );
      script.set(t.ref, PAID);
      await run();
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'credited',
        exception_kind: 'loyalty_error',
      });
      expect(await balance(d)).toBe(100_000);
      expect(logged(errorSpy, 'querydr_loyalty_ledger_corrupt')).toEqual([
        expect.objectContaining({ top_up_id: t.topUpId, reason: 'balance_mismatch' }),
      ]);
    });

    it('failed (RC 00 + TS 02) → failed, completed_at, next_attempt_at NULL, không cộng', async () => {
      const t = await dueTopUp();
      script.set(t.ref, FAILED);
      const after = jest.spyOn(
        service as unknown as { afterPaymentCommitted: (r: unknown) => Promise<void> },
        'afterPaymentCommitted',
      );
      await run();
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({ status: 'failed', next_attempt_at: null });
      expect(row['completed_at']).not.toBeNull();
      expect(await balance(t.driverId)).toBe(0);
      expect(after).toHaveBeenCalledWith({ topUpId: t.topUpId, outcome: 'failed' });
    });

    it('not_found (RC 91) → expired (#4), completed_at, next_attempt_at NULL, không exception_kind', async () => {
      const t = await dueTopUp();
      script.set(t.ref, NOT_FOUND);
      const after = jest.spyOn(
        service as unknown as { afterPaymentCommitted: (r: unknown) => Promise<void> },
        'afterPaymentCommitted',
      );
      await run();
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({ status: 'expired', next_attempt_at: null, exception_kind: null });
      expect(row['completed_at']).not.toBeNull();
      expect(after).toHaveBeenCalledWith({ topUpId: t.topUpId, outcome: 'expired' });
    });

    it('afterPaymentCommitted ném → đã commit vẫn giữ, log top_up_timeout_after_commit_failed', async () => {
      const t = await dueTopUp();
      script.set(t.ref, PAID);
      jest
        .spyOn(
          service as unknown as { afterPaymentCommitted: () => Promise<void> },
          'afterPaymentCommitted',
        )
        .mockRejectedValueOnce(new Error('einvoice down'));
      await run();
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
      expect(logged(errorSpy, 'top_up_timeout_after_commit_failed')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('chưa ngã ngũ: giữ pending, hẹn mốc kế tính từ expires_at (T117 / T127)', () => {
    it.each([
      [2.5, 5],
      [6, 10],
      [12, 20],
      [25, 40],
      [45, 60],
    ])('lúc expires_at + %s phút → next_attempt_at = expires_at + %s phút', async (past, next) => {
      const t = await dueTopUp(past);
      script.set(t.ref, TS('01'));
      await run();
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({ status: 'pending', completed_at: null, exception_kind: null });
      expect(await nextAt(t.topUpId)).toEqual({ m: next, exact: true });
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['lỗi mạng', undefined],
      ['TS 04', TS('04')],
      ['RC 94', reply({ vnp_ResponseCode: '94' })],
      ['sai chữ ký', reply({ vnp_SecureHash: 'ab'.repeat(64) })],
      ['paid sai số tiền', reply({ vnp_Amount: '1' })],
    ])('%s → vẫn pending, không cộng', async (_name, h) => {
      const t = await dueTopUp(3);
      if (h) script.set(t.ref, h);
      await run();
      expect((await topUpRow(t.topUpId))['status']).toBe('pending');
      expect(await nextAt(t.topUpId)).toEqual({ m: 5, exact: true });
      expect(await balance(t.driverId)).toBe(0);
    });

    it('dòng khớp token mà không còn pending (đường rời pending quên NULL next_attempt_at) → không ghi gì, log error querydr_row_not_pending', async () => {
      const t = await dueTopUp(3);
      const g = gated(TS('01'));
      script.set(t.ref, g.handler);
      const sweep = run();
      await g.inside;
      // Giả lập đường lỗi: rời pending nhưng giữ next_attempt_at (= token lease của runner).
      await q(
        `UPDATE top_ups SET status = 'credited', gateway_transaction_no = '99999999',
           completed_at = now() WHERE id = $1`,
        [t.topUpId],
      );
      const before = await topUpRow(t.topUpId);
      expect(before['next_attempt_at']).not.toBeNull();
      g.open();
      await sweep;
      expect(await topUpRow(t.topUpId)).toEqual(before);
      expect(await creditRows(t.topUpId)).toBe(0);
      expect(logged(errorSpy, 'querydr_row_not_pending')).toEqual([
        {
          event: 'querydr_row_not_pending',
          top_up_id: t.topUpId,
          status: 'credited',
          kind: 'unresolved',
          reason: 'transaction_status',
        },
      ]);
      expect(logged(warnSpy, 'querydr_schedule_exhausted')).toHaveLength(0);
    });

    it('đánh thức trễ (đã qua vài mốc) → nhảy tới mốc kế còn lại, querydr chỉ gọi một lần', async () => {
      const t = await dueTopUp(33);
      script.set(t.ref, TS('07'));
      await run();
      expect(calls).toHaveLength(1);
      expect(await nextAt(t.topUpId)).toEqual({ m: 40, exact: true });
      // Chạy lại ngay: chưa tới hạn → không hỏi thêm.
      await run();
      expect(calls).toHaveLength(1);
    });

    it('hết lịch, lần cuối TS 04 → expired + unresolved_04, completed_at, next_attempt_at NULL', async () => {
      const t = await dueTopUp(61);
      script.set(t.ref, TS('04'));
      await run();
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({
        status: 'expired',
        exception_kind: 'unresolved_04',
        exception_reviewed_at: null,
        next_attempt_at: null,
      });
      expect(row['completed_at']).not.toBeNull();
      expect(logged(warnSpy, 'querydr_schedule_exhausted')).toEqual([
        expect.objectContaining({ top_up_id: t.topUpId, exception_kind: 'unresolved_04' }),
      ]);
    });

    it('hết lịch, lần cuối TS 07 → expired + unresolved_07', async () => {
      const t = await dueTopUp(61);
      script.set(t.ref, TS('07'));
      await run();
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'expired',
        exception_kind: 'unresolved_07',
      });
    });

    it.each([
      ['lỗi mạng', undefined],
      ['TS 01', TS('01')],
    ])('hết lịch, lần cuối %s → expired, exception_kind NULL, log warn', async (_n, h) => {
      const t = await dueTopUp(61);
      if (h) script.set(t.ref, h);
      await run();
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'expired',
        exception_kind: null,
        next_attempt_at: null,
      });
      expect(logged(warnSpy, 'querydr_schedule_exhausted')).toHaveLength(1);
    });

    it('sau khi hết lịch, IPN thành công tới → khoản trễ (Phần 6), không cộng', async () => {
      const t = await dueTopUp(61);
      script.set(t.ref, TS('04'));
      await run();
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'expired',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: String(t.amountPaidVnd),
      });
      expect(await balance(t.driverId)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('chọn dòng đến hạn', () => {
    it('chưa tới hạn và dòng không pending → không đụng, không gọi querydr', async () => {
      const notDue = await dueTopUp(3);
      await q("UPDATE top_ups SET next_attempt_at = now() + interval '1 minute' WHERE id=$1", [
        notDue.topUpId,
      ]);
      const done = await dueTopUp(3);
      await q(
        "UPDATE top_ups SET status='failed', completed_at=now(), next_attempt_at=now() - interval '1 minute' WHERE id=$1",
        [done.topUpId],
      );
      const before = [await topUpRow(notDue.topUpId), await topUpRow(done.topUpId)];
      expect(await run()).toBe(0);
      expect(calls).toHaveLength(0);
      expect([await topUpRow(notDue.topUpId), await topUpRow(done.topUpId)]).toEqual(before);
    });

    it('câu giữ chỗ top_ups: chỉ lấy pending đã tới hạn, theo next_attempt_at rồi id', async () => {
      const late = await dueTopUp(3);
      const early = await dueTopUp(3);
      const future = await dueTopUp(3);
      await q("UPDATE top_ups SET next_attempt_at = now() - interval '10 minutes' WHERE id=$1", [
        early.topUpId,
      ]);
      await q("UPDATE top_ups SET next_attempt_at = now() + interval '1 hour' WHERE id=$1", [
        future.topUpId,
      ]);
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        const spec = { table: 'top_ups' as const, statuses: ['pending'], leaseMs: 60_000 };
        const [first] = await claimDue(c, { ...spec, limit: 1 });
        expect(first?.id).toBe(early.topUpId);
        const rest = await claimDue(c, { ...spec, limit: 10 });
        expect(rest.map((r) => r.id)).toEqual([late.topUpId]);
        await expect(claimDue(c, { ...spec, statuses: ['credited'], limit: 1 })).rejects.toThrow(
          'due_rows_fixed_status',
        );
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('VNPay chưa cấu hình → không giữ chỗ dòng nào, top-up giữ nguyên, không gọi HTTP', async () => {
      const t = await dueTopUp(3);
      const before = await topUpRow(t.topUpId);
      expect(await run(makeService(db, false))).toBe(0);
      expect(await topUpRow(t.topUpId)).toEqual(before);
      expect(calls).toHaveLength(0);
    });

    it('sập sau tx1 (không chạy tx2) → hết lease, dòng tới hạn lại và được xử lý', async () => {
      const t = await dueTopUp(3);
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        const [held] = await claimDue(c, {
          table: 'top_ups',
          statuses: ['pending'],
          leaseMs: 300,
          limit: 1,
        });
        expect(held?.id).toBe(t.topUpId);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      script.set(t.ref, PAID);
      expect(await run()).toBe(0); // còn trong lease
      await new Promise((r) => setTimeout(r, 400));
      expect(await run()).toBe(1);
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('đua với IPN và giữa hai runner (connection thật)', () => {
    it('IPN cộng trong lúc querydr đang chạy (sau tx1, trước tx2) → lockLeased null, không cộng lần hai', async () => {
      const t = await dueTopUp(3);
      const g = gated(PAID);
      script.set(t.ref, g.handler);
      const sweep = run();
      await g.inside;
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      g.open();
      await sweep;
      // Kết quả querydr (số giao dịch khác) bị bỏ hẳn: không cộng lần hai, không thành khoản trễ.
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'credited',
        gateway_transaction_no: p['vnp_TransactionNo'],
        late_gateway_ref: null,
      });
      expect(await creditRows(t.topUpId)).toBe(1);
      expect(await balance(t.driverId)).toBe(100_000);
    });

    it('querydr cộng trước, IPN cùng vnp_TransactionNo tới sau → 02, không ghi gì', async () => {
      const t = await dueTopUp(3);
      script.set(t.ref, PAID);
      await run();
      const no = String((await topUpRow(t.topUpId))['gateway_transaction_no']);
      const before = await topUpRow(t.topUpId);
      expect((await service.applyPaymentResult(ipn(t, { vnp_TransactionNo: no }))).RspCode).toBe(
        '02',
      );
      expect(await topUpRow(t.topUpId)).toEqual(before);
      expect(await creditRows(t.topUpId)).toBe(1);
    });

    it('IPN chưa ngã ngũ trong lúc lease → không làm mất lease, querydr vẫn ghi kết quả', async () => {
      const t = await dueTopUp(3);
      const g = gated(PAID);
      script.set(t.ref, g.handler);
      const sweep = run();
      await g.inside;
      expect(
        (await service.applyPaymentResult(ipn(t, { vnp_TransactionStatus: '01' }))).RspCode,
      ).toBe('00');
      g.open();
      await sweep;
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
      expect(await creditRows(t.topUpId)).toBe(1);
    });

    it('giữ chỗ chồng nhau: tx1 của A còn mở → runner B không chờ khoá, không lấy dòng A đang giữ', async () => {
      const t = await dueTopUp(3);
      script.set(t.ref, PAID);
      const a = await db.$client.connect();
      const db2 = createDb(DATABASE_URL!);
      try {
        await a.query('BEGIN');
        const [held] = await claimDue(a, {
          table: 'top_ups',
          statuses: ['pending'],
          leaseMs: 60_000,
          limit: 1,
        });
        expect(held?.id).toBe(t.topUpId);
        const b = await Promise.race([
          run(makeService(db2)),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), WAIT_MS)),
        ]);
        expect(b).toBe(0);
        expect(calls).toHaveLength(0);
      } finally {
        await a.query('ROLLBACK');
        a.release();
        await db2.$client.end();
      }
      expect((await topUpRow(t.topUpId))['status']).toBe('pending');
    });

    it('hai runner song song trên hai pool, cùng top-up → querydr gọi một lần, cộng đúng một lần', async () => {
      const t = await dueTopUp(3);
      const g = gated(PAID);
      script.set(t.ref, g.handler);
      const db2 = createDb(DATABASE_URL!);
      try {
        const other = makeService(db2);
        const a = run();
        await g.inside;
        // B chạy trong lúc A đang giữ lease và chờ querydr.
        const b = await Promise.race([
          run(other),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), WAIT_MS)),
        ]);
        expect(b).toBe(0);
        g.open();
        expect(await a).toBe(1);
      } finally {
        await db2.$client.end();
      }
      expect(calls).toHaveLength(1);
      expect(await creditRows(t.topUpId)).toBe(1);
      expect(await balance(t.driverId)).toBe(100_000);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('recheckTopUp — "Kiểm tra lại" của Admin (chốt Khang 14/11)', () => {
    /** Top-up đã hết lịch với exception_kind cho trước (qua vòng quét thật). */
    async function unresolved(kind: '04' | '07' = '04'): Promise<Made> {
      const t = await dueTopUp(61);
      script.set(t.ref, TS(kind));
      await run();
      expect((await topUpRow(t.topUpId))['exception_kind']).toBe(`unresolved_${kind}`);
      calls = [];
      return t;
    }
    const money = async (t: Made) => ({
      status: (await topUpRow(t.topUpId))['status'],
      balance: await balance(t.driverId),
      credit: await creditRows(t.topUpId),
    });

    it('paid → khoản trễ (late_*), exception_reviewed_at; không đổi status / số dư; gọi lặp → not_eligible', async () => {
      const t = await unresolved('07');
      const before = await money(t);
      script.set(t.ref, PAID);
      const after = jest.spyOn(
        service as unknown as { afterPaymentCommitted: (r: unknown) => Promise<void> },
        'afterPaymentCommitted',
      );
      expect(await service.recheckTopUp(t.topUpId)).toEqual({ result: 'late_payment_recorded' });
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({
        status: 'expired',
        exception_kind: 'unresolved_07',
        late_gateway_ref: String(txn),
        late_amount_vnd: String(t.amountPaidVnd),
      });
      expect(row['exception_reviewed_at']).not.toBeNull();
      expect(row['late_paid_at']).toEqual(new Date('2026-11-13T03:35:00Z'));
      expect(await money(t)).toEqual(before);
      expect(after).toHaveBeenCalledWith({ topUpId: t.topUpId, outcome: 'late_payment' });
      expect(await service.recheckTopUp(t.topUpId)).toEqual({
        result: 'not_eligible',
        reason: 'already_reviewed',
      });
    });

    it('IPN đã ghi khoản trễ cùng số trước lúc recheck → already_recorded, không ghi lần hai, đánh dấu đã xem', async () => {
      const t = await unresolved();
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      const late = await topUpRow(t.topUpId);
      script.set(t.ref, reply({ vnp_TransactionNo: p['vnp_TransactionNo'] }));
      expect(await service.recheckTopUp(t.topUpId)).toEqual({ result: 'already_recorded' });
      const row = await topUpRow(t.topUpId);
      expect(row['late_gateway_ref']).toBe(late['late_gateway_ref']);
      expect(row['late_paid_at']).toEqual(late['late_paid_at']);
      expect(row['exception_reviewed_at']).not.toBeNull();
    });

    it('paid với số khác khoản trễ đã ghi → conflicting_result, không ghi gì, log error', async () => {
      const t = await unresolved();
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const before = await topUpRow(t.topUpId);
      script.set(t.ref, PAID);
      expect(await service.recheckTopUp(t.topUpId)).toEqual({ result: 'conflicting_result' });
      expect(await topUpRow(t.topUpId)).toEqual(before);
      expect(logged(errorSpy, 'recheck_conflicting_result')).toHaveLength(1);
    });

    it.each([
      ['failed', FAILED],
      ['not_found', NOT_FOUND],
    ])('%s → not_paid, exception_reviewed_at, không đổi gì khác', async (_n, h) => {
      const t = await unresolved();
      const before = await topUpRow(t.topUpId);
      script.set(t.ref, h);
      expect(await service.recheckTopUp(t.topUpId)).toEqual({ result: 'not_paid' });
      const row = await topUpRow(t.topUpId);
      expect(row['exception_reviewed_at']).not.toBeNull();
      expect({ ...row, exception_reviewed_at: null, updated_at: null }).toEqual({
        ...before,
        updated_at: null,
      });
    });

    it('unresolved → still_unresolved kèm RC / TS / lý do, không ghi gì', async () => {
      const t = await unresolved();
      const before = await topUpRow(t.topUpId);
      script.set(t.ref, TS('04'));
      expect(await service.recheckTopUp(t.topUpId)).toEqual({
        result: 'still_unresolved',
        reason: 'transaction_status',
        responseCode: '00',
        transactionStatus: '04',
      });
      script.delete(t.ref);
      expect(await service.recheckTopUp(t.topUpId)).toEqual({
        result: 'still_unresolved',
        reason: 'network',
      });
      expect(await topUpRow(t.topUpId)).toEqual(before);
    });

    it('not_eligible (không gọi querydr): không có / pending / credited loyalty_error / expired không exception_kind', async () => {
      expect(await service.recheckTopUp(999_999)).toEqual({
        result: 'not_eligible',
        reason: 'not_found',
      });
      const pending = await dueTopUp(3);
      await q("UPDATE top_ups SET next_attempt_at = now() + interval '1 day' WHERE id=$1", [
        pending.topUpId,
      ]);
      expect(await service.recheckTopUp(pending.topUpId)).toEqual({
        result: 'not_eligible',
        reason: 'not_expired',
      });
      const d = await newDriver();
      await earn(d, 1000);
      const le = await dueTopUp(3, 100_000, 600, d);
      await q(
        'UPDATE loyalty_accounts SET points_balance = points_balance + 7 WHERE driver_id=$1',
        [d],
      );
      script.set(le.ref, PAID);
      await run();
      expect((await topUpRow(le.topUpId))['exception_kind']).toBe('loyalty_error');
      expect(await service.recheckTopUp(le.topUpId)).toEqual({
        result: 'not_eligible',
        reason: 'not_expired',
      });
      const plain = await dueTopUp(3);
      script.set(plain.ref, NOT_FOUND);
      await run();
      expect(await service.recheckTopUp(plain.topUpId)).toEqual({
        result: 'not_eligible',
        reason: 'no_unresolved_exception',
      });
      calls = [];
      await service.recheckTopUp(plain.topUpId);
      expect(calls).toHaveLength(0);
    });

    it('điều kiện đổi giữa lúc đọc và lúc khoá (Admin khác đã xem) → not_eligible, không ghi khoản trễ', async () => {
      const t = await unresolved();
      const g = gated(PAID);
      script.set(t.ref, g.handler);
      const pending = service.recheckTopUp(t.topUpId);
      await g.inside;
      await q('UPDATE top_ups SET exception_reviewed_at = now() WHERE id=$1', [t.topUpId]);
      g.open();
      expect(await pending).toEqual({ result: 'not_eligible', reason: 'already_reviewed' });
      expect((await topUpRow(t.topUpId))['late_gateway_ref']).toBeNull();
    });

    it('IPN ghi khoản trễ cùng số trong lúc recheck chờ querydr → already_recorded, một khoản trễ', async () => {
      const t = await unresolved();
      const p = ipn(t);
      const g = gated(reply({ vnp_TransactionNo: p['vnp_TransactionNo'] }));
      script.set(t.ref, g.handler);
      const pending = service.recheckTopUp(t.topUpId);
      await g.inside;
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      g.open();
      expect(await pending).toEqual({ result: 'already_recorded' });
      expect((await topUpRow(t.topUpId))['late_gateway_ref']).toBe(p['vnp_TransactionNo']);
    });

    it('VNPay chưa cấu hình → payment_unconfigured, không ghi gì', async () => {
      const t = await unresolved();
      const before = await topUpRow(t.topUpId);
      await expect(makeService(db, false).recheckTopUp(t.topUpId)).rejects.toMatchObject({
        code: 'payment_unconfigured',
      });
      expect(await topUpRow(t.topUpId)).toEqual(before);
    });
  });
});
