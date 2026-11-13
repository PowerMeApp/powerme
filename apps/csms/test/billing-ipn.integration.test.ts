/**
 * Test tích hợp IPN VNPay — `TopUpService.applyPaymentResult` (T32 Phần 6, SD-2b, decisions D3/D4)
 * trên Postgres thật.
 *
 * Vì sao tồn tại: đây là chỗ DUY NHẤT (cùng querydr của Phần 8) cộng tiền thật vào ví. Hỏng âm thầm
 * có thể là: IPN giả (sai chữ ký / sai mã merchant) cộng được tiền, IPN lặp cộng hai lần, hai IPN
 * song song cùng cộng, lần trả thứ hai bị nuốt (không ghi khoản trễ để Admin hoàn), mã 07 / 01 / 04
 * (đã trừ tiền nhưng chưa ngã ngũ) bị coi là thất bại, sổ điểm hỏng chặn cộng tiền, hoặc lỗi khác ở
 * bước điểm để lại tiền đã cộng mà không trừ điểm.
 *
 * Tham số IPN ký bằng đúng `vnpSignData` / `vnpSecureHash` của adapter với cấu hình test (secret giả).
 * Mã TC theo Report 5 bản nộp 09/11 (TC-STM4-01…08); ca khác đặt tên theo nội dung.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import {
  buildPaymentUrl,
  VnpayAdapter,
  vnpSecureHash,
  vnpSignData,
} from '../src/billing/vnpay.adapter.js';
import type { VnpayConfig } from '../src/billing/vnpay.config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const LOCK_WAIT_TIMEOUT_MS = 5000;
const IP = '203.0.113.7';
const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};

type Params = Record<string, string>;

/** Ký tham số như VNPay (bỏ chữ ký cũ nếu có). */
function sign(params: Params, secret = VNPAY.hashSecret): Params {
  const rest = { ...params };
  delete rest['vnp_SecureHash'];
  delete rest['vnp_SecureHashType'];
  return { ...rest, vnp_SecureHash: vnpSecureHash(vnpSignData(rest), secret) };
}

