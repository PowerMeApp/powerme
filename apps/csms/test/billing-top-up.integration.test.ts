/**
 * Test tích hợp TopUpService (T32 Phần 5, SD-2a, decisions D2): quote, create, get trên Postgres
 * thật.
 *
 * Vì sao tồn tại: tạo top-up là cửa vào của tiền thật. Hỏng âm thầm có thể là: top-up thứ hai khi
 * còn pending (tài xế trả hai lần), gửi lại cùng key tạo dòng mới, cùng key khác body lọt qua, hạn
 * mức BR-P22 sai biên, điểm bị trừ sớm hoặc bị hạ âm thầm, pending quá hạn bị tự chuyển expired
 * (IPN chậm thành khoản trễ), hoặc hai request song song đi qua cùng lúc.
 *
 * Mã TC chỉ gắn khi có trong bộ Report 5 (TC-STM4-01…08); các test còn lại đặt tên theo nội dung
 * (TC-STM4-11/16/18 thuộc bộ WP5 v0.4, xem ghi chú 12/11 của WF-02_plan).
 *
 * Ca song song dùng hai connection thật: connection thứ ba giữ `credit_accounts FOR UPDATE`, hai
 * `create` phải đứng chờ khoá rồi mới được thả (cùng cách `billing-ledger.integration.test.ts`).
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { createHmac } from 'node:crypto';
import { TopUpRejected } from '../src/billing/billing-errors.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import {
  GATEWAY_REFERENCE_ATTEMPTS,
  PENDING_TIMEOUT_MS,
  topUpRequestHash,
  TopUpService,
} from '../src/billing/top-up.service.js';
import { VnpayAdapter } from '../src/billing/vnpay.adapter.js';
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

/** TopUpService với `gateway_reference` điều khiển được (ca va chạm UNIQUE). */
class ScriptedRefs extends TopUpService {
  refs: string[] = [];
  protected override nextGatewayReference(): string {
    return this.refs.shift() ?? super.nextGatewayReference();
  }
}

