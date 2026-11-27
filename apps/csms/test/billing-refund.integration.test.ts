/**
 * Test tích hợp hoàn tiền (T32 Phần 9a; SD-2e, STM-10, decisions D1 / D7) trên Postgres thật, VNPay
 * giả tiêm qua `fetch`.
 *
 * Vì sao tồn tại: hỏng ở đây là mất tiền thật và refund không thử được trên sandbox. Hỏng âm thầm có
 * thể là: hoàn hai lần (gửi lại sau kết quả không rõ, sập giữa chừng, hai worker), trừ ví sai số khi
 * top-up có dùng điểm, hoàn khoản trễ bằng mã giao dịch gốc, trừ ví rồi refund nằm chờ vô hạn.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { createHmac } from 'node:crypto';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { RefundNotAllowed, RefundNotFound } from '../src/billing/billing-errors.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { InvalidTransition } from '../src/billing/invalid-transition.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { REFUND_SEND_WORK, RefundService } from '../src/billing/refund.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
import type { VnpayApiConfig, VnpayConfig } from '../src/billing/vnpay.config.js';
import { ConfigModule } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const SECRET = 'TESTSECRETNOTREAL';
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: SECRET,
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const API: VnpayApiConfig = { apiUrl: 'https://vnpay.test/api', serverIp: '127.0.0.1' };
const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};

const RESPONSE_ORDER = [
  'vnp_ResponseId',
  'vnp_Command',
  'vnp_ResponseCode',
  'vnp_Message',
  'vnp_TmnCode',
  'vnp_TxnRef',
  'vnp_Amount',
  'vnp_BankCode',
  'vnp_PayDate',
  'vnp_TransactionNo',
  'vnp_TransactionType',
  'vnp_TransactionStatus',
  'vnp_OrderInfo',
];
const QUERY_ORDER = [...RESPONSE_ORDER, 'vnp_PromotionCode', 'vnp_PromotionAmount'];

type Req = Record<string, string>;
type Step = (req: Req) => Response | Promise<Response>;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function sign(order: string[], r: Record<string, string>): Record<string, string> {
  const data = order.map((k) => r[k] ?? '').join('|');
  return {
    ...r,
    vnp_SecureHash: createHmac('sha512', SECRET).update(data, 'utf8').digest('hex'),
  };
}

let refundNoSeq = 0;
/** Response lệnh refund, mặc định RC 00 + TS 00. */
const refundOk =
  (over: Record<string, string> = {}): Step =>
  (req) => {
    refundNoSeq += 1;
    return json(
      sign(RESPONSE_ORDER, {
        vnp_ResponseId: 'R',
        vnp_Command: 'refund',
        vnp_ResponseCode: '00',
        vnp_Message: 'ok',
        vnp_TmnCode: req['vnp_TmnCode']!,
        vnp_TxnRef: req['vnp_TxnRef']!,
        vnp_Amount: req['vnp_Amount']!,
        vnp_BankCode: 'NCB',
        vnp_PayDate: '20261123100000',
        vnp_TransactionNo: String(80_000_000 + refundNoSeq),
        vnp_TransactionType: req['vnp_TransactionType']!,
        vnp_TransactionStatus: '00',
        vnp_OrderInfo: req['vnp_OrderInfo']!,
        ...over,
      }),
    );
  };
const refundRc = (rc: string): Step => refundOk({ vnp_ResponseCode: rc });
const RC94_UNSIGNED: Step = () => json({ vnp_ResponseCode: '94', vnp_Message: 'dup' });
const HTTP_500: Step = () => json({}, 500);

/** Response querydr. `amount` = số trong response, mặc định số của refund đang xét. */
const queryReply =
  (type: string, ts: string, transactionNo: string, amountVnd: number): Step =>
  (req) =>
    json(
      sign(QUERY_ORDER, {
        vnp_ResponseId: 'Q',
        vnp_Command: 'querydr',
        vnp_ResponseCode: '00',
        vnp_Message: 'ok',
        vnp_TmnCode: req['vnp_TmnCode']!,
        vnp_TxnRef: req['vnp_TxnRef']!,
        vnp_Amount: String(amountVnd * 100),
        vnp_BankCode: 'NCB',
        vnp_PayDate: '20261123100000',
        vnp_TransactionNo: transactionNo,
        vnp_TransactionType: type,
        vnp_TransactionStatus: ts,
        vnp_OrderInfo: 'x',
      }),
    );
const QUERY_99: Step = (req) =>
  json(
    sign(QUERY_ORDER, {
      vnp_ResponseId: 'Q',
      vnp_Command: 'querydr',
      vnp_ResponseCode: '99',
      vnp_TmnCode: req['vnp_TmnCode']!,
      vnp_TxnRef: req['vnp_TxnRef']!,
    }),
  );
const QUERY_UNSIGNED: Step = () => json({ vnp_ResponseCode: '94' });