describeDb('billing: IPN VNPay — TopUpService.applyPaymentResult (T32 Phần 6, SD-2b)', () => {
  let db: Db;
  let loyalty: LoyaltyService;
  let service: TopUpService;
  let unconfigured: TopUpService;
  let seq = 0;
  let txn = 70_000_000;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const nextTxn = () => String(++txn);

  async function newDriver(): Promise<number> {
    seq += 1;
    const u = Number(
      (
        await one("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `d${seq}@t32p6.test`,
        ])
      )['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    await new CreditLedgerService(db).ensureAccounts(u);
    return u;
  }

  async function earn(driverId: number, points: number, expiresIn: string) {
    const acc = Number(
      (await one('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [driverId]))['id'],
    );
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,now()+$3::interval
       FROM loyalty_transactions WHERE loyalty_account_id=$1`,
      [acc, points, expiresIn],
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

  /** Top-up pending thật qua `create` (SD-2a). */
  async function pendingTopUp(amountVnd = 200_000, pointsToRedeem = 0, d?: number): Promise<Made> {
    const driverId = d ?? (await newDriver());
    const { topUp } = await service.create(
      driverId,
      `ipn-key-${++seq}`,
      { amountVnd, pointsToRedeem },
      IP,
    );
    const ref = String(
      (await one('SELECT gateway_reference FROM top_ups WHERE id=$1', [topUp.topUpId]))[
        'gateway_reference'
      ],
    );
    return {
      driverId,
      topUpId: topUp.topUpId,
      ref,
      amountPaidVnd: topUp.amountPaidVnd,
      amountVnd: topUp.amountVnd,
    };
  }

  /** Tham số IPN đã ký cho top-up (mặc định: thanh toán thành công). */
  function ipn(t: Made, over: Partial<Params> = {}): Params {
    const base: Params = {
      vnp_TmnCode: VNPAY.tmnCode,
      vnp_Amount: String(t.amountPaidVnd * 100),
      vnp_BankCode: 'NCB',
      vnp_BankTranNo: 'VNP14000000',
      vnp_CardType: 'ATM',
      vnp_OrderInfo: `Nap tien PowerMe ${t.ref}`,
      vnp_PayDate: '20261113103000',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: nextTxn(),
      vnp_TxnRef: t.ref,
    };
    const merged: Params = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    return sign(merged);
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
  const loyaltyRows = (topUpId: number) =>
    q(
      `SELECT transaction_type, points FROM loyalty_transactions WHERE top_up_id=$1
       ORDER BY entry_no`,
      [topUpId],
    );
  const snapshot = async (t: Made) => ({
    top: await topUpRow(t.topUpId),
    balance: await balance(t.driverId),
    credit: await creditRows(t.topUpId),
    loyalty: await loyaltyRows(t.topUpId),
  });

  /** Đưa top-up sang trạng thái cho trước bằng SQL (fixture). */
  async function setStatus(id: number, status: 'failed' | 'expired') {
    await q(
      `UPDATE top_ups SET status=$2::top_up_status, completed_at=now(), next_attempt_at=NULL
       WHERE id=$1`,
      [id, status],
    );
  }

  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const logged = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes(`"event":"${event}"`))
      .map((m) => JSON.parse(m) as Record<string, unknown>);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const ledger = new CreditLedgerService(db);
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    service = new TopUpService(db, ledger, loyalty, new VnpayAdapter(VNPAY));
    unconfigured = new TopUpService(
      db,
      ledger,
      loyalty,
      new VnpayAdapter({ ...VNPAY, configured: false, tmnCode: '', hashSecret: '' }),
    );
  });
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('TC-STM4-02: thanh toán thành công cộng tiền đúng một lần', () => {
    it('IPN thành công → credited, số dư + amount, gateway_transaction_no, next_attempt_at NULL, completed_at; lặp → 02; lần trả thứ hai → khoản trễ; khoản thứ ba → 02 + log error', async () => {
      const t = await pendingTopUp(200_000);
      const first = ipn(t);
      expect(await service.applyPaymentResult(first)).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({
        status: 'credited',
        gateway_transaction_no: first['vnp_TransactionNo'],
        next_attempt_at: null,
        late_gateway_ref: null,
        exception_kind: null,
      });
      expect(row['completed_at']).not.toBeNull();
      const completedText = String(
        (await one('SELECT completed_at::text AS c FROM top_ups WHERE id=$1', [t.topUpId]))['c'],
      );
      expect(await balance(t.driverId)).toBe(200_000);
      expect(await creditRows(t.topUpId)).toBe(1);

      // IPN lặp cùng vnp_TransactionNo → 02, không cộng lần hai.
      const afterFirst = await snapshot(t);
      expect(await service.applyPaymentResult(first)).toEqual({
        RspCode: '02',
        Message: 'Order already confirmed',
      });
      expect(await snapshot(t)).toEqual(afterFirst);

      // Lần trả thứ hai (khác vnp_TransactionNo) → 00, ghi khoản trễ, số dư không đổi, vẫn credited.
      const second = ipn(t, { vnp_PayDate: '20261113104500' });
      expect((await service.applyPaymentResult(second)).RspCode).toBe('00');
      const late = await one(
        `SELECT status, late_gateway_ref, late_amount_vnd, late_paid_at = $2::timestamptz AS paid_ok,
           completed_at::text = $3 AS completed_same
         FROM top_ups WHERE id=$1`,
        [t.topUpId, '2026-11-13T03:45:00Z', completedText],
      );
      expect(late).toEqual({
        status: 'credited',
        late_gateway_ref: second['vnp_TransactionNo'],
        late_amount_vnd: String(200_000),
        paid_ok: true,
        completed_same: true,
      });
      expect(await balance(t.driverId)).toBe(200_000);
      expect(await creditRows(t.topUpId)).toBe(1);

      // Khoản trễ lặp → 02.
      const afterLate = await snapshot(t);
      expect((await service.applyPaymentResult(second)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(afterLate);

      // Khoản thứ ba → 02, không ghi gì, log error có cấu trúc.
      const third = ipn(t);
      expect((await service.applyPaymentResult(third)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(afterLate);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toEqual([
        expect.objectContaining({
          top_up_id: t.topUpId,
          gateway_reference: t.ref,
          vnp_TransactionNo: third['vnp_TransactionNo'],
          gateway_transaction_no: first['vnp_TransactionNo'],
          late_gateway_ref: second['vnp_TransactionNo'],
          vnp_Amount: String(200_000 * 100),
          amount_paid_vnd: 200_000,
        }),
      ]);
    });

    it('việc sau commit (afterPaymentCommitted) ném lỗi → vẫn trả 00, top-up đã credited, log error ipn_after_commit_failed', async () => {
      const t = await pendingTopUp(100_000);
      jest
        .spyOn(
          service as unknown as { afterPaymentCommitted: () => Promise<void> },
          'afterPaymentCommitted',
        )
        .mockRejectedValueOnce(new Error('after-commit boom'));
      expect(await service.applyPaymentResult(ipn(t))).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
      expect(await balance(t.driverId)).toBe(100_000);
      expect(await creditRows(t.topUpId)).toBe(1);
      expect(logged(errorSpy, 'ipn_after_commit_failed')).toEqual([
        {
          event: 'ipn_after_commit_failed',
          top_up_id: t.topUpId,
          outcome: 'credited',
          error: 'after-commit boom',
        },
      ]);
      expect(logged(errorSpy, 'ipn_unexpected_error')).toEqual([]);
    });

    it('tài khoản in_shortfall → active khi số dư sau nạp ≥ 0', async () => {
      const d = await newDriver();
      // Số dư âm qua sổ cái (post đưa tài khoản sang in_shortfall).
      const acc = Number(
        (await one('SELECT id FROM credit_accounts WHERE driver_id=$1', [d]))['id'],
      );
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        await new CreditLedgerService(db).post(c, acc, 'adjustment', -30_000);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect((await one('SELECT status FROM credit_accounts WHERE id=$1', [acc]))['status']).toBe(
        'in_shortfall',
      );
      const t = await pendingTopUp(100_000, 0, d);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(
        await one('SELECT status, balance_vnd FROM credit_accounts WHERE id=$1', [acc]),
      ).toEqual({ status: 'active', balance_vnd: '70000' });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('TC-STM4-03: thất bại và chưa ngã ngũ', () => {
    it('IPN thất bại (24, khách huỷ) → failed, next_attempt_at NULL, completed_at; không cộng; lặp → 02', async () => {
      const t = await pendingTopUp();
      const p = ipn(t, {
        vnp_ResponseCode: '24',
        vnp_TransactionStatus: '02',
        vnp_TransactionNo: '0',
      });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      const row = await topUpRow(t.topUpId);
      expect(row).toMatchObject({
        status: 'failed',
        next_attempt_at: null,
        gateway_transaction_no: null,
      });
      expect(row['completed_at']).not.toBeNull();
      expect(await balance(t.driverId)).toBe(0);
      expect(await creditRows(t.topUpId)).toBe(0);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
    });

    it.each([
      ['vnp_ResponseCode 07 (đã trừ tiền, nghi gian lận)', { vnp_ResponseCode: '07' }],
      [
        'vnp_TransactionStatus 01 (chưa hoàn tất)',
        { vnp_ResponseCode: '99', vnp_TransactionStatus: '01' },
      ],
      [
        'vnp_TransactionStatus 04 (giao dịch đảo)',
        { vnp_ResponseCode: '99', vnp_TransactionStatus: '04' },
      ],
      ['vnp_TransactionStatus 07', { vnp_ResponseCode: '99', vnp_TransactionStatus: '07' }],
    ])('%s → vẫn pending, trả 00, không ghi gì', async (_label, over) => {
      const t = await pendingTopUp();
      const before = await snapshot(t);
      expect((await service.applyPaymentResult(ipn(t, over))).RspCode).toBe('00');
      expect(await snapshot(t)).toEqual(before);
      expect(before.top['status']).toBe('pending');
      expect(before.top['next_attempt_at']).not.toBeNull();
    });

    it.each([
      ['ResponseCode 00, TransactionStatus 02', { vnp_TransactionStatus: '02' }],
      ['ResponseCode 24, TransactionStatus 00', { vnp_ResponseCode: '24' }],
    ])(
      'chỉ một mã là 00 (%s) → chưa ngã ngũ: vẫn pending, 00, log warn kèm hai mã',
      async (_label, over) => {
        const t = await pendingTopUp();
        const before = await snapshot(t);
        const p = ipn(t, over);
        expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
        expect(await snapshot(t)).toEqual(before);
        expect(logged(warnSpy, 'ipn_unresolved_one_zero')).toEqual([
          expect.objectContaining({
            top_up_id: t.topUpId,
            gateway_reference: t.ref,
            vnp_ResponseCode: p['vnp_ResponseCode'],
            vnp_TransactionStatus: p['vnp_TransactionStatus'],
          }),
        ]);
      },
    );

    it('chưa ngã ngũ tới khi top-up đã rời pending → không ghi gì, 00, log info kèm status và hai mã', async () => {
      const t = await pendingTopUp();
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const before = await snapshot(t);
      const p = ipn(t, { vnp_ResponseCode: '07' });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(logSpy, 'ipn_unresolved')).toEqual([
        expect.objectContaining({
          top_up_id: t.topUpId,
          status: 'credited',
          vnp_ResponseCode: '07',
          vnp_TransactionStatus: '00',
        }),
      ]);
    });

    it('báo lỗi trên top-up đã credited → 02, không ghi gì, log error', async () => {
      const t = await pendingTopUp();
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const before = await snapshot(t);
      const p = ipn(t, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02' });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('thành công tới khi top-up đã quá hạn / đã có kết quả', () => {
    it('TC-STM4-04 (bước IPN): pending đã quá expires_at, IPN thành công → credited (#2)', async () => {
      const t = await pendingTopUp(150_000);
      await q(
        `UPDATE top_ups SET created_at = now() - interval '30 minutes',
           expires_at = now() - interval '15 minutes', next_attempt_at = now() - interval '13 minutes'
         WHERE id=$1`,
        [t.topUpId],
      );
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'credited',
        next_attempt_at: null,
      });
      expect(await balance(t.driverId)).toBe(150_000);
    });

    it.each(['failed', 'expired'] as const)(
      '%s: thành công → khoản trễ, giữ trạng thái, không cộng; lặp → 02 (TC-STM4-05 cho failed, #6 cho expired)',
      async (status) => {
        const t = await pendingTopUp(120_000);
        await setStatus(t.topUpId, status);
        const completedText = async () =>
          (await one('SELECT completed_at::text AS c FROM top_ups WHERE id=$1', [t.topUpId]))['c'];
        const completed = await completedText();
        const p = ipn(t);
        expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
        const row = await topUpRow(t.topUpId);
        expect(row).toMatchObject({
          status,
          late_gateway_ref: p['vnp_TransactionNo'],
          late_amount_vnd: '120000',
          gateway_transaction_no: null,
        });
        expect(await completedText()).toBe(completed);
        expect(await balance(t.driverId)).toBe(0);
        expect(await creditRows(t.topUpId)).toBe(0);
        const before = await snapshot(t);
        expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
        expect(await snapshot(t)).toEqual(before);
      },
    );

    it('refunded: lần trả thứ hai → khoản trễ, giữ refunded; lặp → 02', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      await q("UPDATE top_ups SET status='refunded', refunded_at=now() WHERE id=$1", [t.topUpId]);
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'refunded',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: '100000',
      });
      expect(await creditRows(t.topUpId)).toBe(1);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
    });

    it('late_paid_at: thiếu vnp_PayDate → giờ nhận IPN (đồng hồ DB)', async () => {
      const t = await pendingTopUp();
      await setStatus(t.topUpId, 'expired');
      expect((await service.applyPaymentResult(ipn(t, { vnp_PayDate: undefined }))).RspCode).toBe(
        '00',
      );
      const r = await one(
        `SELECT abs(extract(epoch FROM late_paid_at - now())) < 60 AS near FROM top_ups WHERE id=$1`,
        [t.topUpId],
      );
      expect(r['near']).toBe(true);
    });

    it('late_paid_at: vnp_PayDate theo GMT+7 → timestamptz đúng', async () => {
      const t = await pendingTopUp();
      await setStatus(t.topUpId, 'failed');
      await service.applyPaymentResult(ipn(t, { vnp_PayDate: '20261231235959' }));
      const r = await one(
        `SELECT late_paid_at = '2026-12-31T16:59:59Z'::timestamptz AS ok FROM top_ups WHERE id=$1`,
        [t.topUpId],
      );
      expect(r['ok']).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('kiểm request: không ghi gì nếu lỗi', () => {
    it.each([
      ['sai chữ ký (sửa số tiền sau khi ký)', (p: Params) => ({ ...p, vnp_Amount: '1' })],
      [
        'thiếu chữ ký',
        (p: Params) => {
          const r = { ...p };
          delete r['vnp_SecureHash'];
          return r;
        },
      ],
      ['chữ ký sai secret', (p: Params) => sign(p, 'OTHERSECRET')],
      ['sai vnp_TmnCode (ký đúng)', (p: Params) => sign({ ...p, vnp_TmnCode: 'OTHERTMN' })],
    ])('%s → 97', async (_label, mutate) => {
      const t = await pendingTopUp();
      const before = await snapshot(t);
      expect(await service.applyPaymentResult(mutate(ipn(t)))).toEqual({
        RspCode: '97',
        Message: 'Invalid signature',
      });
      expect(await snapshot(t)).toEqual(before);
    });

    it('vnp_SecureHashType có cũng không đưa vào chuỗi ký', async () => {
      const t = await pendingTopUp();
      const p = { ...ipn(t), vnp_SecureHashType: 'HmacSHA512' };
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
    });

    it('không thấy vnp_TxnRef → 01', async () => {
      const t = await pendingTopUp();
      const before = await snapshot(t);
      expect(await service.applyPaymentResult(ipn({ ...t, ref: 'PMNOTEXIST000000' }))).toEqual({
        RspCode: '01',
        Message: 'Order not found',
      });
      expect(await snapshot(t)).toEqual(before);
    });

    it('sai số tiền → 04, log warn', async () => {
      const t = await pendingTopUp(200_000);
      const before = await snapshot(t);
      expect(
        await service.applyPaymentResult(ipn(t, { vnp_Amount: String(199_000 * 100) })),
      ).toEqual({ RspCode: '04', Message: 'invalid amount' });
      expect(await snapshot(t)).toEqual(before);
      expect(logged(warnSpy, 'ipn_amount_mismatch')).toHaveLength(1);
    });

    it('thiếu cấu hình VNPay → 99, log error', async () => {
      const t = await pendingTopUp();
      const before = await snapshot(t);
      expect(await unconfigured.applyPaymentResult(ipn(t))).toEqual({
        RspCode: '99',
        Message: 'Unknow error',
      });
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_unconfigured')).toHaveLength(1);
    });

    it('chữ ký đúng nhưng thành công mà thiếu vnp_TransactionNo → 99, không ghi gì', async () => {
      const t = await pendingTopUp();
      const before = await snapshot(t);
      expect(
        (await service.applyPaymentResult(ipn(t, { vnp_TransactionNo: undefined }))).RspCode,
      ).toBe('99');
      expect(await snapshot(t)).toEqual(before);
    });

    it('tham số sinh bằng buildPaymentUrl + vnp_OrderInfo có ký tự đặc biệt: ký và kiểm đúng', async () => {
      const t = await pendingTopUp();
      const row = await topUpRow(t.topUpId);
      const url = new URL(
        buildPaymentUrl(
          {
            gatewayReference: t.ref,
            amountPaidVnd: t.amountPaidVnd,
            createdAt: row['created_at'] as Date,
            expiresAt: row['expires_at'] as Date,
          },
          VNPAY,
          IP,
        ),
      );
      const params: Params = Object.fromEntries(url.searchParams);
      delete params['vnp_SecureHash'];
      Object.assign(params, {
        vnp_OrderInfo: "Nạp tiền #1 & 50% (ưu đãi)! *'~ a+b=c/d?",
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: nextTxn(),
        vnp_PayDate: '20261113103000',
      });
      const signed = sign(params);
      expect((await service.applyPaymentResult(signed)).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['status']).toBe('credited');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('trừ điểm khi cộng tiền (D3 ⊕, chốt Ân 13/11)', () => {
    it('dùng điểm → dòng redeem đúng, cộng đủ amount_vnd', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      expect(t.amountPaidVnd).toBe(94_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(await balance(d)).toBe(100_000);
      expect(await loyaltyRows(t.topUpId)).toEqual([
        { transaction_type: 'redeem', points: '-600' },
      ]);
    });

    it('điểm hết hạn trước lúc cộng → adjust 0, vẫn cộng đủ', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      await q(
        `UPDATE loyalty_transactions SET expires_at = now() - interval '1 minute'
         WHERE transaction_type='earn' AND loyalty_account_id =
           (SELECT id FROM loyalty_accounts WHERE driver_id=$1)`,
        [d],
      );
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(await balance(d)).toBe(100_000);
      expect(await loyaltyRows(t.topUpId)).toEqual([{ transaction_type: 'adjust', points: '0' }]);
      expect((await topUpRow(t.topUpId))['exception_kind']).toBeNull();
    });

    it('sổ điểm hỏng (LoyaltyLedgerCorrupt) → vẫn cộng tiền, không có dòng loyalty mới, exception_kind = loyalty_error, 00; lặp → 02', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      // Lệch snapshot → balance_mismatch.
      await q(
        'UPDATE loyalty_accounts SET points_balance = points_balance + 7 WHERE driver_id=$1',
        [d],
      );
      const loyaltyBefore = await one(
        `SELECT count(*)::int AS n FROM loyalty_transactions WHERE loyalty_account_id =
           (SELECT id FROM loyalty_accounts WHERE driver_id=$1)`,
        [d],
      );
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'credited',
        exception_kind: 'loyalty_error',
        exception_reviewed_at: null,
      });
      expect(await balance(d)).toBe(100_000);
      expect(await loyaltyRows(t.topUpId)).toEqual([]);
      expect(
        await one(
          `SELECT count(*)::int AS n FROM loyalty_transactions WHERE loyalty_account_id =
             (SELECT id FROM loyalty_accounts WHERE driver_id=$1)`,
          [d],
        ),
      ).toEqual(loyaltyBefore);
      const acc = Number(
        (await one('SELECT id FROM loyalty_accounts WHERE driver_id=$1', [d]))['id'],
      );
      expect(logged(errorSpy, 'ipn_loyalty_ledger_corrupt')).toEqual([
        expect.objectContaining({
          reason: 'balance_mismatch',
          top_up_id: t.topUpId,
          loyalty_account_id: acc,
        }),
      ]);
      const before = await snapshot(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
    });

    it('lỗi khác trong bước điểm → rollback toàn bộ, 99, top-up vẫn pending', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      const before = await snapshot(t);
      jest.spyOn(loyalty, 'redeemForTopUp').mockRejectedValueOnce(new Error('boom'));
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('99');
      expect(await snapshot(t)).toEqual(before);
      expect(before.top['status']).toBe('pending');
      expect(logged(errorSpy, 'ipn_unexpected_error')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('race: hai IPN song song cùng vnp_TransactionNo (hai connection thật)', () => {
    async function waitForTopUpLockWaiters(n: number): Promise<void> {
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
      for (;;) {
        const row = await one(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM top_ups WHERE gateway_reference%FOR UPDATE%'`,
        );
        if (Number(row['n']) >= n) return;
        if (Date.now() > deadline) throw new Error(`không thấy ${n} backend chờ khoá top_ups`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it('cộng đúng một lần: một 00, một 02', async () => {
      const t = await pendingTopUp(100_000);
      const p = ipn(t);
      const holder = await db.$client.connect();
      let results: PromiseSettledResult<{ RspCode: string }>[];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM top_ups WHERE id=$1 FOR UPDATE', [t.topUpId]);
        const pending = Promise.allSettled([
          service.applyPaymentResult(p),
          service.applyPaymentResult(p),
        ]);
        try {
          await waitForTopUpLockWaiters(2);
        } finally {
          await holder.query('COMMIT');
        }
        results = await pending;
      } finally {
        holder.release();
      }
      const codes = results.map((r) => (r.status === 'fulfilled' ? r.value.RspCode : 'rejected'));
      expect(codes.sort()).toEqual(['00', '02']);
      expect(await balance(t.driverId)).toBe(100_000);
      expect(await creditRows(t.topUpId)).toBe(1);
    });
  });
});
