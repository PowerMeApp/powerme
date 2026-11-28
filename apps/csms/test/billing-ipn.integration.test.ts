/**
 * Test tích hợp IPN VNPay — `TopUpService.applyPaymentResult` (T32 Phần 6, SD-2b, decisions D3/D4)
 * trên Postgres thật.
 *
 * Vì sao tồn tại: đây là chỗ DUY NHẤT (cùng querydr của Phần 8) cộng tiền thật vào ví. Hỏng âm thầm
 * có thể là: IPN giả (sai chữ ký / sai mã merchant) cộng được tiền, IPN lặp cộng hai lần, hai IPN
 * song song cùng cộng, lần trả thứ hai bị nuốt (không ghi khoản trễ để Admin hoàn), mã 07 / 01 / 04
 * (đã trừ tiền nhưng chưa ngã ngũ) bị coi là thất bại, sổ điểm hỏng chặn cộng tiền, hoặc lỗi khác ở
 * bước điểm để lại tiền đã cộng mà không trừ điểm. Phần 8b: VNPay đã trừ tiền mà không cộng được
 * (sai số tiền / tài khoản `closed`) phải thành `failed` + khoản trễ (số thực trừ) và trả 00 để
 * VNPay ngừng gửi lại, thay vì 04 / 99 không ghi gì. Phần 8b bổ sung (0024): lần trả thành công
 * mâu thuẫn phải thành một dòng `top_up_payment_conflicts` (Admin thấy), không đè `late_*` /
 * `exception_kind`, VNPay gửi lại không thêm dòng. Phần 7: top-up `credited` có đúng một dòng
 * `e_invoices` tạo trong CÙNG transaction cộng tiền (rollback thì không có, việc sau commit lỗi thì
 * vẫn có); khoản trễ / #8 / thất bại / mâu thuẫn không có hoá đơn.
 *
 * Tham số IPN ký bằng đúng `vnpSignData` / `vnpSecureHash` của adapter với cấu hình test (secret giả).
 * Mã TC theo Report 5 bản nộp 09/11 (TC-STM4-01…08); ca khác đặt tên theo nội dung.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import type { BackgroundWorkRunner } from '../src/billing/background-work.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { EInvoiceService } from '../src/billing/e-invoice.service.js';
import { splitVat } from '../src/billing/e-invoice.js';
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
  /** Phần 7: tạo hoá đơn trong transaction cộng tiền; runner giả chỉ đếm `kick`. */
  let eInvoices: EInvoiceService;
  const kick = jest.fn();
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
    eInvoices = new EInvoiceService(db, { createInvoice: jest.fn(), adjustInvoice: jest.fn() }, {
      register: jest.fn(),
      kick,
    } as unknown as BackgroundWorkRunner);
    service = new TopUpService(
      db,
      ledger,
      loyalty,
      new VnpayAdapter(VNPAY),
      undefined,
      undefined,
      eInvoices,
    );
    unconfigured = new TopUpService(
      db,
      ledger,
      loyalty,
      new VnpayAdapter({ ...VNPAY, configured: false, tmnCode: '', hashSecret: '' }),
    );
  });
  beforeEach(() => {
    kick.mockClear();
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
    it('TC-F06-01 TC-F06-02 IPN thành công → credited, số dư + amount, gateway_transaction_no, next_attempt_at NULL, completed_at; lặp → 02; lần trả thứ hai → khoản trễ; khoản thứ ba → 02 + log error', async () => {
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
    it('(bước IPN): pending đã quá expires_at, IPN thành công → credited (#2)', async () => {
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
      '%s: thành công → khoản trễ, giữ trạng thái, không cộng; lặp → 02 (TC-STM4-05 cho failed, TC-STM4-06 cho expired)',
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

    it('IPN thành công sai số tiền trên pending → failed + khoản trễ (số thực trừ), 00, log error payment_not_creditable (Phần 8b, trước đây 04)', async () => {
      const t = await pendingTopUp(200_000);
      const p = ipn(t, { vnp_Amount: String(199_000 * 100) });
      expect(await service.applyPaymentResult(p)).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'failed',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: '199000',
        gateway_transaction_no: null,
        next_attempt_at: null,
      });
      expect(logged(errorSpy, 'payment_not_creditable')).toHaveLength(1);
      expect(logged(warnSpy, 'ipn_amount_mismatch')).toHaveLength(0);
    });

    it('IPN thất bại sai số tiền → 04, không ghi gì, log warn', async () => {
      const t = await pendingTopUp(200_000);
      const before = await snapshot(t);
      expect(
        await service.applyPaymentResult(
          ipn(t, {
            vnp_Amount: String(199_000 * 100),
            vnp_ResponseCode: '24',
            vnp_TransactionStatus: '02',
          }),
        ),
      ).toEqual({ RspCode: '04', Message: 'invalid amount' });
      expect(await snapshot(t)).toEqual(before);
      expect(logged(warnSpy, 'ipn_amount_mismatch')).toHaveLength(1);
    });

    it('IPN thành công mà vnp_Amount không chia hết cho 100 → 99, không ghi gì, log error ipn_malformed', async () => {
      const t = await pendingTopUp(200_000);
      const before = await snapshot(t);
      expect(
        (await service.applyPaymentResult(ipn(t, { vnp_Amount: String(200_000 * 100 + 50) })))
          .RspCode,
      ).toBe('99');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_malformed')).toHaveLength(1);
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
  describe('Phần 8b: đã trả nhưng không cộng được (STM-4 #8) và mục 3.4', () => {
    const closeAccount = (driverId: number) =>
      q("UPDATE credit_accounts SET status='closed', closed_at=now() WHERE driver_id=$1", [
        driverId,
      ]);
    const lateOf = (id: number) =>
      one(
        `SELECT status, late_gateway_ref, late_amount_vnd, next_attempt_at, completed_at IS NOT NULL AS completed
         FROM top_ups WHERE id=$1`,
        [id],
      );

    it('tài khoản closed + IPN thành công → failed + khoản trễ (= amount_paid_vnd), số dư / sổ cái / điểm không đổi, 00; gửi lại → 02, khoản trễ giữ nguyên', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      await closeAccount(d);
      const points = await one('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [
        d,
      ]);
      const p = ipn(t);
      expect(await service.applyPaymentResult(p)).toEqual({
        RspCode: '00',
        Message: 'Confirm Success',
      });
      expect(await lateOf(t.topUpId)).toEqual({
        status: 'failed',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: String(t.amountPaidVnd),
        next_attempt_at: null,
        completed: true,
      });
      expect(await balance(d)).toBe(0);
      expect(await creditRows(t.topUpId)).toBe(0);
      expect(await loyaltyRows(t.topUpId)).toEqual([]);
      expect(
        await one('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [d]),
      ).toEqual(points);
      expect(logged(errorSpy, 'payment_not_creditable')).toEqual([
        {
          event: 'payment_not_creditable',
          top_up_id: t.topUpId,
          gateway_reference: t.ref,
          reason: 'account_closed',
          vnp_TransactionNo: p['vnp_TransactionNo'],
          amount_paid_vnd: t.amountPaidVnd,
          late_amount_vnd: t.amountPaidVnd,
          source: 'ipn',
        },
      ]);
      expect(logged(logSpy, 'ipn_applied')).toEqual([
        {
          event: 'ipn_applied',
          top_up_id: t.topUpId,
          gateway_reference: t.ref,
          outcome: 'not_creditable',
          vnp_TransactionNo: p['vnp_TransactionNo'],
          reason: 'account_closed',
          amount_paid_vnd: t.amountPaidVnd,
          late_amount_vnd: t.amountPaidVnd,
        },
      ]);

      const before = await snapshot(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      // already_applied không log ipn_applied.
      expect(logged(logSpy, 'ipn_applied')).toHaveLength(1);
    });

    it('sai số tiền + IPN thành công → failed, late_amount_vnd = vnp_Amount / 100; gửi lại → 02; IPN thành công thứ hai (txn khác) → 02 conflicting_result, không đổi gì', async () => {
      const t = await pendingTopUp(200_000);
      const p = ipn(t, { vnp_Amount: String(250_000 * 100) });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await lateOf(t.topUpId)).toMatchObject({
        status: 'failed',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: '250000',
      });
      expect(logged(errorSpy, 'payment_not_creditable')).toEqual([
        expect.objectContaining({ reason: 'amount_mismatch', late_amount_vnd: 250_000 }),
      ]);
      const before = await snapshot(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toHaveLength(1);
    });

    it('sai số tiền và tài khoản đóng cùng lúc → lý do amount_mismatch', async () => {
      const t = await pendingTopUp(200_000);
      await closeAccount(t.driverId);
      expect(
        (await service.applyPaymentResult(ipn(t, { vnp_Amount: String(1_000 * 100) }))).RspCode,
      ).toBe('00');
      expect(logged(errorSpy, 'payment_not_creditable')).toEqual([
        expect.objectContaining({ reason: 'amount_mismatch', late_amount_vnd: 1_000 }),
      ]);
    });

    it.each(['expired', 'failed'] as const)(
      '3.4: %s + IPN thành công sai số tiền → khoản trễ với số thực trừ, giữ trạng thái, 00',
      async (status) => {
        const t = await pendingTopUp(120_000);
        await setStatus(t.topUpId, status);
        const p = ipn(t, { vnp_Amount: String(90_000 * 100) });
        expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
        expect(await lateOf(t.topUpId)).toMatchObject({
          status,
          late_gateway_ref: p['vnp_TransactionNo'],
          late_amount_vnd: '90000',
        });
        expect(logged(logSpy, 'ipn_applied')).toEqual([
          expect.objectContaining({ outcome: 'late_payment', late_amount_vnd: 90_000 }),
        ]);
      },
    );

    it('3.4: credited + IPN thành công txn khác, sai số tiền → khoản trễ (lần trả thứ hai) với số thực trừ', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const p = ipn(t, { vnp_Amount: String(70_000 * 100) });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(await lateOf(t.topUpId)).toMatchObject({
        status: 'credited',
        late_gateway_ref: p['vnp_TransactionNo'],
        late_amount_vnd: '70000',
      });
      expect(await balance(t.driverId)).toBe(100_000);
    });

    it('3.4: credited, cùng vnp_TransactionNo đã cộng nhưng khác số tiền → 02, không ghi gì, log error ipn_conflicting_result kèm hai số tiền', async () => {
      const t = await pendingTopUp(100_000);
      const first = ipn(t);
      expect((await service.applyPaymentResult(first)).RspCode).toBe('00');
      const before = await snapshot(t);
      const same = ipn(t, {
        vnp_TransactionNo: first['vnp_TransactionNo'],
        vnp_Amount: String(80_000 * 100),
      });
      expect((await service.applyPaymentResult(same)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toEqual([
        expect.objectContaining({
          top_up_id: t.topUpId,
          vnp_TransactionNo: first['vnp_TransactionNo'],
          gateway_transaction_no: first['vnp_TransactionNo'],
          amount_paid_vnd: 100_000,
          paid_amount_vnd: 80_000,
        }),
      ]);
    });

    it('3.4: đã có khoản trễ, cùng vnp_TransactionNo nhưng khác số tiền → 02, không ghi đè, log error', async () => {
      const t = await pendingTopUp(100_000);
      await setStatus(t.topUpId, 'expired');
      const late = ipn(t);
      expect((await service.applyPaymentResult(late)).RspCode).toBe('00');
      const before = await snapshot(t);
      const other = ipn(t, {
        vnp_TransactionNo: late['vnp_TransactionNo'],
        vnp_Amount: String(60_000 * 100),
      });
      expect((await service.applyPaymentResult(other)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toEqual([
        expect.objectContaining({
          late_gateway_ref: late['vnp_TransactionNo'],
          late_amount_vnd: 100_000,
          paid_amount_vnd: 60_000,
        }),
      ]);
    });

    it('3.4: credited đã có khoản trễ (lần trả thứ hai), cùng vnp_TransactionNo của khoản trễ nhưng khác số tiền → 02, không ghi đè, log error', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const second = ipn(t);
      expect((await service.applyPaymentResult(second)).RspCode).toBe('00');
      const before = await snapshot(t);
      const other = ipn(t, {
        vnp_TransactionNo: second['vnp_TransactionNo'],
        vnp_Amount: String(40_000 * 100),
      });
      expect((await service.applyPaymentResult(other)).RspCode).toBe('02');
      expect(await snapshot(t)).toEqual(before);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toEqual([
        expect.objectContaining({
          status: 'credited',
          late_gateway_ref: second['vnp_TransactionNo'],
          late_amount_vnd: 100_000,
          paid_amount_vnd: 40_000,
        }),
      ]);
    });

    it('3.4: IPN thất bại sai số tiền trên expired → 04, không ghi gì', async () => {
      const t = await pendingTopUp(100_000);
      await setStatus(t.topUpId, 'expired');
      const before = await snapshot(t);
      expect(
        (
          await service.applyPaymentResult(
            ipn(t, {
              vnp_Amount: String(1_000 * 100),
              vnp_ResponseCode: '24',
              vnp_TransactionStatus: '02',
            }),
          )
        ).RspCode,
      ).toBe('04');
      expect(await snapshot(t)).toEqual(before);
    });

    it('log ipn_applied sau commit cho credited / failed / late_payment, đủ trường', async () => {
      const a = await pendingTopUp(100_000);
      const pa = ipn(a);
      await service.applyPaymentResult(pa);
      const b = await pendingTopUp(100_000);
      await service.applyPaymentResult(
        ipn(b, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02' }),
      );
      const late = ipn(a);
      await service.applyPaymentResult(late);
      expect(logged(logSpy, 'ipn_applied')).toEqual([
        {
          event: 'ipn_applied',
          top_up_id: a.topUpId,
          gateway_reference: a.ref,
          outcome: 'credited',
          vnp_TransactionNo: pa['vnp_TransactionNo'],
          amount_paid_vnd: 100_000,
        },
        expect.objectContaining({ top_up_id: b.topUpId, outcome: 'failed' }),
        expect.objectContaining({
          top_up_id: a.topUpId,
          outcome: 'late_payment',
          vnp_TransactionNo: late['vnp_TransactionNo'],
          late_amount_vnd: 100_000,
        }),
      ]);
    });

    it('lỗi làm rollback (lỗi khác ở bước điểm) → không log ipn_applied', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      jest.spyOn(loyalty, 'redeemForTopUp').mockRejectedValueOnce(new Error('boom'));
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('99');
      expect(logged(logSpy, 'ipn_applied')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('trừ điểm khi cộng tiền (D3 ⊕, chốt Ân 13/11)', () => {
    it('TC-F08-02 dùng điểm → dòng redeem đúng, cộng đủ amount_vnd', async () => {
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
  describe('Phần 8b bổ sung: lần trả mâu thuẫn ghi top_up_payment_conflicts (0024)', () => {
    const conflicts = (topUpId: number) =>
      q(
        `SELECT gateway_transaction_no, amount_vnd, source, reason, reviewed_at,
                paid_at = '2026-11-13T03:30:00Z'::timestamptz AS paid_ok
         FROM top_up_payment_conflicts WHERE top_up_id=$1 ORDER BY id`,
        [topUpId],
      );
    const lateCols = (id: number) =>
      one(
        `SELECT status, late_gateway_ref, late_paid_at, late_amount_vnd, exception_kind,
                exception_reviewed_at, updated_at FROM top_ups WHERE id=$1`,
        [id],
      );
    /** Top-up credited đã có khoản trễ (lần trả thứ hai). */
    async function creditedWithLate() {
      const t = await pendingTopUp(100_000);
      const first = ipn(t);
      expect((await service.applyPaymentResult(first)).RspCode).toBe('00');
      const second = ipn(t);
      expect((await service.applyPaymentResult(second)).RspCode).toBe('00');
      return { t, first, second };
    }

    it('hai lần trả mâu thuẫn (hai txn khác nhau sau khi đã có khoản trễ) → 2 dòng extra_payment, late_* không đổi, 02', async () => {
      const { t } = await creditedWithLate();
      const before = await lateCols(t.topUpId);
      const third = ipn(t);
      const fourth = ipn(t, { vnp_Amount: String(30_000 * 100) });
      expect(await service.applyPaymentResult(third)).toEqual({
        RspCode: '02',
        Message: 'Order already confirmed',
      });
      expect((await service.applyPaymentResult(fourth)).RspCode).toBe('02');
      expect(await conflicts(t.topUpId)).toEqual([
        {
          gateway_transaction_no: third['vnp_TransactionNo'],
          amount_vnd: '100000',
          source: 'ipn',
          reason: 'extra_payment',
          reviewed_at: null,
          paid_ok: true,
        },
        {
          gateway_transaction_no: fourth['vnp_TransactionNo'],
          amount_vnd: '30000',
          source: 'ipn',
          reason: 'extra_payment',
          reviewed_at: null,
          paid_ok: true,
        },
      ]);
      expect(await lateCols(t.topUpId)).toEqual(before);
      expect(await balance(t.driverId)).toBe(100_000);
      const errs = logged(errorSpy, 'ipn_conflicting_result');
      expect(errs).toHaveLength(2);
      expect(errs[0]).toMatchObject({ inserted: true, reason: 'extra_payment' });
      expect(typeof errs[0]!['conflict_id']).toBe('number');
    });

    it('gửi lại cùng giao dịch mâu thuẫn → không thêm dòng, 02, log mức log (inserted: false)', async () => {
      const { t } = await creditedWithLate();
      const third = ipn(t);
      expect((await service.applyPaymentResult(third)).RspCode).toBe('02');
      const firstLog = logged(errorSpy, 'ipn_conflicting_result')[0]!;
      expect((await service.applyPaymentResult(third)).RspCode).toBe('02');
      expect((await service.applyPaymentResult(third)).RspCode).toBe('02');
      expect(await conflicts(t.topUpId)).toHaveLength(1);
      expect(logged(errorSpy, 'ipn_conflicting_result')).toHaveLength(1);
      expect(logged(logSpy, 'ipn_conflicting_result')).toEqual([
        expect.objectContaining({
          conflict_id: firstLog['conflict_id'],
          inserted: false,
          existing_amount_vnd: 100_000,
        }),
        expect.objectContaining({ conflict_id: firstLog['conflict_id'], inserted: false }),
      ]);
    });

    it('gửi lại cùng giao dịch mâu thuẫn nhưng khác số tiền → không thêm / không ghi đè dòng, 02, log error kèm hai số tiền', async () => {
      const { t } = await creditedWithLate();
      const third = ipn(t);
      expect((await service.applyPaymentResult(third)).RspCode).toBe('02');
      const other = ipn(t, {
        vnp_TransactionNo: third['vnp_TransactionNo'],
        vnp_Amount: String(55_000 * 100),
      });
      expect((await service.applyPaymentResult(other)).RspCode).toBe('02');
      expect(await conflicts(t.topUpId)).toEqual([
        expect.objectContaining({ amount_vnd: '100000', reason: 'extra_payment' }),
      ]);
      const errs = logged(errorSpy, 'ipn_conflicting_result');
      expect(errs).toHaveLength(2);
      expect(errs[1]).toMatchObject({
        inserted: false,
        existing_amount_vnd: 100_000,
        paid_amount_vnd: 55_000,
      });
    });

    it('cùng txn đã cộng, khác số tiền → 1 dòng amount_differs (số thực trừ), gửi lại không thêm', async () => {
      const t = await pendingTopUp(100_000);
      const first = ipn(t);
      expect((await service.applyPaymentResult(first)).RspCode).toBe('00');
      const same = ipn(t, {
        vnp_TransactionNo: first['vnp_TransactionNo'],
        vnp_Amount: String(80_000 * 100),
      });
      expect((await service.applyPaymentResult(same)).RspCode).toBe('02');
      expect((await service.applyPaymentResult(same)).RspCode).toBe('02');
      expect(await conflicts(t.topUpId)).toEqual([
        expect.objectContaining({
          gateway_transaction_no: first['vnp_TransactionNo'],
          amount_vnd: '80000',
          reason: 'amount_differs',
          source: 'ipn',
        }),
      ]);
      expect(await topUpRow(t.topUpId)).toMatchObject({
        status: 'credited',
        gateway_transaction_no: first['vnp_TransactionNo'],
        late_gateway_ref: null,
      });
    });

    it('credited có exception_kind = loyalty_error dính mâu thuẫn → có dòng, exception_kind / exception_reviewed_at giữ nguyên', async () => {
      const t = await pendingTopUp(100_000);
      const first = ipn(t);
      expect((await service.applyPaymentResult(first)).RspCode).toBe('00');
      await q("UPDATE top_ups SET exception_kind='loyalty_error' WHERE id=$1", [t.topUpId]);
      const before = await lateCols(t.topUpId);
      const same = ipn(t, {
        vnp_TransactionNo: first['vnp_TransactionNo'],
        vnp_Amount: String(1_000 * 100),
      });
      expect((await service.applyPaymentResult(same)).RspCode).toBe('02');
      expect(await conflicts(t.topUpId)).toHaveLength(1);
      expect(await lateCols(t.topUpId)).toEqual(before);
      expect(before).toMatchObject({
        exception_kind: 'loyalty_error',
        exception_reviewed_at: null,
      });
    });

    it('IPN sai chữ ký mang vnp_TransactionNo mới → 97, không ghi dòng', async () => {
      const { t } = await creditedWithLate();
      const forged = sign(ipn(t), 'OTHERSECRETNOTREAL');
      expect((await service.applyPaymentResult(forged)).RspCode).toBe('97');
      expect(await conflicts(t.topUpId)).toEqual([]);
    });

    it('PAYMENT_FAILED trên top-up đã credited → 02, không ghi dòng, vẫn log error', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(
        (
          await service.applyPaymentResult(
            ipn(t, { vnp_ResponseCode: '24', vnp_TransactionStatus: '02' }),
          )
        ).RspCode,
      ).toBe('02');
      expect(await conflicts(t.topUpId)).toEqual([]);
      const errs = logged(errorSpy, 'ipn_conflicting_result');
      expect(errs).toHaveLength(1);
      expect(errs[0]).not.toHaveProperty('conflict_id');
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

    it('TC-F06-02 cộng đúng một lần: một 00, một 02', async () => {
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

    it('hai IPN mâu thuẫn cùng giao dịch tới đồng thời → đúng 1 dòng top_up_payment_conflicts, cả hai 02', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00'); // khoản trễ
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
      expect(codes).toEqual(['02', '02']);
      expect(
        await one('SELECT count(*)::int AS n FROM top_up_payment_conflicts WHERE top_up_id=$1', [
          t.topUpId,
        ]),
      ).toEqual({ n: 1 });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('Phần 7: hoá đơn tạo trong cùng transaction cộng tiền (SD-2b, D5)', () => {
    const invoices = (topUpId: number) =>
      q(
        `SELECT status::text, amount_vnd, vat_rate, vat_amount_vnd, attempt_count, invoice_no,
                next_attempt_at <= now() AS due
         FROM e_invoices WHERE top_up_id=$1`,
        [topUpId],
      );
    const issueKicks = () => kick.mock.calls.filter((c) => c[0] === 'e-invoice-issue').length;

    it('IPN credited → đúng một dòng requested: amount_vnd = amount_paid_vnd, vat_rate 8, VAT tách đúng, đến hạn ngay; kick sau commit; gửi lại (02) → vẫn một dòng', async () => {
      const t = await pendingTopUp(200_000);
      const p = ipn(t);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect(splitVat(200_000, 8)).toBe(14_815);
      expect(await invoices(t.topUpId)).toEqual([
        {
          status: 'requested',
          amount_vnd: '200000',
          vat_rate: 8,
          vat_amount_vnd: '14815',
          attempt_count: 0,
          invoice_no: null,
          due: true,
        },
      ]);
      expect(issueKicks()).toBe(1);
      expect((await service.applyPaymentResult(p)).RspCode).toBe('02');
      expect(await invoices(t.topUpId)).toHaveLength(1);
      expect(issueKicks()).toBe(1);
    });

    it('có dùng điểm → amount_vnd là số thực thu (phần giảm bằng điểm không lên hoá đơn)', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      expect(t.amountPaidVnd).toBe(94_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(await invoices(t.topUpId)).toEqual([
        expect.objectContaining({ amount_vnd: '94000', vat_rate: 8, vat_amount_vnd: '6963' }),
      ]);
    });

    it('sổ điểm hỏng (loyalty_error) → vẫn credited, vẫn có hoá đơn', async () => {
      const d = await newDriver();
      await earn(d, 1000, '6 months');
      const t = await pendingTopUp(100_000, 600, d);
      await q(
        'UPDATE loyalty_accounts SET points_balance = points_balance + 7 WHERE driver_id=$1',
        [d],
      );
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['exception_kind']).toBe('loyalty_error');
      expect(await invoices(t.topUpId)).toEqual([
        expect.objectContaining({ status: 'requested', amount_vnd: '94000' }),
      ]);
    });

    it('việc sau commit lỗi (afterPaymentCommitted ném, như sập ngay sau commit) → hoá đơn vẫn có trong DB', async () => {
      const t = await pendingTopUp(100_000);
      jest
        .spyOn(
          service as unknown as { afterPaymentCommitted: () => Promise<void> },
          'afterPaymentCommitted',
        )
        .mockRejectedValueOnce(new Error('after-commit boom'));
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect(await invoices(t.topUpId)).toEqual([
        expect.objectContaining({ status: 'requested', amount_vnd: '100000' }),
      ]);
      expect(logged(errorSpy, 'ipn_after_commit_failed')).toHaveLength(1);
    });

    it('transaction cộng tiền rollback (lỗi giả ngay sau INSERT hoá đơn) → 99, không có hoá đơn, top-up vẫn pending, không cộng', async () => {
      const t = await pendingTopUp(100_000);
      const real = EInvoiceService.prototype.requestForTopUp;
      jest.spyOn(eInvoices, 'requestForTopUp').mockImplementationOnce(async (c, id) => {
        const r = await real.call(eInvoices, c, id);
        expect(r.created).toBe(true);
        throw new Error('boom after invoice insert');
      });
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('99');
      expect(await invoices(t.topUpId)).toEqual([]);
      expect((await topUpRow(t.topUpId))['status']).toBe('pending');
      expect(await creditRows(t.topUpId)).toBe(0);
      expect(issueKicks()).toBe(0);
    });

    it('IPN thất bại → failed, không hoá đơn', async () => {
      const t = await pendingTopUp();
      const p = ipn(t, {
        vnp_ResponseCode: '24',
        vnp_TransactionStatus: '02',
        vnp_TransactionNo: '0',
      });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['status']).toBe('failed');
      expect(await invoices(t.topUpId)).toEqual([]);
      expect(issueKicks()).toBe(0);
    });

    it('khoản trễ trên expired (late_payment) → không hoá đơn', async () => {
      const t = await pendingTopUp();
      await setStatus(t.topUpId, 'expired');
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['late_gateway_ref']).not.toBeNull();
      expect(await invoices(t.topUpId)).toEqual([]);
      expect(issueKicks()).toBe(0);
    });

    it('khoản trễ trên credited (lần trả thứ hai) → vẫn đúng một hoá đơn của lần cộng', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['late_gateway_ref']).not.toBeNull();
      expect(await invoices(t.topUpId)).toHaveLength(1);
      expect(issueKicks()).toBe(1);
    });

    it('đã trả mà không cộng được (#8, sai số tiền) → failed + khoản trễ, không hoá đơn', async () => {
      const t = await pendingTopUp(100_000);
      const p = ipn(t, { vnp_Amount: String(90_000 * 100) });
      expect((await service.applyPaymentResult(p)).RspCode).toBe('00');
      expect((await topUpRow(t.topUpId))['status']).toBe('failed');
      expect(await invoices(t.topUpId)).toEqual([]);
      expect(issueKicks()).toBe(0);
    });

    it('lần trả mâu thuẫn (conflicting_result) trên expired đã có khoản trễ → không hoá đơn', async () => {
      const t = await pendingTopUp();
      await setStatus(t.topUpId, 'expired');
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('02');
      expect(
        await one('SELECT count(*)::int AS n FROM top_up_payment_conflicts WHERE top_up_id=$1', [
          t.topUpId,
        ]),
      ).toEqual({ n: 1 });
      expect(await invoices(t.topUpId)).toEqual([]);
      expect(issueKicks()).toBe(0);
    });

    it('requestForTopUp gọi lại cho top-up đã có hoá đơn → không thêm dòng, trả dòng cũ', async () => {
      const t = await pendingTopUp(100_000);
      expect((await service.applyPaymentResult(ipn(t))).RspCode).toBe('00');
      const id = Number(
        (await one('SELECT id FROM e_invoices WHERE top_up_id=$1', [t.topUpId]))['id'],
      );
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        expect(await eInvoices.requestForTopUp(c, t.topUpId)).toEqual({ id, created: false });
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(await invoices(t.topUpId)).toHaveLength(1);
    });
  });
});
