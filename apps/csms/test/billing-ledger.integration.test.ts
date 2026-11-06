/**
 * Test tích hợp sổ cái billing (T32 Phần 3): `CreditLedgerService.post` / `getBalance` /
 * `ensureAccounts` và `LoyaltyService.earnForSession` (WF-02 decisions D6, D9).
 *
 * Vì sao tồn tại: bất biến `balance_vnd = Σ amount_vnd` và "mỗi khoản tiền chỉ ghi một lần" chỉ
 * kiểm được trên Postgres thật — khoá `FOR UPDATE`, unique partial và hai transaction song song.
 * DB không có CHECK dấu tiền nào trên `credit_transactions`, nên các ca sai dấu ở đây là lớp bảo vệ
 * duy nhất.
 *
 * Ca song song được ép chồng nhau một cách tất định (`overlap`): A ghi nhưng chưa COMMIT, B bắt đầu
 * và phải **đứng chờ khoá** (thấy qua `pg_stat_activity`) rồi A mới COMMIT. Bỏ `FOR UPDATE` trong
 * `post` thì B không chờ và test fail.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import type { PoolClient } from 'pg';
import {
  CreditAccountNotFound,
  LedgerEntryExists,
  LedgerPostRejected,
} from '../src/billing/billing-errors.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const LOCK_WAIT_TIMEOUT_MS = 5000;

describeDb('billing: sổ cái credit và loyalty earn (T32 Phần 3)', () => {
  let db: Db;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  let cp: number;
  let connector: number;
  let driverA: number;
  let driverB: number;
  let accountA: number;
  let accountB: number;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const id = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))['id']);

  /** Chạy `work` trong một transaction riêng (bên gọi BEGIN, service thì không). */
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

  /** Chờ tới khi backend `pid` đứng chờ khoá dòng; quá hạn thì fail. */
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

  /**
   * Ép hai transaction chồng nhau: A BEGIN + workA (chưa COMMIT); B BEGIN + workB (chưa await);
   * chờ B đứng chờ khoá; COMMIT A; rồi chờ B (COMMIT nếu thành công, ROLLBACK nếu lỗi).
   */
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
      [`${name}@t32.test`, name],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    return u;
  }

  let topUpSeq = 0;
  async function newTopUp(accountId: number, amount = 500000): Promise<number> {
    topUpSeq++;
    return id(
      `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,idempotency_key,expires_at)
       VALUES($1,$2,$3,$3,$4,now()+interval '15 minutes') RETURNING id`,
      [`GW-T32-${topUpSeq}`, accountId, amount, `idem-t32-${topUpSeq}`],
    );
  }

  async function newSession(driverId: number): Promise<number> {
    return id(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,
         cp_started_at,meter_start_wh,driver_id)
       VALUES($1,$2,1,'TAG','rfid','csms_billed',now(),0,$3) RETURNING id`,
      [connector, cp, driverId],
    );
  }

  const ledgerRows = (accountId: number) =>
    q(
      'SELECT entry_no,amount_vnd,balance_after_vnd FROM credit_transactions WHERE credit_account_id=$1 ORDER BY entry_no',
      [accountId],
    );
  const account = (accountId: number) =>
    one('SELECT status,balance_vnd FROM credit_accounts WHERE id=$1', [accountId]);

  /** Bất biến: snapshot = Σ sổ cái, dòng cuối khớp snapshot, entry_no liền 1..n. */
  async function expectInvariant(accountId: number): Promise<void> {
    const rows = await ledgerRows(accountId);
    const snapshot = Number((await account(accountId))['balance_vnd']);
    const sum = rows.reduce((s, r) => s + Number(r['amount_vnd']), 0);
    expect(snapshot).toBe(sum);
    if (rows.length) expect(Number(rows.at(-1)!['balance_after_vnd'])).toBe(snapshot);
    expect(rows.map((r) => Number(r['entry_no']))).toEqual(rows.map((_, i) => i + 1));
  }

  async function closeAccount(accountId: number): Promise<void> {
    await q(
      "UPDATE credit_accounts SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1",
      [accountId],
    );
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
    cp = await id("INSERT INTO charge_points(serial_number) VALUES('T32-CP') RETURNING id");
    connector = await id(
      'INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id',
      [cp],
    );
    driverA = await newDriver('a');
    driverB = await newDriver('b');
    accountA = (await ledger.ensureAccounts(driverA)).creditAccountId;
    accountB = (await ledger.ensureAccounts(driverB)).creditAccountId;
  });

  describe('post: bất biến số dư', () => {
    it('sau nhiều lần post: balance_vnd = Σ amount_vnd, dòng cuối = snapshot', async () => {
      const t1 = await newTopUp(accountA, 500000);
      const s1 = await newSession(driverA);
      await inTx(async (c) => {
        const e = await ledger.post(c, accountA, 'top_up', 500000, { topUpId: t1 });
        expect(e).toMatchObject({ entryNo: 1, amountVnd: 500000, balanceAfterVnd: 500000 });
      });
      await inTx((c) => ledger.post(c, accountA, 'session_debit', -700000, { sessionId: s1 }));
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 50000, {}));
      await inTx((c) => ledger.post(c, accountA, 'refund', -30000, {}));
      const dup = await rejection(
        inTx((c) => ledger.post(c, accountA, 'session_debit', -1000, { sessionId: s1 })),
      );
      expect(dup).toBeInstanceOf(LedgerEntryExists);
      await expectInvariant(accountA);
      expect(Number((await account(accountA))['balance_vnd'])).toBe(-180000);
    });

    it('hai post chồng nhau trên cùng tài khoản: B chờ khoá, entry_no không trùng, số dư đúng', async () => {
      const { a, b } = await overlap(
        (c) => ledger.post(c, accountA, 'adjustment', 1000, {}),
        (c) => ledger.post(c, accountA, 'adjustment', 2000, {}),
      );
      expect(a).toMatchObject({ entryNo: 1, balanceAfterVnd: 1000 });
      expect(b.status).toBe('fulfilled');
      expect((b as PromiseFulfilledResult<unknown>).value).toMatchObject({
        entryNo: 2,
        balanceAfterVnd: 3000,
      });
      expect(Number((await account(accountA))['balance_vnd'])).toBe(3000);
      await expectInvariant(accountA);
    });
  });

  describe('post: trạng thái tài khoản', () => {
    it('active → in_shortfall khi âm → active khi về ≥ 0', async () => {
      const s = await newSession(driverA);
      const e = await inTx((c) =>
        ledger.post(c, accountA, 'session_debit', -10000, { sessionId: s }),
      );
      expect(e.status).toBe('in_shortfall');
      expect((await account(accountA))['status']).toBe('in_shortfall');
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 5000, {}));
      expect((await account(accountA))['status']).toBe('in_shortfall');
      const t = await newTopUp(accountA, 50000);
      await inTx((c) => ledger.post(c, accountA, 'top_up', 5000, { topUpId: t }));
      expect((await account(accountA))['status']).toBe('active');
      await expectInvariant(accountA);
    });

    it('closed: từ chối top_up / session_debit, nhận refund / adjustment âm, giữ closed', async () => {
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 100000, {}));
      await closeAccount(accountA);
      const t = await newTopUp(accountA);
      const s = await newSession(driverA);
      const r1 = await rejection(
        inTx((c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: t })),
      );
      expect(r1).toBeInstanceOf(LedgerPostRejected);
      expect((r1 as LedgerPostRejected).reason).toBe('account_closed');
      const r2 = await rejection(
        inTx((c) => ledger.post(c, accountA, 'session_debit', -1000, { sessionId: s })),
      );
      expect((r2 as LedgerPostRejected).reason).toBe('account_closed');

      await inTx((c) => ledger.post(c, accountA, 'refund', -60000, {}));
      const e = await inTx((c) => ledger.post(c, accountA, 'adjustment', -40000, {}));
      expect(e).toMatchObject({ balanceAfterVnd: 0, status: 'closed' });
      expect(await account(accountA)).toMatchObject({ status: 'closed', balance_vnd: '0' });
      await expectInvariant(accountA);
    });

    it('closed: adjustment dương → invalid_amount; refund làm âm → closed_account_overdraw', async () => {
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 10000, {}));
      await closeAccount(accountA);
      const r1 = await rejection(inTx((c) => ledger.post(c, accountA, 'adjustment', 1, {})));
      expect((r1 as LedgerPostRejected).reason).toBe('invalid_amount');
      const r2 = await rejection(inTx((c) => ledger.post(c, accountA, 'refund', -10001, {})));
      expect((r2 as LedgerPostRejected).reason).toBe('closed_account_overdraw');
      expect(Number((await account(accountA))['balance_vnd'])).toBe(10000);
      await inTx((c) => ledger.post(c, accountA, 'refund', -10000, {}));
      expect(await account(accountA)).toMatchObject({ status: 'closed', balance_vnd: '0' });
      await expectInvariant(accountA);
    });
  });

  describe('post: kiểm đầu vào', () => {
    it.each([
      ['top_up', 0, 'invalid_amount'],
      ['top_up', -1, 'invalid_amount'],
      ['session_debit', 1, 'invalid_amount'],
      ['refund', 0, 'invalid_amount'],
      ['refund', 1, 'invalid_amount'],
      ['reservation_fee', 1, 'invalid_amount'],
      ['adjustment', 0, 'invalid_amount'],
      ['adjustment', 1.5, 'invalid_amount'],
      ['adjustment', Number.MAX_SAFE_INTEGER + 1, 'invalid_amount'],
      ['top_up', 1000, 'missing_reference'],
      ['session_debit', -1000, 'missing_reference'],
      ['reservation_fee', -1000, 'missing_reference'],
    ] as const)('%s %p → %s, DB không đổi', async (type, amount, reason) => {
      const err = await rejection(inTx((c) => ledger.post(c, accountA, type, amount, {})));
      expect(err).toBeInstanceOf(LedgerPostRejected);
      expect((err as LedgerPostRejected).reason).toBe(reason);
      expect(await ledgerRows(accountA)).toEqual([]);
    });

    it('reservationId trên loại khác reservation_fee → missing_reference', async () => {
      const err = await rejection(
        inTx((c) => ledger.post(c, accountA, 'adjustment', 1000, { reservationId: 1 })),
      );
      expect((err as LedgerPostRejected).reason).toBe('missing_reference');
    });

    it('tài khoản không tồn tại → CreditAccountNotFound', async () => {
      const err = await rejection(inTx((c) => ledger.post(c, 999999, 'adjustment', 1000, {})));
      expect(err).toBeInstanceOf(CreditAccountNotFound);
    });

    it('reference_mismatch: top-up của tài khoản khác, top-up không có, phiên của tài xế khác', async () => {
      const tB = await newTopUp(accountB);
      const sB = await newSession(driverB);
      const attempts: (() => Promise<unknown>)[] = [
        () => inTx((c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: tB })),
        () => inTx((c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: 999999 })),
        () => inTx((c) => ledger.post(c, accountA, 'session_debit', -1000, { sessionId: sB })),
        () => inTx((c) => ledger.post(c, accountA, 'refund', -1000, { topUpId: tB })),
      ];
      for (const attempt of attempts) {
        const err = await rejection(attempt());
        expect(err).toBeInstanceOf(LedgerPostRejected);
        expect((err as LedgerPostRejected).reason).toBe('reference_mismatch');
      }
      expect(await ledgerRows(accountA)).toEqual([]);
    });
  });

  describe('post: mỗi khoản tiền chỉ ghi một lần', () => {
    it('top_up lần hai cùng top-up → LedgerEntryExists, transaction vẫn dùng được', async () => {
      const t = await newTopUp(accountA);
      const first = await inTx((c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: t }));
      await inTx(async (c) => {
        const err = await rejection(ledger.post(c, accountA, 'top_up', 500000, { topUpId: t }));
        expect(err).toBeInstanceOf(LedgerEntryExists);
        expect((err as LedgerEntryExists).existing.id).toBe(first.id);
        expect((err as LedgerEntryExists).constraint).toBe(
          'credit_transactions_one_per_top_up_and_type',
        );
        // Không có câu SQL nào lỗi → transaction không bị aborted.
        await c.query('SELECT 1');
        // Cùng top-up, loại khác (refund) vẫn được.
        await ledger.post(c, accountA, 'refund', -500000, { topUpId: t });
      });
      expect(await ledgerRows(accountA)).toHaveLength(2);
      await expectInvariant(accountA);
    });

    it('hai transaction chồng nhau post top_up cùng top-up → một dòng, B nhận LedgerEntryExists (không 23505)', async () => {
      const t = await newTopUp(accountA);
      const { a, b } = await overlap(
        (c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: t }),
        (c) => ledger.post(c, accountA, 'top_up', 500000, { topUpId: t }),
      );
      expect(b.status).toBe('rejected');
      const err = (b as PromiseRejectedResult).reason as LedgerEntryExists & { code?: string };
      expect(err).toBeInstanceOf(LedgerEntryExists);
      expect(err.code).toBeUndefined();
      expect(err.existing.id).toBe(a.id);
      expect(await ledgerRows(accountA)).toHaveLength(1);
      expect(Number((await account(accountA))['balance_vnd'])).toBe(500000);
    });

    it('session_debit lặp cùng phiên → LedgerEntryExists', async () => {
      const s = await newSession(driverA);
      const first = await inTx((c) =>
        ledger.post(c, accountA, 'session_debit', -1000, { sessionId: s }),
      );
      const err = await rejection(
        inTx((c) => ledger.post(c, accountA, 'session_debit', -1000, { sessionId: s })),
      );
      expect(err).toBeInstanceOf(LedgerEntryExists);
      expect((err as LedgerEntryExists).existing.id).toBe(first.id);
    });

    it('reservation_fee lặp cùng reservation → LedgerEntryExists (unique reservation_id)', async () => {
      const r = await id(
        `INSERT INTO reservations(driver_id,connector_id,hold_mode,expires_at)
         VALUES($1,$2,'csms_only',now()+interval '1 hour') RETURNING id`,
        [driverA, connector],
      );
      const first = await inTx((c) =>
        ledger.post(c, accountA, 'reservation_fee', -20000, { reservationId: r }),
      );
      await inTx(async (c) => {
        const err = await rejection(
          ledger.post(c, accountA, 'reservation_fee', -20000, { reservationId: r }),
        );
        expect(err).toBeInstanceOf(LedgerEntryExists);
        expect((err as LedgerEntryExists).existing.id).toBe(first.id);
        expect((err as LedgerEntryExists).constraint).toBe(
          'credit_transactions_reservation_id_key',
        );
        await c.query('SELECT 1'); // transaction không bị aborted
      });
      expect(await ledgerRows(accountA)).toHaveLength(1);
      await expectInvariant(accountA);
    });

    it('hai dòng refund top_up_id NULL được phép (guard bấm đúp ở AccountClosureService, D6)', async () => {
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 10000, {}));
      await inTx((c) => ledger.post(c, accountA, 'refund', -1000, {}));
      await inTx((c) => ledger.post(c, accountA, 'refund', -1000, {}));
      expect(await ledgerRows(accountA)).toHaveLength(3);
      await expectInvariant(accountA);
    });
  });

  describe('getBalance', () => {
    it('đọc snapshot, không cộng lại sổ', async () => {
      await inTx((c) => ledger.post(c, accountA, 'adjustment', 7000, {}));
      expect(await ledger.getBalance(accountA)).toBe(7000);
      // Làm lệch snapshot so với sổ: getBalance phải trả snapshot.
      await q('UPDATE credit_accounts SET balance_vnd=123,updated_at=now() WHERE id=$1', [
        accountA,
      ]);
      expect(await ledger.getBalance(accountA)).toBe(123);
    });

    it('tài khoản không có → CreditAccountNotFound', async () => {
      await expect(ledger.getBalance(999999)).rejects.toBeInstanceOf(CreditAccountNotFound);
    });
  });

  describe('ensureAccounts', () => {
    it('gọi hai lần → cùng bộ tài khoản', async () => {
      const a1 = await ledger.ensureAccounts(driverA);
      const a2 = await ledger.ensureAccounts(driverA);
      expect(a2).toEqual(a1);
      expect(a1.creditAccountId).toBe(accountA);
      expect(a1.loyaltyAccountId).toBeGreaterThan(0);
    });

    it('gọi song song trên tài xế mới → một bộ tài khoản', async () => {
      const d = await newDriver('c');
      const all = await Promise.all(Array.from({ length: 5 }, () => ledger.ensureAccounts(d)));
      for (const r of all) expect(r).toEqual(all[0]);
      for (const table of ['credit_accounts', 'loyalty_accounts']) {
        expect(await one(`SELECT count(*)::int n FROM ${table} WHERE driver_id=$1`, [d])).toEqual({
          n: 1,
        });
      }
    });
  });

  describe('LoyaltyService.earnForSession', () => {
    it('tạo loyalty account khi thiếu, entry_no, expires_at +12 tháng, cập nhật points_balance', async () => {
      const d = await newDriver('d');
      const s = await newSession(d);
      const r = await inTx((c) => loyalty.earnForSession(c, d, s, 25));
      expect(r).toMatchObject({ entryNo: 1, created: true });
      const row = await one(
        `SELECT t.transaction_type,t.points,t.session_id,
           t.expires_at = t.created_at + interval '12 months' AS ok_expiry, a.points_balance
         FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id=t.loyalty_account_id
         WHERE t.id=$1 AND a.driver_id=$2`,
        [r.id, d],
      );
      expect(row).toMatchObject({
        transaction_type: 'earn',
        points: '25',
        session_id: String(s),
        ok_expiry: true,
        points_balance: '25',
      });
    });

    it('gọi lặp cùng phiên → một dòng earn, điểm không cộng hai lần', async () => {
      const s = await newSession(driverA);
      const first = await inTx((c) => loyalty.earnForSession(c, driverA, s, 10));
      const again = await inTx((c) => loyalty.earnForSession(c, driverA, s, 10));
      expect(again).toEqual({ id: first.id, entryNo: first.entryNo, created: false });
      const s2 = await newSession(driverA);
      const second = await inTx((c) => loyalty.earnForSession(c, driverA, s2, 0));
      expect(second).toMatchObject({ entryNo: 2, created: true });
      expect(
        await q(
          "SELECT session_id FROM loyalty_transactions WHERE transaction_type='earn' ORDER BY entry_no",
        ),
      ).toEqual([{ session_id: String(s) }, { session_id: String(s2) }]);
      expect(
        await one('SELECT points_balance FROM loyalty_accounts WHERE driver_id=$1', [driverA]),
      ).toEqual({ points_balance: '10' });
    });

    it('phiên của tài xế khác (chưa có earn) → reference_mismatch, không ghi gì', async () => {
      const sA = await newSession(driverA);
      const err = await rejection(inTx((c) => loyalty.earnForSession(c, driverB, sA, 10)));
      expect(err).toBeInstanceOf(LedgerPostRejected);
      expect((err as LedgerPostRejected).reason).toBe('reference_mismatch');
      expect(await q('SELECT 1 FROM loyalty_transactions')).toEqual([]);
    });

    it('phiên không tồn tại → reference_mismatch', async () => {
      const err = await rejection(inTx((c) => loyalty.earnForSession(c, driverA, 999999, 10)));
      expect((err as LedgerPostRejected).reason).toBe('reference_mismatch');
    });

    it('points âm hoặc không nguyên → LedgerPostRejected(invalid_amount)', async () => {
      const s = await newSession(driverA);
      for (const p of [-1, 1.5]) {
        const err = await rejection(inTx((c) => loyalty.earnForSession(c, driverA, s, p)));
        expect((err as LedgerPostRejected).reason).toBe('invalid_amount');
      }
    });
  });
});