describeDb('billing: hoàn tiền VNPay (T32 Phần 9a, SD-2e, STM-10)', () => {
  let db: Db;
  let seq = 0;
  let refundSteps: Step[] = [];
  let querySteps: Step[] = [];
  let calls: Req[] = [];
  const sent = (cmd: string) => calls.filter((c) => c['vnp_Command'] === cmd);

  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as Req;
    calls.push(req);
    if (req['vnp_Command'] === 'refund') return (refundSteps.shift() ?? refundOk())(req);
    return (querySteps.shift() ?? QUERY_99)(req);
  }) as unknown as typeof fetch;

  const kick = jest.fn();
  const runner = { register: jest.fn(), kick } as unknown as BackgroundWorkRunner;
  let vnpay: VnpayAdapter;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  let refunds: RefundService;
  let topUps: TopUpService;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const run = (s: RefundService = refunds, signal = new AbortController().signal) =>
    s.runDue(20, signal);

  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  async function newAdmin(): Promise<number> {
    seq += 1;
    const id = Number(
      (
        await one(
          `INSERT INTO users (email, full_name, role) VALUES ($1, 'A', 'admin') RETURNING id`,
          [`p9a-admin-${seq}@t32.test`],
        )
      )['id'],
    );
    await q('INSERT INTO admins (user_id) VALUES ($1)', [id]);
    return id;
  }
  let admin: number;

  async function newDriver(): Promise<{ driver: number; account: number }> {
    seq += 1;
    const driver = Number(
      (
        await one(
          `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
          [`p9a-${seq}@t32.test`],
        )
      )['id'],
    );
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [driver],
    );
    const account = Number(
      (await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [driver]))[
        'id'
      ],
    );
    await q('INSERT INTO loyalty_accounts (driver_id) VALUES ($1)', [driver]);
    return { driver, account };
  }

  type Made = {
    id: number;
    driver: number;
    account: number;
    ref: string;
    txn: string;
    lateTxn: string | null;
  };

  /** Top-up đã cộng tiền thật qua `ledger.post`. `status` khác `credited` thì không ghi sổ. */
  async function topUp(
    opts: {
      amount?: number;
      discount?: number;
      points?: number;
      status?: string;
      late?: number;
      owner?: { driver: number; account: number };
    } = {},
  ): Promise<Made> {
    const { amount = 100_000, discount = 0, points = 0, status = 'credited', late } = opts;
    const owner = opts.owner ?? (await newDriver());
    seq += 1;
    const ref = `P9AREF${seq}`;
    const paidStates = status === 'credited' || status === 'refunded';
    const txn = String(70_000_000 + seq);
    const lateTxn = late === undefined ? null : String(75_000_000 + seq);
    const id = Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd,
             points_redeemed, points_discount_vnd, amount_paid_vnd, status,
             gateway_transaction_no, idempotency_key, expires_at, created_at, completed_at,
             refunded_at, late_gateway_ref, late_paid_at, late_amount_vnd)
           VALUES ($1, $2, $3, $4, $5, $6, $7::top_up_status, $8, $9,
             now() + interval '15 minutes', now() - interval '1 hour',
             CASE WHEN $7 = 'pending' THEN NULL ELSE now() - interval '50 minutes' END,
             CASE WHEN $7 = 'refunded' THEN now() ELSE NULL END,
             $10, CASE WHEN $10::varchar IS NULL THEN NULL ELSE now() - interval '40 minutes' END,
             $11)
           RETURNING id`,
          [
            ref,
            owner.account,
            amount,
            points,
            discount,
            amount - discount,
            status,
            paidStates ? txn : null,
            `p9a-key-${seq}`,
            lateTxn,
            late ?? null,
          ],
        )
      )['id'],
    );
    if (status === 'credited')
      await ledger.post(db.$client, owner.account, 'top_up', amount, { topUpId: id });
    return { id, driver: owner.driver, account: owner.account, ref, txn, lateTxn };
  }

  /** Top-up có điểm: nạp 100.000, 2.000 điểm = 20.000, trả 80.000; điểm đã trừ thật. */
  async function topUpWithPoints(): Promise<Made> {
    const owner = await newDriver();
    const acc = Number(
      (await one('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [owner.driver]))['id'],
    );
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       VALUES ($1, 1, 'earn', 3000, now() + interval '6 months')`,
      [acc],
    );
    await q('UPDATE loyalty_accounts SET points_balance = 3000 WHERE id=$1', [acc]);
    const t = await topUp({ amount: 100_000, discount: 20_000, points: 2000, owner });
    const c = await db.$client.connect();
    try {
      await c.query('BEGIN');
      await loyalty.redeemForTopUp(c, owner.driver, t.id);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    return t;
  }

  async function holdIntent(driver: number, reservedVnd: number) {
    seq += 1;
    const cp = (
      await one(`INSERT INTO charge_points (serial_number) VALUES ($1) RETURNING id`, [
        `P9A-CP-${seq}`,
      ])
    )['id'];
    const conn = (
      await one(
        `INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1, 1) RETURNING id`,
        [cp],
      )
    )['id'];
    const model = (
      await one(`INSERT INTO vehicle_models (brand, model_name) VALUES ('B', $1) RETURNING id`, [
        `M${seq}`,
      ])
    )['id'];
    const veh = (
      await one(
        `INSERT INTO vehicles (driver_id, vehicle_model_id, plate_number)
         VALUES ($1, $2, $3) RETURNING id`,
        [driver, model, `51A-${String(seq).padStart(5, '0')}`],
      )
    )['id'];
    await q(
      `INSERT INTO driver_charge_intents (driver_id, vehicle_id, connector_id, id_tag,
         idempotency_key, request_hash, energy_limit_wh, reserved_vnd, state)
       VALUES ($1, $2, $3, $4, $5, 'h', 1000, $6, 'accepted')`,
      [driver, veh, conn, `P9A${seq}`, `k-${seq}`, reservedVnd],
    );
  }

  const refundRow = (id: number) =>
    one(
      `SELECT status::text, kind::text, amount_vnd::int, attempt_count, unfinished_claims,
              last_error_kind::text, last_error_message, gateway_refund_no, confirmed_via_query,
              completed_at IS NOT NULL AS completed, next_attempt_at IS NULL AS no_next,
              round(extract(epoch FROM next_attempt_at - last_attempt_at))::int AS delay_s
       FROM refunds WHERE id=$1`,
      [id],
    );
  const makeDue = (id: number) =>
    q("UPDATE refunds SET next_attempt_at = now() - interval '1 second' WHERE id=$1", [id]);
  const balance = async (account: number) =>
    Number(
      (await one('SELECT balance_vnd FROM credit_accounts WHERE id=$1', [account]))['balance_vnd'],
    );
  const ledgerRows = (topUpId: number) =>
    q(
      `SELECT transaction_type::text, amount_vnd::int FROM credit_transactions
       WHERE top_up_id=$1 AND transaction_type='refund'`,
      [topUpId],
    );
  const points = async (driver: number) =>
    Number(
      (await one('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [driver]))[
        'points_balance'
      ],
    );
  const refundCount = async (topUpId: number) =>
    Number(
      (await one('SELECT count(*)::int AS n FROM refunds WHERE top_up_id=$1', [topUpId]))['n'],
    );

  /** Refund `top_up` tạo bằng đường thật. */
  async function requested(opts: Parameters<typeof topUp>[0] = {}) {
    const t = await topUp(opts);
    const { refundId } = await topUps.refund(t.id, admin);
    return { t, refundId };
  }
  /** Giả lập sập sau khi VNPay đã trả lời: tx2 kế tiếp lỗi và rollback, dòng giữ lease và bộ đếm. */
  const failNextTx2 = () =>
    jest
      .spyOn(refunds as unknown as { applyOutcome: () => Promise<unknown> }, 'applyOutcome')
      .mockRejectedValueOnce(new Error('crash_before_tx2_commit'));

  /** Refund bị từ chối ở lượt 1 → `failed` (data). */
  async function rejectedRefund() {
    const made = await requested();
    refundSteps = [refundRc('95')];
    await run();
    expect(await refundRow(made.refundId)).toMatchObject({
      status: 'failed',
      last_error_kind: 'data',
      attempt_count: 1,
    });
    calls = [];
    return made;
  }
  /** Refund hết 4 lượt tạm thời → `failed`. */
  async function exhaustedRefund() {
    const made = await requested();
    refundSteps = [HTTP_500];
    await run();
    for (let i = 0; i < 3; i++) {
      await makeDue(made.refundId);
      await run();
    }
    expect(await refundRow(made.refundId)).toMatchObject({ status: 'failed', attempt_count: 4 });
    calls = [];
    return made;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    ledger = new CreditLedgerService(db);
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    vnpay = new VnpayAdapter(VNPAY, API, fakeFetch);
    refunds = new RefundService(db, vnpay, runner, WORK);
    topUps = new TopUpService(db, ledger, loyalty, vnpay, runner, WORK, undefined, refunds);
    admin = await newAdmin();
  });
  beforeEach(async () => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Cô lập: refund còn chờ của ca trước không tới hạn trong ca sau.
    await q(
      `UPDATE refunds SET next_attempt_at = now() + interval '1 day' WHERE status = 'requested'`,
    );
    refundSteps = [];
    querySteps = [];
    calls = [];
    kick.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('TC-STM10: một lượt gửi', () => {
    it('TC-STM10-01 accepted → done, gateway_refund_no, completed_at; tham số đúng bảng 2.1', async () => {
      const { t, refundId } = await requested();
      expect(await run()).toBe(1);
      const r = await refundRow(refundId);
      expect(r).toMatchObject({
        status: 'done',
        attempt_count: 1,
        completed: true,
        no_next: true,
        confirmed_via_query: false,
      });
      expect(String(r['gateway_refund_no'])).toMatch(/^\d+$/);
      expect(sent('querydr')).toHaveLength(0);
      expect(sent('refund')).toHaveLength(1);
      expect(sent('refund')[0]).toMatchObject({
        vnp_TxnRef: t.ref,
        vnp_TransactionNo: t.txn,
        vnp_Amount: '10000000',
        vnp_TransactionType: '02',
        vnp_CreateBy: `admin:${admin}`,
        vnp_OrderInfo: `Hoan tien PowerMe ${refundId}`,
      });
    });

    it.each(['05', '06'])('RC 00 + TS %s → done', async (ts) => {
      const { refundId } = await requested();
      refundSteps = [refundOk({ vnp_TransactionStatus: ts })];
      await run();
      expect(await refundRow(refundId)).toMatchObject({ status: 'done' });
    });

    it('TC-STM10-02 rejected → failed ngay, last_error_kind = data', async () => {
      const { refundId } = await requested();
      refundSteps = [refundRc('95')];
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        attempt_count: 1,
        last_error_kind: 'data',
        no_next: true,
      });
      expect(logged(errorSpy, 'refund_failed')).toHaveLength(1);
    });

    it('TC-STM10-03 unknown → vẫn requested, attempt_count 1, hẹn +5 phút', async () => {
      const { refundId } = await requested();
      refundSteps = [HTTP_500];
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 1,
        last_error_kind: 'transient',
        delay_s: 300,
        unfinished_claims: 0,
      });
    });

    it('TC-STM10-04 bốn lượt tạm thời (+5, +30, +2 giờ) → failed', async () => {
      const { refundId } = await requested();
      refundSteps = [HTTP_500];
      await run();
      for (const [attempt, delay] of [
        [2, 1800],
        [3, 7200],
      ] as const) {
        await makeDue(refundId);
        await run();
        expect(await refundRow(refundId)).toMatchObject({
          status: 'requested',
          attempt_count: attempt,
          delay_s: delay,
        });
      }
      await makeDue(refundId);
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        attempt_count: 4,
        last_error_kind: 'transient',
        no_next: true,
      });
      expect(sent('refund')).toHaveLength(1);
    });

    it('thiếu mã giao dịch gốc → failed (data), không gọi HTTP', async () => {
      const { t, refundId } = await requested();
      await q('UPDATE top_ups SET gateway_transaction_no = NULL WHERE id=$1', [t.id]);
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        last_error_kind: 'data',
        last_error_message: 'missing_gateway_transaction_no',
      });
      expect(calls).toHaveLength(0);
    });

    it('VNPay chưa cấu hình: worker không giữ chỗ, không gọi HTTP, warn một lần', async () => {
      const { refundId } = await requested();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const off = new RefundService(
        db,
        new VnpayAdapter({ ...VNPAY, configured: false }, API, fakeFetch),
        runner,
        WORK,
      );
      await makeDue(refundId);
      expect(await run(off)).toBe(0);
      expect(await run(off)).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logged(warn, 'refund_send_unconfigured')).toHaveLength(1);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        unfinished_claims: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('truy vấn trước khi gửi lại (mục 2.3)', () => {
    async function afterUnknown(first: Step = HTTP_500) {
      const made = await requested();
      refundSteps = [first];
      await run();
      await makeDue(made.refundId);
      calls = [];
      return made;
    }

    it('querydr thấy lệnh hoàn TS 00 → done, không gửi lần 2; confirmed_via_query, mã NULL, có log', async () => {
      const { t, refundId } = await afterUnknown();
      querySteps = [queryReply('02', '00', t.txn, 100_000)];
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'done',
        confirmed_via_query: true,
        gateway_refund_no: null,
        completed: true,
      });
      expect(sent('refund')).toHaveLength(0);
      expect(logged(logSpy, 'refund_done_via_query')).toEqual([
        expect.objectContaining({
          refund_id: refundId,
          vnp_TransactionType: '02',
          vnp_TransactionStatus: '00',
        }),
      ]);
    });

    it.each(['05', '06'])('querydr thấy lệnh hoàn TS %s → done', async (ts) => {
      const { t, refundId } = await afterUnknown();
      querySteps = [queryReply('03', ts, t.txn, 100_000)];
      await run();
      expect(await refundRow(refundId)).toMatchObject({ status: 'done' });
      expect(sent('refund')).toHaveLength(0);
    });

    it('querydr thấy TS 09 → failed (data), không gửi', async () => {
      const { t, refundId } = await afterUnknown();
      querySteps = [queryReply('02', '09', t.txn, 100_000)];
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        last_error_kind: 'data',
      });
      expect(sent('refund')).toHaveLength(0);
    });

    it('querydr thấy 02 nhưng sai số tiền → không done, không gửi, hẹn lượt sau', async () => {
      const { t, refundId } = await afterUnknown();
      querySteps = [queryReply('02', '00', t.txn, 99_000)];
      await run();
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempt_count: 2 });
      expect(sent('refund')).toHaveLength(0);
    });

    it('lượt tự động sau unknown, querydr 01 / 00 → KHÔNG gửi, hẹn lượt sau', async () => {
      const { t, refundId } = await afterUnknown();
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 2,
        last_error_message: 'querydr_payment_only',
      });
    });

    it('RC 94 lượt 1 → lượt 2 chỉ truy vấn; querydr 01 / 00 → KHÔNG gửi', async () => {
      const { t, refundId } = await afterUnknown(RC94_UNSIGNED);
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempt_count: 1 });
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
    });

    it.each([
      ['RC 99', () => QUERY_99],
      ['không xác thực được', () => QUERY_UNSIGNED],
    ])('querydr %s → không gửi, hẹn lượt sau', async (_n, step) => {
      const { refundId } = await afterUnknown();
      querySteps = [step()];
      await run();
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempt_count: 2 });
    });

    it('querydr TransactionNo khác → không gửi, hẹn lượt sau', async () => {
      const { refundId } = await afterUnknown();
      querySteps = [queryReply('02', '00', '99999999', 100_000)];
      await run();
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempt_count: 2 });
    });

    it('abort ngay sau khi VNPay trả accepted → vẫn ghi done, có mã hoàn, không gọi VNPay lần nữa', async () => {
      const { refundId } = await requested();
      const ac = new AbortController();
      refundSteps = [
        (req) => {
          ac.abort();
          return refundOk()(req);
        },
      ];
      await run(refunds, ac.signal);
      const r = await refundRow(refundId);
      expect(r).toMatchObject({
        status: 'done',
        attempt_count: 1,
        completed: true,
        confirmed_via_query: false,
      });
      expect(String(r['gateway_refund_no'])).toMatch(/^\d+$/);
      expect(calls).toHaveLength(1);
      expect(await run()).toBe(0);
      expect(calls).toHaveLength(1);
    });

    it('sập sau khi gửi, trước tx2 (lượt đầu) → lượt sau chỉ truy vấn, không gửi lại', async () => {
      const { t, refundId } = await requested();
      failNextTx2();
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 0,
        last_error_kind: null,
        unfinished_claims: 1,
      });
      expect(sent('refund')).toHaveLength(1);
      await makeDue(refundId);
      calls = [];
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('late_payment', () => {
    it('gửi late_gateway_ref, số late_amount_vnd; done → late_refunded_at = completed_at', async () => {
      const t = await topUp({ late: 90_000 });
      const { refundId } = await topUps.refundLatePayment(t.id, admin);
      await run();
      expect(sent('refund')[0]).toMatchObject({
        vnp_TxnRef: t.ref,
        vnp_TransactionNo: t.lateTxn,
        vnp_Amount: '9000000',
        vnp_TransactionType: '02',
      });
      expect(await refundRow(refundId)).toMatchObject({ status: 'done', amount_vnd: 90_000 });
      expect(
        await one(
          `SELECT t.late_refunded_at = f.completed_at AS same
           FROM top_ups t JOIN refunds f ON f.top_up_id = t.id WHERE f.id = $1`,
          [refundId],
        ),
      ).toEqual({ same: true });
    });

    it('lượt 2 querydr trả giao dịch đầu (mã gốc) → không gửi, hẹn lượt sau', async () => {
      const t = await topUp({ late: 90_000 });
      const { refundId } = await topUps.refundLatePayment(t.id, admin);
      refundSteps = [HTTP_500];
      await run();
      await makeDue(refundId);
      calls = [];
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', attempt_count: 2 });
      expect(await one('SELECT late_refunded_at FROM top_ups WHERE id=$1', [t.id])).toEqual({
        late_refunded_at: null,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('account_closure (seed)', () => {
    async function closedWithTwo() {
      const owner = await newDriver();
      const a = await topUp({ owner, status: 'refunded' });
      const b = await topUp({ owner, status: 'refunded' });
      await q(`UPDATE credit_accounts SET status='closed', closed_at=now() WHERE id=$1`, [
        owner.account,
      ]);
      const mk = async (id: number) =>
        Number(
          (
            await one(
              `INSERT INTO refunds (top_up_id, kind, amount_vnd) VALUES ($1,'account_closure',40000)
               RETURNING id`,
              [id],
            )
          )['id'],
        );
      return { owner, ra: await mk(a.id), rb: await mk(b.id), a };
    }
    const closure = async (account: number) =>
      (await one('SELECT closure_refunded_at FROM credit_accounts WHERE id=$1', [account]))[
        'closure_refunded_at'
      ];

    it('còn refund chưa done → NULL; refund cuối done → closure_refunded_at; gửi system, 03', async () => {
      const { owner, ra, rb, a } = await closedWithTwo();
      await q(`UPDATE refunds SET next_attempt_at = now() + interval '1 day' WHERE id=$1`, [rb]);
      await run();
      expect(await refundRow(ra)).toMatchObject({ status: 'done' });
      expect(await closure(owner.account)).toBeNull();
      expect(sent('refund')[0]).toMatchObject({
        vnp_TransactionNo: a.txn,
        vnp_Amount: '4000000',
        vnp_TransactionType: '03',
        vnp_CreateBy: 'system',
      });
      await makeDue(rb);
      await run();
      expect(await closure(owner.account)).not.toBeNull();
    });

    it('hai refund cuối xong song song → closure_refunded_at vẫn được ghi', async () => {
      const { owner } = await closedWithTwo();
      const other = new RefundService(db, vnpay, runner, WORK);
      await Promise.all([run(), run(other)]);
      expect(await closure(owner.account)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('onExhausted và Admin retry', () => {
    async function nearExhausted(attempts = 0) {
      const made = await requested();
      await q('UPDATE refunds SET unfinished_claims = 5, attempt_count = $2 WHERE id=$1', [
        made.refundId,
        attempts,
      ]);
      return made;
    }

    it('unfinished_claims = 6 → failed, attempt_count = 4, retry_exhausted, không gọi VNPay', async () => {
      const { refundId } = await nearExhausted();
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        attempt_count: 4,
        last_error_kind: 'transient',
        last_error_message: 'retry_exhausted',
        unfinished_claims: 6,
        no_next: true,
      });
      expect(calls).toHaveLength(0);
      expect(logged(errorSpy, 'refund_failed')).toHaveLength(1);
    });

    it('attempt_count đã 5 → max(+1, 4) = 6', async () => {
      const { refundId } = await nearExhausted(5);
      await run();
      expect(await refundRow(refundId)).toMatchObject({ status: 'failed', attempt_count: 6 });
    });

    it('Admin retry: requested, unfinished_claims = 0, giữ attempt_count; lượt kế truy vấn trước', async () => {
      const { t, refundId } = await nearExhausted();
      await run();
      calls = [];
      expect(await refunds.retry(refundId, admin)).toEqual({
        refundId,
        status: 'requested',
        attemptCount: 4,
      });
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        unfinished_claims: 0,
        attempt_count: 4,
      });
      expect(kick).toHaveBeenCalledWith(REFUND_SEND_WORK);
      querySteps = [queryReply('02', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({ status: 'done' });
    });

    it('sau Admin retry, querydr 01 / 00 → gửi đúng một lần', async () => {
      const { t, refundId } = await exhaustedRefund();
      await refunds.retry(refundId, admin);
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(1);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'done',
        confirmed_via_query: false,
      });
    });

    it('(a) hết lượt, Admin retry, lượt retry lỗi tạm thời → failed ngay, không lượt tự động nào gửi tiếp', async () => {
      const { t, refundId } = await exhaustedRefund();
      await refunds.retry(refundId, admin);
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      refundSteps = [HTTP_500];
      await run();
      expect(sent('refund')).toHaveLength(1);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        attempt_count: 5,
        no_next: true,
      });
      calls = [];
      expect(await run()).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('(b) bị từ chối, Admin retry, lượt retry lỗi tạm thời → requested; lượt tự động querydr 01 / 00 không gửi', async () => {
      const { t, refundId } = await rejectedRefund();
      await refunds.retry(refundId, admin);
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      refundSteps = [HTTP_500];
      await run();
      expect(sent('refund')).toHaveLength(1);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 2,
        last_error_kind: 'transient',
      });
      await makeDue(refundId);
      calls = [];
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
    });

    it('sập sau khi gửi ở lượt Admin retry → lượt sau chỉ truy vấn, không gửi lại', async () => {
      const { t, refundId } = await exhaustedRefund();
      await refunds.retry(refundId, admin);
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      failNextTx2();
      await run();
      expect(sent('refund')).toHaveLength(1);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 4,
        unfinished_claims: 1,
      });
      await makeDue(refundId);
      calls = [];
      querySteps = [queryReply('01', '00', t.txn, 100_000)];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
    });

    it('Admin retry mà querydr trả 99 → không gửi, về failed', async () => {
      const { refundId } = await exhaustedRefund();
      await refunds.retry(refundId, admin);
      querySteps = [QUERY_99];
      await run();
      expect(sent('querydr')).toHaveLength(1);
      expect(sent('refund')).toHaveLength(0);
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        attempt_count: 5,
        last_error_kind: 'transient',
        no_next: true,
      });
    });

    it('retry: không có dòng → RefundNotFound; sai trạng thái → InvalidTransition', async () => {
      await expect(refunds.retry(999_999_999, admin)).rejects.toBeInstanceOf(RefundNotFound);
      const { refundId } = await requested();
      await expect(refunds.retry(refundId, admin)).rejects.toBeInstanceOf(InvalidTransition);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('lease', () => {
    it('mất lease giữa chừng → bỏ kết quả, không ghi, log refund_lease_lost', async () => {
      const { refundId } = await requested();
      refundSteps = [
        async (req) => {
          await q(`UPDATE refunds SET next_attempt_at = now() + interval '7 minutes' WHERE id=$1`, [
            refundId,
          ]);
          return refundOk()(req);
        },
      ];
      await run();
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        attempt_count: 0,
        gateway_refund_no: null,
        unfinished_claims: 1,
      });
      expect(logged(logSpy, 'refund_lease_lost')).toHaveLength(1);
    });

    it('hai worker song song: mỗi refund gọi VNPay đúng một lần', async () => {
      const a = await requested();
      const b = await requested();
      const other = new RefundService(db, vnpay, runner, WORK);
      await Promise.all([run(), run(other)]);
      const orders = sent('refund').map((c) => c['vnp_OrderInfo']);
      expect(orders.sort()).toEqual(
        [`Hoan tien PowerMe ${a.refundId}`, `Hoan tien PowerMe ${b.refundId}`].sort(),
      );
      expect(await refundRow(a.refundId)).toMatchObject({ status: 'done', attempt_count: 1 });
      expect(await refundRow(b.refundId)).toMatchObject({ status: 'done', attempt_count: 1 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('TopUpService.refund (TC-STM4-12/13/14)', () => {
    it('hợp lệ: sổ cái −số tiền, refunded, refund requested, kick sau commit', async () => {
      const t = await topUp();
      const out = await topUps.refund(t.id, admin);
      expect(out).toEqual({ refundId: expect.any(Number), status: 'requested' });
      expect(await balance(t.account)).toBe(0);
      expect(await ledgerRows(t.id)).toEqual([
        { transaction_type: 'refund', amount_vnd: -100_000 },
      ]);
      expect(
        await one('SELECT status::text, refunded_at IS NOT NULL AS r FROM top_ups WHERE id=$1', [
          t.id,
        ]),
      ).toEqual({
        status: 'refunded',
        r: true,
      });
      expect(await refundRow(out.refundId)).toMatchObject({
        status: 'requested',
        kind: 'top_up',
        amount_vnd: 100_000,
        attempt_count: 0,
      });
      expect(kick).toHaveBeenCalledWith(REFUND_SEND_WORK);
    });

    it('có điểm (nạp 100.000, điểm 20.000, trả 80.000): ví −100.000, một dòng −100.000, VNPay 80.000 × 100, điểm trả lại', async () => {
      const t = await topUpWithPoints();
      expect(await points(t.driver)).toBe(1000);
      const { refundId } = await topUps.refund(t.id, admin);
      expect(await balance(t.account)).toBe(0);
      expect(await ledgerRows(t.id)).toEqual([
        { transaction_type: 'refund', amount_vnd: -100_000 },
      ]);
      expect(await points(t.driver)).toBe(3000);
      expect(await refundRow(refundId)).toMatchObject({ amount_vnd: 80_000 });
      await run();
      expect(sent('refund')[0]).toMatchObject({
        vnp_Amount: String(80_000 * 100),
        vnp_TransactionType: '02',
      });
      expect(await refundRow(refundId)).toMatchObject({ status: 'done' });
    });

    it('có điểm, số dư khả dụng 90.000 (đủ 80.000, thiếu 100.000) → insufficient_available_balance', async () => {
      const t = await topUpWithPoints();
      await holdIntent(t.driver, 10_000);
      await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({
        reason: 'insufficient_available_balance',
      });
      expect(await balance(t.account)).toBe(100_000);
      expect(await ledgerRows(t.id)).toEqual([]);
      expect(await points(t.driver)).toBe(1000);
      expect(await refundCount(t.id)).toBe(0);
    });

    it('không có top-up → not_found', async () => {
      await expect(topUps.refund(999_999_999, admin)).rejects.toMatchObject({
        reason: 'not_found',
      });
    });

    it('tài khoản closed → account_closed (kiểm trước trạng thái)', async () => {
      const t = await topUp({ status: 'failed' });
      await q(`UPDATE credit_accounts SET status='closed', closed_at=now() WHERE id=$1`, [
        t.account,
      ]);
      await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({ reason: 'account_closed' });
    });

    it.each(['pending', 'failed', 'refunded'])('top-up %s → not_refundable', async (status) => {
      const t = await topUp({ status });
      await expect(topUps.refund(t.id, admin)).rejects.toBeInstanceOf(RefundNotAllowed);
      await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({ reason: 'not_refundable' });
      expect(await refundCount(t.id)).toBe(0);
    });

    it('intent đang giữ chỗ làm số dư khả dụng thiếu → insufficient_available_balance, không ghi gì', async () => {
      const t = await topUp();
      await holdIntent(t.driver, 1);
      await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({
        reason: 'insufficient_available_balance',
      });
      expect(await balance(t.account)).toBe(100_000);
      expect(await one('SELECT status::text FROM top_ups WHERE id=$1', [t.id])).toEqual({
        status: 'credited',
      });
      expect(await refundCount(t.id)).toBe(0);
    });

    it('gọi hai lần → lần hai not_refundable (TC-STM4-14)', async () => {
      const t = await topUp();
      await topUps.refund(t.id, admin);
      await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({ reason: 'not_refundable' });
      expect(await refundCount(t.id)).toBe(1);
    });

    it('hai connection đồng thời → một refund, sổ cái một dòng', async () => {
      const t = await topUp();
      const results = await Promise.allSettled([
        topUps.refund(t.id, admin),
        topUps.refund(t.id, admin),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ reason: 'not_refundable' });
      expect(await refundCount(t.id)).toBe(1);
      expect(await ledgerRows(t.id)).toHaveLength(1);
      expect(await balance(t.account)).toBe(0);
    });

    it('amount_paid_vnd = 0 (dòng ghi ngoài API) → ném, rollback, không đổi gì', async () => {
      const t = await topUp({ amount: 100_000, discount: 100_000, points: 10_000 });
      await expect(topUps.refund(t.id, admin)).rejects.toThrow('refund_invalid_paid_amount');
      expect(await balance(t.account)).toBe(100_000);
      expect(await ledgerRows(t.id)).toEqual([]);
      expect(await one('SELECT status::text FROM top_ups WHERE id=$1', [t.id])).toEqual({
        status: 'credited',
      });
      expect(await refundCount(t.id)).toBe(0);
    });

    it('VNPay chưa cấu hình → payment_unconfigured, không đổi gì', async () => {
      const t = await topUp();
      const off = new TopUpService(
        db,
        ledger,
        loyalty,
        new VnpayAdapter({ ...VNPAY, configured: false }, API, fakeFetch),
        runner,
        WORK,
        undefined,
        refunds,
      );
      await expect(off.refund(t.id, admin)).rejects.toMatchObject({
        reason: 'payment_unconfigured',
      });
      await expect(off.refundLatePayment(t.id, admin)).rejects.toMatchObject({
        reason: 'payment_unconfigured',
      });
      expect(await balance(t.account)).toBe(100_000);
      expect(await ledgerRows(t.id)).toEqual([]);
      expect(await one('SELECT status::text FROM top_ups WHERE id=$1', [t.id])).toEqual({
        status: 'credited',
      });
      expect(await refundCount(t.id)).toBe(0);
    });

    it('thiếu RefundService → ném rõ ràng trước khi mở transaction, không đổi gì', async () => {
      const t = await topUp({ late: 50_000 });
      const bare = new TopUpService(db, ledger, loyalty, vnpay);
      const connect = jest.spyOn(db.$client, 'connect');
      await expect(bare.refund(t.id, admin)).rejects.toThrow('refund_service_unavailable');
      await expect(bare.refundLatePayment(t.id, admin)).rejects.toThrow(
        'refund_service_unavailable',
      );
      expect(connect).not.toHaveBeenCalled();
      connect.mockRestore();
      expect(await balance(t.account)).toBe(100_000);
      expect(await refundCount(t.id)).toBe(0);
    });

    // Hoàn tiền thủ công (WF-02 D1, D-AC / BR-P51, review Ân #212): quyết định hoàn không còn chặn
    // top-up thiếu mã giao dịch VNPay; đi tiếp các kiểm khác như cũ.
    describe('thiếu gateway_transaction_no không còn chặn quyết định hoàn', () => {
      const dropTxn = (id: number) =>
        q('UPDATE top_ups SET gateway_transaction_no = NULL WHERE id=$1', [id]);

      it('credited thiếu mã → hoàn được: refunded, ví −100.000, điểm trả lại, refund requested', async () => {
        const t = await topUpWithPoints();
        await dropTxn(t.id);
        const { refundId } = await topUps.refund(t.id, admin);
        expect(await balance(t.account)).toBe(0);
        expect(await ledgerRows(t.id)).toEqual([
          { transaction_type: 'refund', amount_vnd: -100_000 },
        ]);
        expect(await points(t.driver)).toBe(3000);
        expect(await one('SELECT status::text FROM top_ups WHERE id=$1', [t.id])).toEqual({
          status: 'refunded',
        });
        expect(await refundRow(refundId)).toMatchObject({
          status: 'requested',
          amount_vnd: 80_000,
        });
        expect(await refundCount(t.id)).toBe(1);
      });

      it('tài khoản closed kiểm trước: closed + thiếu mã → account_closed', async () => {
        const t = await topUp();
        await dropTxn(t.id);
        await q(`UPDATE credit_accounts SET status='closed', closed_at=now() WHERE id=$1`, [
          t.account,
        ]);
        await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({
          reason: 'account_closed',
        });
      });

      it('thiếu mã + số dư khả dụng thiếu → insufficient_available_balance', async () => {
        const t = await topUp();
        await dropTxn(t.id);
        await holdIntent(t.driver, 1);
        await expect(topUps.refund(t.id, admin)).rejects.toMatchObject({
          reason: 'insufficient_available_balance',
        });
        expect(await refundCount(t.id)).toBe(0);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('TopUpService.refundLatePayment', () => {
    it('hợp lệ: không sổ cái, trạng thái top-up giữ, amount = late_amount_vnd', async () => {
      const t = await topUp({ late: 90_000 });
      const out = await topUps.refundLatePayment(t.id, admin);
      expect(await refundRow(out.refundId)).toMatchObject({
        status: 'requested',
        kind: 'late_payment',
        amount_vnd: 90_000,
      });
      expect(await ledgerRows(t.id)).toEqual([]);
      expect(await balance(t.account)).toBe(100_000);
      expect(await one('SELECT status::text FROM top_ups WHERE id=$1', [t.id])).toEqual({
        status: 'credited',
      });
      expect(kick).toHaveBeenCalledWith(REFUND_SEND_WORK);
    });

    it('tài khoản closed vẫn được', async () => {
      const t = await topUp({ status: 'failed', late: 60_000 });
      await q(`UPDATE credit_accounts SET status='closed', closed_at=now() WHERE id=$1`, [
        t.account,
      ]);
      const out = await topUps.refundLatePayment(t.id, admin);
      expect(await refundRow(out.refundId)).toMatchObject({ amount_vnd: 60_000 });
    });

    it('gọi lại → already_requested; hai connection đồng thời → một refund', async () => {
      const t = await topUp({ late: 90_000 });
      await topUps.refundLatePayment(t.id, admin);
      await expect(topUps.refundLatePayment(t.id, admin)).rejects.toMatchObject({
        reason: 'already_requested',
      });
      const u = await topUp({ late: 70_000 });
      const results = await Promise.allSettled([
        topUps.refundLatePayment(u.id, admin),
        topUps.refundLatePayment(u.id, admin),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await refundCount(u.id)).toBe(1);
    });

    it('không có khoản trễ → no_late_payment; không có top-up → not_found', async () => {
      const t = await topUp();
      await expect(topUps.refundLatePayment(t.id, admin)).rejects.toMatchObject({
        reason: 'no_late_payment',
      });
      await expect(topUps.refundLatePayment(999_999_999, admin)).rejects.toMatchObject({
        reason: 'not_found',
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('BillingModule thật (Nest), BILLING_WORKER_ENABLED=false', () => {
    it('khởi động được, refund-send được đăng ký, TopUpService được tiêm RefundService', async () => {
      const saved = process.env['BILLING_WORKER_ENABLED'];
      process.env['BILLING_WORKER_ENABLED'] = 'false';
      @Module({ imports: [ConfigModule, BillingModule] })
      class TestModule {}
      try {
        const app = await NestFactory.createApplicationContext(TestModule, {
          logger: ['error'],
          abortOnError: false,
        });
        try {
          expect(() => app.get(BackgroundWorkRunner).kick(REFUND_SEND_WORK)).not.toThrow();
          const svc = app.get(RefundService);
          expect((app.get(TopUpService) as unknown as { refunds: unknown }).refunds).toBe(svc);
        } finally {
          await app.close();
        }
      } finally {
        if (saved === undefined) delete process.env['BILLING_WORKER_ENABLED'];
        else process.env['BILLING_WORKER_ENABLED'] = saved;
      }
    });
  });
});
