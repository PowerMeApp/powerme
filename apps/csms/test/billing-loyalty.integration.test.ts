/**
 * Test tích hợp loyalty phần nạp (T32 Phần 4): `LoyaltyService.quoteRedemption`, `redeemForTopUp`,
 * `restoreForTopUp`, `expireDueForAccount` (WF-02 decisions D3, D11; BR-P35–P37).
 *
 * Vì sao tồn tại: lô điểm nhận diện bằng `expires_at` chính xác µs (copy bằng SQL), khoá
 * `loyalty_accounts FOR UPDATE` và "gọi lặp không ghi thêm" chỉ kiểm được trên Postgres thật.
 * Earn được dựng thẳng bằng SQL với `expires_at` cố định; service nhận `asOf` để test kiểm soát
 * thời gian.
 *
 * Ca song song dùng `overlap` (như `billing-ledger.integration.test.ts`): A ghi chưa COMMIT, B phải
 * đứng chờ khoá rồi A mới COMMIT. Bỏ `FOR UPDATE` thì ca đó fail.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import type { PoolClient } from 'pg';
import {
  LedgerPostRejected,
  LoyaltyAccountNotFound,
  LoyaltyLedgerCorrupt,
  RedemptionRejected,
} from '../src/billing/billing-errors.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const LOCK_WAIT_TIMEOUT_MS = 5000;

/** Mốc "bây giờ" của test; lô sống ⇔ expires_at > AS_OF. */
const AS_OF = new Date('2027-06-01T00:00:00Z');
/** Hạn có phần µs lẻ để bắt lỗi dựng lại timestamp từ `Date` (ms). */
const DEAD_1 = '2027-03-01T00:00:00.000111Z';
const DEAD_2 = '2027-05-01T00:00:00.000222Z';
const LIVE_1 = '2027-07-01T00:00:00.000333Z';
const LIVE_2 = '2027-09-01T00:00:00.000444Z';
const LIVE_3 = '2027-11-01T00:00:00.000555Z';

