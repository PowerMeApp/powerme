/**
 * Test tích hợp hoàn tiền thủ công (D-AC, SRS BR-P51; SD-2e v3.0, STM-10 v2.0, decisions D1) trên
 * Postgres thật: quyết định hoàn (`TopUpService.refund` / `refundLatePayment`) và Admin ghi nhận
 * (`RefundService.confirmDone` / `markFailed` / `redo`). Không gọi VNPay.
 *
 * Vì sao tồn tại: hỏng ở đây là mất tiền thật. Hỏng âm thầm có thể là: một mã hoàn của cổng ghi cho
 * hai refund, ghi nhận hai lần, trừ ví sai số khi top-up có dùng điểm, `late_refunded_at` /
 * `closure_refunded_at` lệch với lúc ghi nhận, deadlock với đường tạo refund.
 * Hoá đơn điều chỉnh khi done: `billing-invoice-adjustment.integration.test.ts`.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import { RefundNoUsed, RefundNotAllowed, RefundNotFound } from '../src/billing/billing-errors.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { InvalidTransition } from '../src/billing/invalid-transition.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import {
  parseFailureReason,
  parseGatewayRefundNo,
  RefundService,
} from '../src/billing/refund.service.js';
import { TopUpService } from '../src/billing/top-up.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
import type { VnpayConfig } from '../src/billing/vnpay.config.js';
import { ConfigModule } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const VNPAY: VnpayConfig = {
  configured: true,
  tmnCode: 'TESTTMN1',
  hashSecret: 'TESTSECRETNOTREAL',
  payUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'http://localhost:3000/billing/vnpay/return',
};
const WORK: BackgroundWorkConfig = {
  enabled: true,
  intervalMs: 30_000,
  batchSize: 20,
  leaseMs: 120_000,
};

describe('parseGatewayRefundNo / parseFailureReason', () => {
  it.each([
    ['15747269', '15747269'],
    ['  RF-2026/11.27_a  ', 'RF-2026/11.27_a'],
    ['x'.repeat(20), 'x'.repeat(20)],
  ])('mã %p hợp lệ → %p', (raw, out) => {
    expect(parseGatewayRefundNo(raw)).toBe(out);
  });

  it.each(['', '   ', 'x'.repeat(21), 'AB 12', 'mã', 'a;b', 12345, null, undefined])(
    'mã %p sai dạng → null',
    (raw) => {
      expect(parseGatewayRefundNo(raw)).toBeNull();
    },
  );

  it('lý do: trim, 1–1000 ký tự', () => {
    expect(parseFailureReason('  Cổng báo thẻ đã đóng  ')).toBe('Cổng báo thẻ đã đóng');
    expect(parseFailureReason('x'.repeat(1000))).toHaveLength(1000);
    expect(parseFailureReason('x'.repeat(1001))).toBeNull();
    expect(parseFailureReason('   ')).toBeNull();
    expect(parseFailureReason(1)).toBeNull();
  });
});

describeDb('billing: hoàn tiền thủ công (SD-2e, STM-10, BR-P51)', () => {
  let db: Db;
  let seq = 0;
  const runner = { register: jest.fn(), kick: jest.fn() } as unknown as BackgroundWorkRunner;
  let vnpay: VnpayAdapter;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  let refunds: RefundService;
  let topUps: TopUpService;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

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
          [`mr-admin-${seq}@t32.test`],
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
          [`mr-${seq}@t32.test`],
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
    const ref = `MRREF${seq}`;
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
            `mr-key-${seq}`,
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
        `MR-CP-${seq}`,
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
      [driver, veh, conn, `MR${seq}`, `k-${seq}`, reservedVnd],
    );
  }

  const refundRow = (id: number) =>
    one(
      `SELECT status::text, kind::text, amount_vnd::int, gateway_refund_no, failure_reason,
              confirmed_via_query, completed_at IS NOT NULL AS completed
       FROM refunds WHERE id=$1`,
      [id],
    );
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
  let codeSeq = 0;
  /** Mã hoàn của cổng chưa dùng. */
  const code = () => `RF${Date.now() % 1_000_000}N${(codeSeq += 1)}`;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    ledger = new CreditLedgerService(db);
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    vnpay = new VnpayAdapter(VNPAY);
    refunds = new RefundService(db);
    topUps = new TopUpService(db, ledger, loyalty, vnpay, runner, WORK, undefined, refunds);
    admin = await newAdmin();
  });
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('confirmDone (STM-10 #2)', () => {
    it('top_up: requested → done, mã + completed_at, log admin_id; thiếu EInvoiceService → log error', async () => {
      const { t, refundId } = await requested();
      const no = code();
      const out = await refunds.confirmDone(refundId, `  ${no} `, admin);
      expect(out).toEqual({
        refundId,
        status: 'done',
        gatewayRefundNo: no,
        completedAt: expect.any(Date),
        alreadyDone: false,
      });
      expect(await refundRow(refundId)).toMatchObject({
        status: 'done',
        gateway_refund_no: no,
        completed: true,
        confirmed_via_query: false,
      });
      expect(logged(logSpy, 'refund_confirmed')).toEqual([
        {
          event: 'refund_confirmed',
          refund_id: refundId,
          top_up_id: t.id,
          kind: 'top_up',
          admin_id: admin,
          gateway_refund_no: no,
        },
      ]);
      expect(logged(errorSpy, 'invoice_adjustment_service_missing')).toHaveLength(1);
    });

    it('late_payment: late_refunded_at = completed_at; không đụng ví / trạng thái top-up', async () => {
      const t = await topUp({ late: 90_000 });
      const { refundId } = await topUps.refundLatePayment(t.id, admin);
      expect(await one('SELECT late_refunded_at FROM top_ups WHERE id=$1', [t.id])).toEqual({
        late_refunded_at: null,
      });
      await refunds.confirmDone(refundId, code(), admin);
      expect(
        await one(
          `SELECT t.late_refunded_at = f.completed_at AS same, t.status::text
           FROM top_ups t JOIN refunds f ON f.top_up_id = t.id WHERE f.id = $1`,
          [refundId],
        ),
      ).toEqual({ same: true, status: 'credited' });
      expect(await balance(t.account)).toBe(100_000);
      // late_payment không có hoá đơn gốc: không đòi EInvoiceService.
      expect(logged(errorSpy, 'invoice_adjustment_service_missing')).toHaveLength(0);
    });

    it('cùng mã gọi lại → kết quả cũ (alreadyDone), không ghi thêm, log refund_confirm_repeated', async () => {
      const { refundId } = await requested();
      const no = code();
      const first = await refunds.confirmDone(refundId, no, admin);
      const before = await one('SELECT updated_at FROM refunds WHERE id=$1', [refundId]);
      const again = await refunds.confirmDone(refundId, no, admin);
      expect(again).toEqual({ ...first, alreadyDone: true });
      expect(await one('SELECT updated_at FROM refunds WHERE id=$1', [refundId])).toEqual(before);
      expect(logged(logSpy, 'refund_confirmed')).toHaveLength(1);
      expect(logged(logSpy, 'refund_confirm_repeated')).toHaveLength(1);
    });

    it('done bằng mã khác → InvalidTransition, giữ mã cũ', async () => {
      const { refundId } = await requested();
      const no = code();
      await refunds.confirmDone(refundId, no, admin);
      await expect(refunds.confirmDone(refundId, code(), admin)).rejects.toBeInstanceOf(
        InvalidTransition,
      );
      expect(await refundRow(refundId)).toMatchObject({ gateway_refund_no: no });
    });

    it('failed → InvalidTransition (không có failed → done)', async () => {
      const { refundId } = await requested();
      await refunds.markFailed(refundId, 'cổng từ chối', admin);
      await expect(refunds.confirmDone(refundId, code(), admin)).rejects.toMatchObject({
        machine: 'STM-10',
        from: 'failed',
        event: 'ADMIN_CONFIRMED',
      });
    });

    it('mã đã ghi cho refund khác → RefundNoUsed, refund vẫn requested', async () => {
      const a = await requested();
      const b = await requested();
      const no = code();
      await refunds.confirmDone(a.refundId, no, admin);
      await expect(refunds.confirmDone(b.refundId, no, admin)).rejects.toBeInstanceOf(RefundNoUsed);
      expect(await refundRow(b.refundId)).toMatchObject({
        status: 'requested',
        gateway_refund_no: null,
        completed: false,
      });
    });

    it('hai refund cùng mã ghi đồng thời → một done, một RefundNoUsed', async () => {
      const a = await requested();
      const b = await requested();
      const no = code();
      const results = await Promise.allSettled([
        refunds.confirmDone(a.refundId, no, admin),
        refunds.confirmDone(b.refundId, no, admin),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(RefundNoUsed);
      expect(
        await one('SELECT count(*)::int AS n FROM refunds WHERE gateway_refund_no=$1', [no]),
      ).toEqual({ n: 1 });
    });

    it('hai connection ghi nhận cùng refund, cùng mã → ghi một lần, lần sau alreadyDone', async () => {
      const { refundId } = await requested();
      const no = code();
      const out = await Promise.all([
        refunds.confirmDone(refundId, no, admin),
        refunds.confirmDone(refundId, no, admin),
      ]);
      expect(out.map((o) => o.alreadyDone).sort()).toEqual([false, true]);
      expect(logged(logSpy, 'refund_confirmed')).toHaveLength(1);
    });

    it('không có refund → RefundNotFound; mã sai dạng → ném trước khi mở transaction', async () => {
      await expect(refunds.confirmDone(999_999_999, code(), admin)).rejects.toBeInstanceOf(
        RefundNotFound,
      );
      const connect = jest.spyOn(db.$client, 'connect');
      await expect(refunds.confirmDone(1, 'AB 12', admin)).rejects.toThrow(
        'refund_invalid_gateway_refund_no',
      );
      expect(connect).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('account_closure (seed, Phần 11 chưa có)', () => {
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
      return { owner, ra: await mk(a.id), rb: await mk(b.id) };
    }
    const closure = async (account: number) =>
      (await one('SELECT closure_refunded_at FROM credit_accounts WHERE id=$1', [account]))[
        'closure_refunded_at'
      ];

    it('còn refund chưa done → NULL; refund cuối done → closure_refunded_at', async () => {
      const { owner, ra, rb } = await closedWithTwo();
      await refunds.confirmDone(ra, code(), admin);
      expect(await closure(owner.account)).toBeNull();
      await refunds.markFailed(rb, 'tài khoản ngân hàng đã đóng', admin);
      expect(await closure(owner.account)).toBeNull();
      await refunds.redo(rb, admin);
      await refunds.confirmDone(rb, code(), admin);
      expect(await closure(owner.account)).not.toBeNull();
    });

    it('hai refund cuối ghi nhận song song → closure_refunded_at vẫn được ghi', async () => {
      const { owner, ra, rb } = await closedWithTwo();
      await Promise.all([
        refunds.confirmDone(ra, code(), admin),
        refunds.confirmDone(rb, code(), admin),
      ]);
      expect(await closure(owner.account)).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('markFailed (STM-10 #3) và redo (STM-10 #4)', () => {
    it('requested → failed kèm lý do (trim), log admin_id; ví không được trả lại', async () => {
      const { t, refundId } = await requested();
      const out = await refunds.markFailed(refundId, '  Cổng từ chối: quá hạn hoàn  ', admin);
      expect(out).toEqual({
        refundId,
        status: 'failed',
        failureReason: 'Cổng từ chối: quá hạn hoàn',
      });
      expect(await refundRow(refundId)).toMatchObject({
        status: 'failed',
        failure_reason: 'Cổng từ chối: quá hạn hoàn',
        completed: false,
      });
      expect(await balance(t.account)).toBe(0);
      expect(logged(logSpy, 'refund_marked_failed')).toEqual([
        {
          event: 'refund_marked_failed',
          refund_id: refundId,
          top_up_id: t.id,
          kind: 'top_up',
          admin_id: admin,
          reason: 'Cổng từ chối: quá hạn hoàn',
        },
      ]);
    });

    it('redo: failed → requested, giữ lý do cũ; fail lần sau ghi đè; rồi confirm được', async () => {
      const { refundId } = await requested();
      await refunds.markFailed(refundId, 'lần 1', admin);
      expect(await refunds.redo(refundId, admin)).toEqual({ refundId, status: 'requested' });
      expect(await refundRow(refundId)).toMatchObject({
        status: 'requested',
        failure_reason: 'lần 1',
      });
      expect(logged(logSpy, 'refund_redo')).toHaveLength(1);
      await refunds.markFailed(refundId, 'lần 2', admin);
      expect(await refundRow(refundId)).toMatchObject({ failure_reason: 'lần 2' });
      await refunds.redo(refundId, admin);
      await refunds.confirmDone(refundId, code(), admin);
      expect(await refundRow(refundId)).toMatchObject({ status: 'done', failure_reason: 'lần 2' });
    });

    it.each([
      ['markFailed trên failed', 'failed', 'fail'],
      ['markFailed trên done', 'done', 'fail'],
      ['redo trên requested', 'requested', 'redo'],
      ['redo trên done', 'done', 'redo'],
    ] as const)('%s → InvalidTransition', async (_name, state, action) => {
      const { refundId } = await requested();
      if (state === 'failed') await refunds.markFailed(refundId, 'x', admin);
      if (state === 'done') await refunds.confirmDone(refundId, code(), admin);
      const call =
        action === 'fail'
          ? refunds.markFailed(refundId, 'y', admin)
          : refunds.redo(refundId, admin);
      await expect(call).rejects.toBeInstanceOf(InvalidTransition);
      expect(await refundRow(refundId)).toMatchObject({ status: state });
    });

    it('không có refund → RefundNotFound; lý do sai dạng → ném', async () => {
      await expect(refunds.markFailed(999_999_999, 'x', admin)).rejects.toBeInstanceOf(
        RefundNotFound,
      );
      await expect(refunds.redo(999_999_999, admin)).rejects.toBeInstanceOf(RefundNotFound);
      await expect(refunds.markFailed(1, '   ', admin)).rejects.toThrow(
        'refund_invalid_failure_reason',
      );
    });
  });

  // ---------------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------------------
  describe('TopUpService.refund (TC-STM4-12/13/14)', () => {
    it('hợp lệ: sổ cái −số tiền, refunded, refund requested, log admin_id', async () => {
      const t = await topUp();
      const out = await topUps.refund(t.id, admin);
      expect(out).toEqual({
        refundId: expect.any(Number),
        status: 'requested',
        amountVnd: 100_000,
      });
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
        gateway_refund_no: null,
        failure_reason: null,
      });
      expect(logged(logSpy, 'refund_requested')).toEqual([
        {
          event: 'refund_requested',
          refund_id: out.refundId,
          top_up_id: t.id,
          admin_id: admin,
          kind: 'top_up',
        },
      ]);
    });

    it('có điểm (nạp 100.000, điểm 20.000, trả 80.000): ví −100.000, một dòng −100.000, CSKH hoàn 80.000, điểm trả lại', async () => {
      const t = await topUpWithPoints();
      expect(await points(t.driver)).toBe(1000);
      const { refundId, amountVnd } = await topUps.refund(t.id, admin);
      expect(amountVnd).toBe(80_000);
      expect(await balance(t.account)).toBe(0);
      expect(await ledgerRows(t.id)).toEqual([
        { transaction_type: 'refund', amount_vnd: -100_000 },
      ]);
      expect(await points(t.driver)).toBe(3000);
      expect(await refundRow(refundId)).toMatchObject({ status: 'requested', amount_vnd: 80_000 });
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

    it('VNPay chưa cấu hình vẫn hoàn được (hoàn thủ công không gọi VNPay)', async () => {
      const t = await topUp({ late: 50_000 });
      const off = new TopUpService(
        db,
        ledger,
        loyalty,
        new VnpayAdapter({ ...VNPAY, configured: false }),
        runner,
        WORK,
        undefined,
        refunds,
      );
      await expect(off.refund(t.id, admin)).resolves.toMatchObject({ status: 'requested' });
      await expect(off.refundLatePayment(t.id, admin)).resolves.toMatchObject({
        status: 'requested',
        amountVnd: 50_000,
      });
      expect(await refundCount(t.id)).toBe(2);
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
      expect(out).toEqual({ refundId: expect.any(Number), status: 'requested', amountVnd: 90_000 });
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
    it('khởi động được, KHÔNG còn việc nền refund-send, TopUpService được tiêm RefundService', async () => {
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
          // `kick` một tên chưa đăng ký thì ném (billing/CLAUDE.md).
          expect(() => app.get(BackgroundWorkRunner).kick('refund-send')).toThrow();
          expect(() => app.get(BackgroundWorkRunner).kick('e-invoice-issue')).not.toThrow();
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