describeDb('billing: tạo top-up VNPay — TopUpService (T32 Phần 5, SD-2a)', () => {
  let db: Db;
  let service: ScriptedRefs;
  let unconfigured: TopUpService;
  let seq = 0;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const key = () => `key-${++seq}-${Date.now()}`;

  async function rejection(p: Promise<unknown>): Promise<TopUpRejected> {
    try {
      await p;
    } catch (err) {
      if (err instanceof TopUpRejected) return err;
      throw err;
    }
    throw new Error('kỳ vọng bị từ chối nhưng đã chạy được');
  }

  /** Tài xế mới (chưa có tài khoản credit — create tự tạo, D9). */
  async function newDriver(): Promise<number> {
    seq += 1;
    const u = Number(
      (
        await one("INSERT INTO users(email,full_name,role) VALUES($1,'X','driver') RETURNING id", [
          `d${seq}@t32p5.test`,
        ])
      )['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    return u;
  }

  /** Tài xế có tài khoản với số dư / trạng thái cho trước (fixture, không qua sổ cái). */
  async function driverWith(balance: number, status = 'active'): Promise<number> {
    const d = await newDriver();
    await new CreditLedgerService(db).ensureAccounts(d);
    await q(
      `UPDATE credit_accounts SET balance_vnd=$2, status=$3::credit_account_status,
         closed_at = CASE WHEN $3 = 'closed' THEN now() END
       WHERE driver_id=$1`,
      [d, balance, status],
    );
    return d;
  }

  async function creditAccount(driverId: number): Promise<number> {
    return Number(
      (await one('SELECT id FROM credit_accounts WHERE driver_id=$1', [driverId]))['id'],
    );
  }

  /** Lô earn có hạn tương đối với đồng hồ DB (service dùng now() của DB). */
  async function earn(driverId: number, points: number, expiresIn: string) {
    await new CreditLedgerService(db).ensureAccounts(driverId);
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

  /** Top-up có sẵn (như dòng cũ / trạng thái sau Phần 6–8), ghi thẳng bằng SQL. */
  async function existingTopUp(
    driverId: number,
    status: string,
    opts: { key?: string; expiresIn?: string; hash?: string | null } = {},
  ): Promise<number> {
    seq += 1;
    const acc = await creditAccount(driverId);
    return Number(
      (
        await one(
          `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,status,
             idempotency_key,request_hash,created_at,expires_at,refunded_at)
           VALUES($1,$2,100000,100000,$3::top_up_status,$4,$5,
             now() + $6::interval - interval '15 minutes', now() + $6::interval,
             CASE WHEN $3 = 'refunded' THEN now() END)
           RETURNING id`,
          [
            `OLDREF${seq}`,
            acc,
            status,
            opts.key ?? `old-key-${seq}`,
            opts.hash ?? null,
            opts.expiresIn ?? '10 minutes',
          ],
        )
      )['id'],
    );
  }

  const counts = async () =>
    one(`SELECT (SELECT count(*) FROM top_ups)::int AS top_ups,
                (SELECT count(*) FROM credit_transactions)::int AS credit,
                (SELECT count(*) FROM loyalty_transactions)::int AS loyalty`);

  async function waitForLockWaiters(n: number): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    for (;;) {
      const row = await one(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM credit_accounts%FOR UPDATE%'`,
      );
      if (Number(row['n']) >= n) return;
      if (Date.now() > deadline)
        throw new Error(`không thấy ${n} backend chờ khoá credit_accounts`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Giữ khoá tài khoản của tài xế, chạy `work` (các request phải chờ), rồi thả. */
  async function withAccountLocked<T>(
    driverId: number,
    waiters: number,
    work: () => Promise<T>[],
  ): Promise<PromiseSettledResult<T>[]> {
    const holder = await db.$client.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM credit_accounts WHERE driver_id=$1 FOR UPDATE', [driverId]);
      const pending = Promise.allSettled(work());
      try {
        await waitForLockWaiters(waiters);
      } finally {
        await holder.query('COMMIT');
      }
      return await pending;
    } finally {
      holder.release();
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const ledger = new CreditLedgerService(db);
    const loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
    service = new ScriptedRefs(db, ledger, loyalty, new VnpayAdapter(VNPAY));
    unconfigured = new TopUpService(
      db,
      ledger,
      loyalty,
      new VnpayAdapter({ ...VNPAY, configured: false, tmnCode: '', hashSecret: '' }),
    );
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  describe('tạo mới', () => {
    it('TC-STM4-01: tạo 200.000 → pending, expires_at = tạo + 15 phút, số dư không đổi, không có dòng sổ cái / điểm; payment_url ký đúng', async () => {
      const d = await driverWith(30_000);
      const before = await counts();
      const k = key();
      const { created, topUp } = await service.create(d, k, { amountVnd: 200_000 }, IP);

      expect(created).toBe(true);
      expect(topUp).toMatchObject({
        status: 'pending',
        amountVnd: 200_000,
        pointsRedeemed: 0,
        pointsDiscountVnd: 0,
        amountPaidVnd: 200_000,
      });
      expect(topUp.expiresAt.getTime() - topUp.createdAt.getTime()).toBe(PENDING_TIMEOUT_MS);
      expect(PENDING_TIMEOUT_MS).toBe(15 * 60 * 1000);

      const row = await one(
        `SELECT t.*, (t.expires_at - t.created_at) = interval '15 minutes' AS exact
         FROM top_ups t WHERE id=$1`,
        [topUp.topUpId],
      );
      expect(row['exact']).toBe(true);
      expect(row['idempotency_key']).toBe(k);
      expect(row['request_hash']).toBe(topUpRequestHash(200_000, 0));
      expect(row['gateway_reference']).toMatch(/^PM[0-9A-Z]{14}$/);
      expect(Number(row['credit_account_id'])).toBe(await creditAccount(d));

      expect(
        Number(
          (await one('SELECT balance_vnd FROM credit_accounts WHERE driver_id=$1', [d]))[
            'balance_vnd'
          ],
        ),
      ).toBe(30_000);
      const after = await counts();
      expect(after).toEqual({ ...before, top_ups: Number(before['top_ups']) + 1 });

      const url = new URL(topUp.paymentUrl!);
      expect(url.origin + url.pathname).toBe(VNPAY.payUrl);
      expect(url.searchParams.get('vnp_Amount')).toBe('20000000');
      expect(url.searchParams.get('vnp_TxnRef')).toBe(row['gateway_reference']);
      expect(url.searchParams.get('vnp_IpAddr')).toBe(IP);
      const hash = url.searchParams.get('vnp_SecureHash')!;
      const signData = url.search.slice(1).replace(/&vnp_SecureHash=.*$/, '');
      expect(hash).toBe(createHmac('sha512', VNPAY.hashSecret).update(signData).digest('hex'));
    });

    it('tài xế chưa có tài khoản credit / loyalty → create tự tạo (ensureAccounts, D9)', async () => {
      const d = await newDriver();
      await service.create(d, key(), { amountVnd: 50_000 }, IP);
      expect(await q('SELECT 1 FROM credit_accounts WHERE driver_id=$1', [d])).toHaveLength(1);
      expect(await q('SELECT 1 FROM loyalty_accounts WHERE driver_id=$1', [d])).toHaveLength(1);
    });

    it('chưa cấu hình VNPay → payment_unconfigured, không ghi dòng nào (kể cả tài khoản)', async () => {
      const d = await newDriver();
      const before = await counts();
      expect(
        (await rejection(unconfigured.create(d, key(), { amountVnd: 100_000 }, IP))).code,
      ).toBe('payment_unconfigured');
      expect(await counts()).toEqual(before);
      expect(await q('SELECT 1 FROM credit_accounts WHERE driver_id=$1', [d])).toEqual([]);
    });

    it('gateway_reference trùng UNIQUE → sinh lại (SAVEPOINT), quá số lần thì ném', async () => {
      const a = await driverWith(0);
      const first = await service.create(a, key(), { amountVnd: 50_000 }, IP);
      const taken = String(
        (await one('SELECT gateway_reference FROM top_ups WHERE id=$1', [first.topUp.topUpId]))[
          'gateway_reference'
        ],
      );
      const b = await driverWith(0);
      service.refs = [taken, taken, 'PMRETRYOK0000001'];
      const second = await service.create(b, key(), { amountVnd: 50_000 }, IP);
      expect(
        (await one('SELECT gateway_reference FROM top_ups WHERE id=$1', [second.topUp.topUpId]))[
          'gateway_reference'
        ],
      ).toBe('PMRETRYOK0000001');

      const c = await driverWith(0);
      service.refs = Array.from({ length: GATEWAY_REFERENCE_ATTEMPTS }, () => taken);
      await expect(service.create(c, key(), { amountVnd: 50_000 }, IP)).rejects.toMatchObject({
        code: '23505',
        constraint: 'top_ups_gateway_reference_key',
      });
      expect(
        await q('SELECT 1 FROM top_ups WHERE credit_account_id=$1', [await creditAccount(c)]),
      ).toEqual([]);
      service.refs = [];
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('BR-P22 theo ADR-0013 và trạng thái tài khoản', () => {
    it('49.999 và 2.000.001 → amount_out_of_range; 50.000 và 2.000.000 → được', async () => {
      for (const amount of [49_999, 2_000_001, 0, -50_000]) {
        const d = await driverWith(0);
        const before = await counts();
        expect((await rejection(service.create(d, key(), { amountVnd: amount }, IP))).code).toBe(
          'amount_out_of_range',
        );
        expect(await counts()).toEqual(before);
      }
      for (const amount of [50_000, 2_000_000]) {
        const d = await driverWith(0);
        expect((await service.create(d, key(), { amountVnd: amount }, IP)).created).toBe(true);
      }
    });

    it('số dư 4.900.000 + 200.000 → balance_limit_exceeded; + 100.000 (= 5.000.000) → được', async () => {
      const d = await driverWith(4_900_000);
      const before = await counts();
      expect((await rejection(service.create(d, key(), { amountVnd: 200_000 }, IP))).code).toBe(
        'balance_limit_exceeded',
      );
      expect(await counts()).toEqual(before);
      expect((await service.create(d, key(), { amountVnd: 100_000 }, IP)).created).toBe(true);
    });

    it('hạn mức cộng toàn bộ amount_vnd, kể cả phần trả bằng điểm', async () => {
      const d = await driverWith(4_850_000);
      await earn(d, 5_000, '30 days');
      // trả 194.000 sau giảm nhưng ví được cộng 200.000 → 5.050.000 > 5.000.000
      expect(
        (await rejection(service.create(d, key(), { amountVnd: 200_000, pointsToRedeem: 600 }, IP)))
          .code,
      ).toBe('balance_limit_exceeded');
    });

    it('số dư âm (in_shortfall) vẫn tạo được', async () => {
      const d = await driverWith(-20_000, 'in_shortfall');
      expect((await service.create(d, key(), { amountVnd: 100_000 }, IP)).topUp.status).toBe(
        'pending',
      );
    });

    it('tài khoản closed → account_closed, không ghi dòng nào', async () => {
      const d = await driverWith(0, 'closed');
      const before = await counts();
      expect((await rejection(service.create(d, key(), { amountVnd: 100_000 }, IP))).code).toBe(
        'account_closed',
      );
      expect(await counts()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('dùng điểm (BR-P35)', () => {
    it('dùng 600 điểm → giảm 6.000, trả 194.000; điểm CHƯA bị trừ (chỉ trừ lúc cộng tiền, SD-2b)', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      const before = await counts();
      const { topUp } = await service.create(
        d,
        key(),
        { amountVnd: 200_000, pointsToRedeem: 600 },
        IP,
      );
      expect(topUp).toMatchObject({
        pointsRedeemed: 600,
        pointsDiscountVnd: 6_000,
        amountPaidVnd: 194_000,
      });
      expect(new URL(topUp.paymentUrl!).searchParams.get('vnp_Amount')).toBe('19400000');
      expect((await counts())['loyalty']).toBe(before['loyalty']);
      expect(
        Number(
          (await one('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [d]))[
            'points_balance'
          ],
        ),
      ).toBe(1_000);
    });

    it('điểm < 500 → points_below_minimum (cả khi xin < 500 lẫn khi chỉ còn < 500 điểm)', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      expect(
        (await rejection(service.create(d, key(), { amountVnd: 200_000, pointsToRedeem: 300 }, IP)))
          .code,
      ).toBe('points_below_minimum');
      const poor = await driverWith(0);
      await earn(poor, 400, '30 days');
      expect(
        (
          await rejection(
            service.create(poor, key(), { amountVnd: 200_000, pointsToRedeem: 500 }, IP),
          )
        ).code,
      ).toBe('points_below_minimum');
    });

    it('vượt điểm còn sống → points_unavailable (không tự hạ số điểm)', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      const before = await counts();
      expect(
        (
          await rejection(
            service.create(d, key(), { amountVnd: 200_000, pointsToRedeem: 1_200 }, IP),
          )
        ).code,
      ).toBe('points_unavailable');
      expect(await counts()).toEqual(before);
    });

    it('vượt trần 50 % → points_exceed_cap (50.000 ₫ → tối đa 2.500 điểm)', async () => {
      const d = await driverWith(0);
      await earn(d, 3_000, '30 days');
      expect(
        (
          await rejection(
            service.create(d, key(), { amountVnd: 50_000, pointsToRedeem: 2_600 }, IP),
          )
        ).code,
      ).toBe('points_exceed_cap');
      expect(
        (await service.create(d, key(), { amountVnd: 50_000, pointsToRedeem: 2_500 }, IP)).topUp
          .amountPaidVnd,
      ).toBe(25_000);
    });

    it('điểm đã hết hạn không được tính', async () => {
      const d = await driverWith(0);
      await earn(d, 700, '30 days');
      await earn(d, 5_000, '-1 day');
      expect(
        (
          await rejection(
            service.create(d, key(), { amountVnd: 200_000, pointsToRedeem: 1_000 }, IP),
          )
        ).code,
      ).toBe('points_unavailable');
      expect(
        (await service.create(d, key(), { amountVnd: 200_000, pointsToRedeem: 700 }, IP)).topUp
          .pointsRedeemed,
      ).toBe(700);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('đang có top-up pending (D2 ⊕, T117)', () => {
    it('pending chưa quá hạn → 409 top_up_pending kèm top_up_id và payment_url của nó', async () => {
      const d = await driverWith(0);
      const first = await service.create(d, key(), { amountVnd: 100_000 }, IP);
      const err = await rejection(service.create(d, key(), { amountVnd: 300_000 }, IP));
      expect(err.code).toBe('top_up_pending');
      expect(err.extra.topUpId).toBe(first.topUp.topUpId);
      expect(err.extra.paymentUrl).toBe(first.topUp.paymentUrl);
    });

    it('pending đã quá hạn → 409 pending_top_up_confirming, không kèm payment_url; top-up cũ vẫn pending, không có dòng mới', async () => {
      const d = await driverWith(0);
      const old = await existingTopUp(d, 'pending', { expiresIn: '-5 minutes' });
      const before = await counts();
      const err = await rejection(service.create(d, key(), { amountVnd: 100_000 }, IP));
      expect(err.code).toBe('pending_top_up_confirming');
      expect(err.extra).toEqual({ topUpId: old });
      expect((await one('SELECT status FROM top_ups WHERE id=$1', [old]))['status']).toBe(
        'pending',
      );
      expect(await counts()).toEqual(before);
    });

    it('có expired / failed / credited / refunded cũ → vẫn tạo được', async () => {
      const d = await driverWith(0);
      for (const s of ['expired', 'failed', 'credited', 'refunded'])
        await existingTopUp(d, s, { expiresIn: '-1 day' });
      expect((await service.create(d, key(), { amountVnd: 100_000 }, IP)).created).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('request_hash và idempotency', () => {
    it('cùng body → cùng hash; points_to_redeem bỏ trống và 0 → cùng hash', async () => {
      expect(topUpRequestHash(200_000, 600)).toBe(topUpRequestHash(200_000, 600));
      expect(topUpRequestHash(200_000)).toBe(topUpRequestHash(200_000, 0));
      expect(topUpRequestHash(200_000, 0)).not.toBe(topUpRequestHash(200_000, 600));
      expect(topUpRequestHash(200_000)).toMatch(/^[0-9a-f]{64}$/);

      const d = await driverWith(0);
      const k = key();
      const first = await service.create(d, k, { amountVnd: 100_000 }, IP);
      const again = await service.create(d, k, { amountVnd: 100_000, pointsToRedeem: 0 }, IP);
      expect(again).toEqual({ created: false, topUp: first.topUp });
    });

    it('gửi lại cùng key cùng body → 200 cùng top_up_id, không thêm dòng', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      const k = key();
      const first = await service.create(d, k, { amountVnd: 200_000, pointsToRedeem: 600 }, IP);
      const before = await counts();
      const again = await service.create(d, k, { amountVnd: 200_000, pointsToRedeem: 600 }, IP);
      expect(again.created).toBe(false);
      expect(again.topUp.topUpId).toBe(first.topUp.topUpId);
      expect(await counts()).toEqual(before);
    });

    it('gửi lại sau khi điểm đã đổi (một lô hết hạn) → vẫn 200 top-up cũ, không báo giá lại', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      const k = key();
      const first = await service.create(d, k, { amountVnd: 200_000, pointsToRedeem: 600 }, IP);
      await q(
        `UPDATE loyalty_transactions SET expires_at = now() - interval '1 minute'
         WHERE loyalty_account_id = (SELECT id FROM loyalty_accounts WHERE driver_id=$1)`,
        [d],
      );
      const again = await service.create(d, k, { amountVnd: 200_000, pointsToRedeem: 600 }, IP);
      expect(again).toEqual({ created: false, topUp: first.topUp });
    });

    it('cùng key khác amount_vnd hoặc khác points_to_redeem → idempotency_conflict', async () => {
      const d = await driverWith(0);
      await earn(d, 1_000, '30 days');
      const k = key();
      await service.create(d, k, { amountVnd: 200_000 }, IP);
      expect((await rejection(service.create(d, k, { amountVnd: 300_000 }, IP))).code).toBe(
        'idempotency_conflict',
      );
      expect(
        (await rejection(service.create(d, k, { amountVnd: 200_000, pointsToRedeem: 600 }, IP)))
          .code,
      ).toBe('idempotency_conflict');
    });

    it('key của dòng không tạo qua API (request_hash NULL) → idempotency_conflict', async () => {
      const d = await driverWith(0);
      await existingTopUp(d, 'credited', { key: 'seed-like-key-01' });
      expect(
        (await rejection(service.create(d, 'seed-like-key-01', { amountVnd: 100_000 }, IP))).code,
      ).toBe('idempotency_conflict');
    });

    it('hai tài xế dùng cùng key → hai top-up riêng', async () => {
      const a = await driverWith(0);
      const b = await driverWith(0);
      const k = key();
      const ta = await service.create(a, k, { amountVnd: 100_000 }, IP);
      const tb = await service.create(b, k, { amountVnd: 100_000 }, IP);
      expect(ta.created && tb.created).toBe(true);
      expect(ta.topUp.topUpId).not.toBe(tb.topUp.topUpId);
    });

    it('gửi lại key của top-up đã expired → 200, status = expired, payment_url = null', async () => {
      const d = await driverWith(0);
      const k = key();
      const first = await service.create(d, k, { amountVnd: 100_000 }, IP);
      await q(`UPDATE top_ups SET status='expired' WHERE id=$1`, [first.topUp.topUpId]);
      const again = await service.create(d, k, { amountVnd: 100_000 }, IP);
      expect(again.created).toBe(false);
      expect(again.topUp).toMatchObject({
        topUpId: first.topUp.topUpId,
        status: 'expired',
        paymentUrl: null,
      });
    });

    it('key dài 100 ký tự → được', async () => {
      const d = await driverWith(0);
      const k = 'k'.repeat(100);
      expect((await service.create(d, k, { amountVnd: 100_000 }, IP)).created).toBe(true);
      expect((await service.create(d, k, { amountVnd: 100_000 }, IP)).created).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('song song (hai connection thật)', () => {
    it('hai request cùng key → đúng một dòng, cả hai trả cùng top_up_id', async () => {
      const d = await driverWith(0);
      const k = key();
      const [r1, r2] = await withAccountLocked(d, 2, () => [
        service.create(d, k, { amountVnd: 100_000 }, IP),
        service.create(d, k, { amountVnd: 100_000 }, IP),
      ]);
      expect(r1!.status).toBe('fulfilled');
      expect(r2!.status).toBe('fulfilled');
      const v1 = (r1 as PromiseFulfilledResult<{ created: boolean; topUp: { topUpId: number } }>)
        .value;
      const v2 = (r2 as PromiseFulfilledResult<{ created: boolean; topUp: { topUpId: number } }>)
        .value;
      expect(v1.topUp.topUpId).toBe(v2.topUp.topUpId);
      expect([v1.created, v2.created].sort()).toEqual([false, true]);
      expect(
        await q('SELECT 1 FROM top_ups WHERE credit_account_id=$1', [await creditAccount(d)]),
      ).toHaveLength(1);
    });

    it('hai request khác key cùng tài xế → đúng một pending, request kia 409 top_up_pending', async () => {
      const d = await driverWith(0);
      const results = await withAccountLocked(d, 2, () => [
        service.create(d, key(), { amountVnd: 100_000 }, IP),
        service.create(d, key(), { amountVnd: 200_000 }, IP),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect((bad[0]!.reason as TopUpRejected).code).toBe('top_up_pending');
      expect(
        await q(`SELECT 1 FROM top_ups WHERE credit_account_id=$1 AND status='pending'`, [
          await creditAccount(d),
        ]),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('get và quote', () => {
    it('GET của mình → top-up; của người khác / không có → not_found', async () => {
      const a = await driverWith(0);
      const b = await driverWith(0);
      const { topUp } = await service.create(a, key(), { amountVnd: 100_000 }, IP);
      expect(await service.get(a, topUp.topUpId, IP)).toEqual(topUp);
      expect((await rejection(service.get(b, topUp.topUpId, IP))).code).toBe('not_found');
      expect((await rejection(service.get(a, 999_999_999, IP))).code).toBe('not_found');
    });

    it('GET top-up pending đã quá hạn → payment_url = null', async () => {
      const d = await driverWith(0);
      const old = await existingTopUp(d, 'pending', { expiresIn: '-1 minute' });
      expect((await service.get(d, old, IP)).paymentUrl).toBeNull();
    });

    it('quote đủ điểm → số điểm tối đa theo min(điểm sống, trần 50 %); lô hết hạn không tính', async () => {
      const d = await driverWith(0);
      await earn(d, 3_000, '30 days');
      await earn(d, 9_000, '-1 day');
      expect(await service.quote(d, 200_000)).toEqual({
        pointsAvailable: 3_000,
        maxPoints: 3_000,
        maxDiscountVnd: 30_000,
      });
      expect(await service.quote(d, 50_000)).toEqual({
        pointsAvailable: 3_000,
        maxPoints: 2_500,
        maxDiscountVnd: 25_000,
      });
    });

    it('quote thiếu điểm (< 500, hoặc chưa có tài khoản) → 0, không phải lỗi', async () => {
      const d = await driverWith(0);
      await earn(d, 499, '30 days');
      expect(await service.quote(d, 200_000)).toEqual({
        pointsAvailable: 499,
        maxPoints: 0,
        maxDiscountVnd: 0,
      });
      expect(await service.quote(await newDriver(), 200_000)).toEqual({
        pointsAvailable: 0,
        maxPoints: 0,
        maxDiscountVnd: 0,
      });
    });

    it('quote amount_vnd sai → amount_out_of_range', async () => {
      const d = await driverWith(0);
      for (const amount of [49_999, 2_000_001])
        expect((await rejection(service.quote(d, amount))).code).toBe('amount_out_of_range');
    });
  });
});