describeDb(
  'billing: loyalty phần nạp — quote, redeem, restore, hết hạn theo lô (T32 Phần 4)',
  () => {
    let db: Db;
    let ledger: CreditLedgerService;
    let loyalty: LoyaltyService;
    let driverA: number;
    let driverB: number;
    let creditA: number;
    let creditB: number;
    let loyaltyA: number;

    const q = async (sql: string, params: unknown[] = []) =>
      (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
    const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
    const id = async (sql: string, params: unknown[] = []) =>
      Number((await one(sql, params))['id']);

    async function inTx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await db.$client.connect();
      try {
        await c.query('BEGIN');
        const r = await work(c);
        await c.query('COMMIT');
        return r;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    }

    async function rejection(p: Promise<unknown>): Promise<unknown> {
      try {
        await p;
      } catch (err) {
        return err;
      }
      throw new Error('kỳ vọng bị từ chối nhưng đã chạy được');
    }

    async function waitForLockWait(pid: number): Promise<void> {
      const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
      for (;;) {
        const row = await one('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
        if (row?.['wait_event_type'] === 'Lock') return;
        if (Date.now() > deadline) {
          throw new Error(`backend ${pid} không chờ khoá sau ${LOCK_WAIT_TIMEOUT_MS} ms`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    async function overlap<A, B>(
      workA: (c: PoolClient) => Promise<A>,
      workB: (c: PoolClient) => Promise<B>,
    ): Promise<{ a: A; b: PromiseSettledResult<B> }> {
      const ca = await db.$client.connect();
      const cb = await db.$client.connect();
      try {
        await ca.query('BEGIN');
        const a = await workA(ca);
        await cb.query('BEGIN');
        const pid = Number((await cb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const pending = workB(cb).then(
          async (r) => {
            await cb.query('COMMIT');
            return r;
          },
          async (err: unknown) => {
            await cb.query('ROLLBACK');
            throw err;
          },
        );
        const settledB = Promise.allSettled([pending]).then(([r]) => r!);
        try {
          await waitForLockWait(pid);
        } finally {
          await ca.query('COMMIT');
        }
        return { a, b: await settledB };
      } finally {
        ca.release();
        cb.release();
      }
    }

    async function newDriver(name: string): Promise<number> {
      const u = await id(
        "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id",
        [`${name}@t32p4.test`, name],
      );
      await q(
        "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
        [u],
      );
      return u;
    }

    let topUpSeq = 0;
    /** Top-up dùng `points` điểm (giảm `points × 10` VND), như `TopUpService.create` sẽ ghi. */
    async function newTopUp(creditAccountId: number, points: number, amount = 500000) {
      topUpSeq++;
      return id(
        `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,points_redeemed,
         points_discount_vnd,amount_paid_vnd,idempotency_key,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes') RETURNING id`,
        [
          `GW-T32P4-${topUpSeq}`,
          creditAccountId,
          amount,
          points,
          points * 10,
          amount - points * 10,
          `idem-t32p4-${topUpSeq}`,
        ],
      );
    }

    /** Dòng earn với hạn cố định (không có phiên — loyalty_transactions không CHECK điều này). */
    async function seedEarn(loyaltyAccountId: number, points: number, expiresAt: string) {
      await q(
        `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
       SELECT $1,coalesce(max(entry_no),0)+1,'earn',$2,$3::timestamptz
       FROM loyalty_transactions WHERE loyalty_account_id=$1`,
        [loyaltyAccountId, points, expiresAt],
      );
      await q('UPDATE loyalty_accounts SET points_balance=points_balance+$2 WHERE id=$1', [
        loyaltyAccountId,
        points,
      ]);
    }

    /** Dòng sổ dạng gọn; expires_at in chính xác µs để so với lô gốc. */
    const rows = (loyaltyAccountId: number) =>
      q(
        `SELECT entry_no::int AS n, transaction_type AS type, points::int AS points,
              to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exp,
              top_up_id::int AS top_up
       FROM loyalty_transactions WHERE loyalty_account_id=$1 ORDER BY entry_no`,
        [loyaltyAccountId],
      );
    const typed = async (loyaltyAccountId: number, type: string) =>
      (await rows(loyaltyAccountId))
        .filter((r) => r['type'] === type)
        .map((r) => ({ points: r['points'], exp: r['exp'], topUp: r['top_up'] }));
    const balance = async (loyaltyAccountId: number) =>
      Number(
        (await one('SELECT points_balance FROM loyalty_accounts WHERE id=$1', [loyaltyAccountId]))[
          'points_balance'
        ],
      );

    /** Bất biến: points_balance = Σ points ≥ 0, entry_no liền 1..n — mọi tài khoản. */
    async function expectInvariant(): Promise<void> {
      for (const acc of await q('SELECT id, points_balance FROM loyalty_accounts')) {
        const r = await rows(Number(acc['id']));
        const sum = r.reduce((s, x) => s + Number(x['points']), 0);
        expect(Number(acc['points_balance'])).toBe(sum);
        expect(sum).toBeGreaterThanOrEqual(0);
        expect(r.map((x) => x['n'])).toEqual(r.map((_, i) => i + 1));
      }
    }

    beforeAll(() => {
      db = createDb(DATABASE_URL!);
    });
    afterAll(async () => {
      await db.$client.end();
    });

    beforeEach(async () => {
      await resetAndMigrate(db.$client);
      ledger = new CreditLedgerService(db);
      loyalty = new LoyaltyService({ pointsExpiryMonths: 12 });
      driverA = await newDriver('a');
      driverB = await newDriver('b');
      const a = await ledger.ensureAccounts(driverA);
      creditA = a.creditAccountId;
      loyaltyA = a.loyaltyAccountId;
      creditB = (await ledger.ensureAccounts(driverB)).creditAccountId;
    });
    afterEach(async () => {
      await expectInvariant();
    });

    describe('quoteRedemption', () => {
      it('chỉ tính điểm còn sống; dùng tối đa bị trần 50 % (50.000 VND → 2.500 điểm)', async () => {
        await seedEarn(loyaltyA, 5000, DEAD_1);
        await seedEarn(loyaltyA, 3000, LIVE_1);
        const exec = db.$client;
        expect(await loyalty.quoteRedemption(exec, driverA, 50000, { asOf: AS_OF })).toEqual({
          points: 2500,
          discountVnd: 25000,
          amountPaidVnd: 25000,
        });
        const err = await rejection(
          loyalty.quoteRedemption(exec, driverA, 50000, { requestedPoints: 2501, asOf: AS_OF }),
        );
        expect((err as RedemptionRejected).reason).toBe('exceeds_cap');
        const over = await rejection(
          loyalty.quoteRedemption(exec, driverA, 2_000_000, { requestedPoints: 3001, asOf: AS_OF }),
        );
        expect((over as RedemptionRejected).reason).toBe('insufficient_points');
      });

      it('chỉ có điểm hết hạn → below_minimum (dù points_balance ≥ 500)', async () => {
        await seedEarn(loyaltyA, 5000, DEAD_1);
        const err = await rejection(
          loyalty.quoteRedemption(db.$client, driverA, 500000, { asOf: AS_OF }),
        );
        expect((err as RedemptionRejected).reason).toBe('below_minimum');
      });

      it('tài xế chưa có loyalty account → below_minimum, không tạo tài khoản', async () => {
        const d = await newDriver('chua-co');
        const err = await rejection(
          loyalty.quoteRedemption(db.$client, d, 500000, { asOf: AS_OF }),
        );
        expect(err).toBeInstanceOf(RedemptionRejected);
        expect((err as RedemptionRejected).reason).toBe('below_minimum');
        expect(await q('SELECT 1 FROM loyalty_accounts WHERE driver_id=$1', [d])).toEqual([]);
      });

      it('không ghi gì (chỉ đọc)', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const before = await rows(loyaltyA);
        await loyalty.quoteRedemption(db.$client, driverA, 500000, { asOf: AS_OF });
        expect(await rows(loyaltyA)).toEqual(before);
      });
    });

    describe('redeemForTopUp', () => {
      it('tiêu lô cũ nhất trước; qua hai lô → hai dòng mang đúng hạn (µs) của lô', async () => {
        await seedEarn(loyaltyA, 300, LIVE_2);
        await seedEarn(loyaltyA, 400, LIVE_1);
        await seedEarn(loyaltyA, 900, LIVE_3);
        const t = await newTopUp(creditA, 600);
        const r = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: true, redeemedPoints: 600, shortfallPoints: 0 });
        expect(r.entries).toHaveLength(2);
        expect(await typed(loyaltyA, 'redeem')).toEqual([
          { points: -400, exp: LIVE_1, topUp: t },
          { points: -200, exp: LIVE_2, topUp: t },
        ]);
        expect(await typed(loyaltyA, 'adjust')).toEqual([]);
        expect(await balance(loyaltyA)).toBe(1000);
      });

      it('lô trùng expires_at gộp làm một → một dòng redeem', async () => {
        await seedEarn(loyaltyA, 300, LIVE_1);
        await seedEarn(loyaltyA, 300, LIVE_1);
        const t = await newTopUp(creditA, 500);
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(await typed(loyaltyA, 'redeem')).toEqual([{ points: -500, exp: LIVE_1, topUp: t }]);
      });

      it('điểm hết hạn trước lúc cộng tiền, chưa chạy expire → redeem phần sống + adjust 0; expire sau đó không trừ hai lần', async () => {
        await seedEarn(loyaltyA, 400, DEAD_1);
        await seedEarn(loyaltyA, 300, LIVE_1);
        const t = await newTopUp(creditA, 600);
        const r = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: true, redeemedPoints: 300, shortfallPoints: 300 });
        expect(await typed(loyaltyA, 'redeem')).toEqual([{ points: -300, exp: LIVE_1, topUp: t }]);
        expect(await typed(loyaltyA, 'adjust')).toEqual([{ points: 0, exp: null, topUp: t }]);
        expect(await balance(loyaltyA)).toBe(400); // lô chết còn nằm trong snapshot tới khi expire

        const e = await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        expect(e.expiredPoints).toBe(400);
        expect(await typed(loyaltyA, 'expire')).toEqual([
          { points: -400, exp: DEAD_1, topUp: null },
        ]);
        expect(await balance(loyaltyA)).toBe(0);
      });

      it('điểm đã bị expire trước lúc cộng tiền → chỉ adjust 0, points_balance không âm', async () => {
        await seedEarn(loyaltyA, 700, DEAD_1);
        await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        const t = await newTopUp(creditA, 600);
        const r = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: true, redeemedPoints: 0, shortfallPoints: 600 });
        expect(await typed(loyaltyA, 'redeem')).toEqual([]);
        expect(await typed(loyaltyA, 'adjust')).toEqual([{ points: 0, exp: null, topUp: t }]);
        expect(await balance(loyaltyA)).toBe(0);
      });

      it('gọi lặp cùng top-up → không ghi thêm, trả kết quả cũ', async () => {
        await seedEarn(loyaltyA, 400, DEAD_1);
        await seedEarn(loyaltyA, 300, LIVE_1);
        const t = await newTopUp(creditA, 600);
        const first = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        const before = await rows(loyaltyA);
        const again = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(again).toMatchObject({ created: false, redeemedPoints: 300, shortfallPoints: 300 });
        expect(again.entries.map((x) => x.id)).toEqual(first.entries.map((x) => x.id));
        expect(await rows(loyaltyA)).toEqual(before);
      });

      it('top-up không dùng điểm → không ghi gì', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const t = await newTopUp(creditA, 0);
        const r = await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: false, redeemedPoints: 0, shortfallPoints: 0 });
        expect(await typed(loyaltyA, 'redeem')).toEqual([]);
      });

      it('top-up của tài xế khác / không tồn tại → reference_mismatch, không ghi gì', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const tB = await newTopUp(creditB, 500);
        for (const topUp of [tB, 999999]) {
          const err = await rejection(
            inTx((c) => loyalty.redeemForTopUp(c, driverA, topUp, AS_OF)),
          );
          expect(err).toBeInstanceOf(LedgerPostRejected);
          expect((err as LedgerPostRejected).reason).toBe('reference_mismatch');
        }
        expect((await rows(loyaltyA)).map((r) => r['type'])).toEqual(['earn']);
      });

      it('chạy được sau CreditLedgerService.post trong cùng transaction (thứ tự khoá)', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const t = await newTopUp(creditA, 500);
        await inTx(async (c) => {
          await c.query('SELECT 1 FROM top_ups WHERE id=$1 FOR UPDATE', [t]);
          await ledger.post(c, creditA, 'top_up', 500000, { topUpId: t });
          await loyalty.redeemForTopUp(c, driverA, t);
        });
        expect(await balance(loyaltyA)).toBe(300);
      });

      it('hai redeem chồng nhau trên cùng tài khoản: B chờ khoá; tổng trừ ≤ điểm có, phần thiếu thành adjust', async () => {
        await seedEarn(loyaltyA, 1000, LIVE_1);
        const t1 = await newTopUp(creditA, 600);
        const t2 = await newTopUp(creditA, 600);
        const { a, b } = await overlap(
          (c) => loyalty.redeemForTopUp(c, driverA, t1, AS_OF),
          (c) => loyalty.redeemForTopUp(c, driverA, t2, AS_OF),
        );
        expect(a).toMatchObject({ redeemedPoints: 600, shortfallPoints: 0 });
        expect(b.status).toBe('fulfilled');
        expect((b as PromiseFulfilledResult<typeof a>).value).toMatchObject({
          redeemedPoints: 400,
          shortfallPoints: 200,
        });
        expect(await typed(loyaltyA, 'redeem')).toEqual([
          { points: -600, exp: LIVE_1, topUp: t1 },
          { points: -400, exp: LIVE_1, topUp: t2 },
        ]);
        expect(await typed(loyaltyA, 'adjust')).toEqual([{ points: 0, exp: null, topUp: t2 }]);
        expect(await balance(loyaltyA)).toBe(0);
      });
    });

    describe('restoreForTopUp', () => {
      it('top-up có điểm đã hết hạn (adjust) → trả −Σ redeem, không theo points_redeemed, đúng hạn cũ', async () => {
        await seedEarn(loyaltyA, 400, DEAD_1);
        await seedEarn(loyaltyA, 200, LIVE_1);
        await seedEarn(loyaltyA, 500, LIVE_2);
        const t = await newTopUp(creditA, 900);
        await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF)); // 700 sống, thiếu 200
        const r = await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: true, restoredPoints: 700, expiredPoints: 0 });
        expect(await typed(loyaltyA, 'restore')).toEqual([
          { points: 200, exp: LIVE_1, topUp: t },
          { points: 500, exp: LIVE_2, topUp: t },
        ]);
        expect(await balance(loyaltyA)).toBe(700);
      });

      it('lô đã tiêu nay hết hạn → restore về hạn cũ + expire ngay; points_balance = điểm sống ngay sau khi hoàn', async () => {
        await seedEarn(loyaltyA, 300, DEAD_2);
        await seedEarn(loyaltyA, 400, LIVE_1);
        const t = await newTopUp(creditA, 500);
        // Redeem lúc DEAD_2 còn sống.
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, new Date('2027-04-01T00:00:00Z')));
        expect(await typed(loyaltyA, 'redeem')).toEqual([
          { points: -300, exp: DEAD_2, topUp: t },
          { points: -200, exp: LIVE_1, topUp: t },
        ]);
        const r = await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        expect(r).toMatchObject({ created: true, restoredPoints: 500, expiredPoints: 300 });
        expect(await typed(loyaltyA, 'restore')).toEqual([
          { points: 300, exp: DEAD_2, topUp: t },
          { points: 200, exp: LIVE_1, topUp: t },
        ]);
        expect(await typed(loyaltyA, 'expire')).toEqual([
          { points: -300, exp: DEAD_2, topUp: null },
        ]);
        expect(await balance(loyaltyA)).toBe(400);
        const err = await rejection(
          loyalty.quoteRedemption(db.$client, driverA, 500000, { asOf: AS_OF }),
        );
        expect((err as RedemptionRejected).reason).toBe('below_minimum');

        const before = await rows(loyaltyA);
        const again = await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        expect(again).toMatchObject({ created: false, restoredPoints: 0, expiredPoints: 0 });
        expect(await rows(loyaltyA)).toEqual(before);
      });

      it('gọi lặp không trả hai lần; top-up không có redeem → không ghi gì', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const t = await newTopUp(creditA, 500);
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        const before = await rows(loyaltyA);
        const again = await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        expect(again.created).toBe(false);
        expect(await rows(loyaltyA)).toEqual(before);
        expect(await balance(loyaltyA)).toBe(800);

        const t0 = await newTopUp(creditA, 0);
        expect((await inTx((c) => loyalty.restoreForTopUp(c, driverA, t0, AS_OF))).created).toBe(
          false,
        );
        expect(await rows(loyaltyA)).toEqual(before);
      });

      it('sau restore, redeem lại cùng top-up → không ghi thêm', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        const t = await newTopUp(creditA, 500);
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF));
        await inTx((c) => loyalty.restoreForTopUp(c, driverA, t, AS_OF));
        const before = await rows(loyaltyA);
        expect((await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF))).created).toBe(
          false,
        );
        expect(await rows(loyaltyA)).toEqual(before);
      });

      it('top-up của tài xế khác → reference_mismatch', async () => {
        const tB = await newTopUp(creditB, 500);
        const err = await rejection(inTx((c) => loyalty.restoreForTopUp(c, driverA, tB, AS_OF)));
        expect((err as LedgerPostRejected).reason).toBe('reference_mismatch');
      });
    });

    describe('expireDueForAccount', () => {
      it('chỉ trừ phần còn sống của lô hết hạn (lô đã redeem một phần), mỗi lô một dòng', async () => {
        await seedEarn(loyaltyA, 500, DEAD_2);
        await seedEarn(loyaltyA, 200, DEAD_1);
        await seedEarn(loyaltyA, 900, LIVE_1);
        const t = await newTopUp(creditA, 520);
        await inTx((c) => loyalty.redeemForTopUp(c, driverA, t, new Date('2027-02-01T00:00:00Z')));
        // FIFO lúc đó: DEAD_1 (200) rồi DEAD_2 (320) → DEAD_2 còn 180.
        const r = await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        expect(r.expiredPoints).toBe(180);
        expect(await typed(loyaltyA, 'expire')).toEqual([
          { points: -180, exp: DEAD_2, topUp: null },
        ]);
        expect(await balance(loyaltyA)).toBe(900);
      });

      it('chạy lại → không trừ hai lần', async () => {
        await seedEarn(loyaltyA, 500, DEAD_1);
        await seedEarn(loyaltyA, 300, LIVE_1);
        await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        const before = await rows(loyaltyA);
        const again = await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF));
        expect(again).toEqual({ expiredPoints: 0, entries: [] });
        expect(await rows(loyaltyA)).toEqual(before);
        expect(await balance(loyaltyA)).toBe(300);
      });

      it('asOf mặc định = now() của DB: lô hạn trong tương lai không bị đụng', async () => {
        await seedEarn(loyaltyA, 500, '2099-01-01T00:00:00Z');
        expect((await inTx((c) => loyalty.expireDueForAccount(c, loyaltyA))).expiredPoints).toBe(0);
      });

      it('tài khoản không có → LoyaltyAccountNotFound', async () => {
        const err = await rejection(inTx((c) => loyalty.expireDueForAccount(c, 999999, AS_OF)));
        expect(err).toBeInstanceOf(LoyaltyAccountNotFound);
      });
    });

    describe('sổ điểm sai dạng → LoyaltyLedgerCorrupt, không ghi gì', () => {
      it('redeem có expires_at không khớp lô earn nào → unknown_lot', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        await q(
          `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,expires_at)
         VALUES($1,2,'redeem',-100,$2::timestamptz)`,
          [loyaltyA, '2027-07-01T00:00:00.000334Z'],
        );
        await q('UPDATE loyalty_accounts SET points_balance=700 WHERE id=$1', [loyaltyA]);
        const t = await newTopUp(creditA, 500);
        const err = await rejection(inTx((c) => loyalty.redeemForTopUp(c, driverA, t, AS_OF)));
        expect(err).toBeInstanceOf(LoyaltyLedgerCorrupt);
        expect((err as LoyaltyLedgerCorrupt).reason).toBe('unknown_lot');
        expect((err as LoyaltyLedgerCorrupt).entryNo).toBe(2);
        expect(await typed(loyaltyA, 'adjust')).toEqual([]);
      });

      it('points_balance lệch Σ points → balance_mismatch', async () => {
        await seedEarn(loyaltyA, 800, LIVE_1);
        await q('UPDATE loyalty_accounts SET points_balance=801 WHERE id=$1', [loyaltyA]);
        const err = await rejection(inTx((c) => loyalty.expireDueForAccount(c, loyaltyA, AS_OF)));
        expect((err as LoyaltyLedgerCorrupt).reason).toBe('balance_mismatch');
        await q('UPDATE loyalty_accounts SET points_balance=800 WHERE id=$1', [loyaltyA]);
      });
    });
  },
);
