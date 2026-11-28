/**
 * Test tích hợp job hết hạn điểm (T32 Phần 13): `LoyaltyService.expireDue` và việc nền
 * `loyalty-expire` (WF-02 decisions D11; BR-P36, SRS job #18).
 *
 * Vì sao tồn tại: chọn tài khoản theo Σ points của các dòng `expires_at <= now`, `FOR UPDATE SKIP
 * LOCKED`, phát lại sổ dưới khoá (hai lượt chồng nhau không trừ hai lần) và bỏ qua tài khoản `closed`
 * chỉ kiểm được trên Postgres thật. Lô dựng bằng SQL với `expires_at` có phần µs lẻ.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { PoolClient } from 'pg';
import { BackgroundWorkRunner } from '../src/billing/background-work.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LOYALTY_EXPIRE_WORK, LoyaltyService } from '../src/billing/loyalty.service.js';
import { ConfigModule } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Mốc "bây giờ" của test; lô sống ⇔ expires_at > AS_OF. */
const AS_OF = new Date('2027-06-01T00:00:00Z');
/** Lúc dùng điểm, trước khi DEAD_1 hết hạn. */
const BEFORE = new Date('2027-02-01T00:00:00Z');
const DEAD_1 = '2027-03-01T00:00:00.000111Z';
const LIVE_1 = '2027-07-01T00:00:00.000333Z';

describeDb('billing: job hết hạn điểm loyalty-expire (T32 Phần 13)', () => {
  let db: Db;
  let ledger: CreditLedgerService;
  let loyalty: LoyaltyService;
  let driverA: number;
  let creditA: number;
  let loyaltyA: number;
  let loyaltyB: number;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const id = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))['id']);

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

  async function newDriver(name: string): Promise<number> {
    const u = await id(
      "INSERT INTO users(email,full_name,role) VALUES($1,$2,'driver') RETURNING id",
      [`${name}@t32p13.test`, name],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    return u;
  }

  let seq = 0;
  /** Top-up `credited` dùng `points` điểm (như `billing-loyalty.integration.test.ts`). */
  async function newTopUp(creditAccountId: number, points: number) {
    seq++;
    return id(
      `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,points_redeemed,
         points_discount_vnd,amount_paid_vnd,status,idempotency_key,expires_at)
       VALUES($1,$2,500000,$3,$4,$5,'credited',$6,now()+interval '15 minutes') RETURNING id`,
      [`GW-T32P13-${seq}`, creditAccountId, points, points * 10, 500000 - points * 10, `k-${seq}`],
    );
  }

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

  /** Dòng sổ dạng gọn; expires_at in chính xác µs. */
  const rows = (loyaltyAccountId: number) =>
    q(
      `SELECT entry_no::int AS n, transaction_type AS type, points::int AS points,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exp
       FROM loyalty_transactions WHERE loyalty_account_id=$1 ORDER BY entry_no`,
      [loyaltyAccountId],
    );
  const expires = async (loyaltyAccountId: number) =>
    (await rows(loyaltyAccountId))
      .filter((r) => r['type'] === 'expire')
      .map((r) => ({ points: r['points'], exp: r['exp'] }));
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
    loyalty = new LoyaltyService({ pointsExpiryMonths: 12 }, db);
    driverA = await newDriver('a');
    const a = await ledger.ensureAccounts(driverA);
    creditA = a.creditAccountId;
    loyaltyA = a.loyaltyAccountId;
    const b = await ledger.ensureAccounts(await newDriver('b'));
    loyaltyB = b.loyaltyAccountId;
  });
  afterEach(async () => {
    await expectInvariant();
  });

  it('TC-F08-03 điểm hết hạn sau 12 tháng: job ghi một dòng expire, balance và summary khớp', async () => {
    const cp = await id(
      "INSERT INTO charge_points(serial_number) VALUES('T32P13-CP') RETURNING id",
    );
    const connector = await id(
      'INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id',
      [cp],
    );
    const session = await id(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,
         cp_started_at,meter_start_wh,driver_id)
       VALUES($1,$2,1,'TAG','rfid','csms_billed',now(),0,$3) RETURNING id`,
      [connector, cp, driverA],
    );
    await inTx((c) => loyalty.earnForSession(c, driverA, session, 1200));
    expect(
      (
        await one(
          `SELECT expires_at = created_at + interval '12 months' AS ok
           FROM loyalty_transactions WHERE session_id=$1`,
          [session],
        )
      )['ok'],
    ).toBe(true);
    await seedEarn(loyaltyA, 300, '2099-01-01T00:00:00.000777Z');

    // 12 tháng đã trôi qua: kéo hạn của lô earn về quá khứ.
    await q(
      "UPDATE loyalty_transactions SET expires_at = now() - interval '1 second' WHERE session_id=$1",
      [session],
    );
    const dead = (await rows(loyaltyA))[0]!['exp'];

    const r = await loyalty.expireDue();
    expect(r).toEqual({ accounts: 1, points: 1200, lots: 1, skipped: 0, failed: 0 });
    expect(await expires(loyaltyA)).toEqual([{ points: -1200, exp: dead }]);
    expect(await balance(loyaltyA)).toBe(300);
    const s = await loyalty.summary(db.$client, driverA);
    expect(s.pointsAvailable).toBe(300);
  });

  it('lô đã redeem một phần → chỉ trừ phần còn sống; lô chưa hết hạn không đụng; chạy lại không ghi thêm', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    await seedEarn(loyaltyA, 500, LIVE_1);
    const topUp = await newTopUp(creditA, 400);
    await inTx((c) => loyalty.redeemForTopUp(c, driverA, topUp, BEFORE));

    expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 1, points: 600, lots: 1 });
    expect(await expires(loyaltyA)).toEqual([{ points: -600, exp: DEAD_1 }]);
    expect(await balance(loyaltyA)).toBe(500);

    const before = (await rows(loyaltyA)).length;
    expect(await loyalty.expireDue(AS_OF)).toEqual({
      accounts: 0,
      points: 0,
      lots: 0,
      skipped: 0,
      failed: 0,
    });
    expect(await rows(loyaltyA)).toHaveLength(before);
  });

  it('tài khoản đang bị khoá → bỏ qua (SKIP LOCKED); lượt sau thấy dòng đã commit, không trừ lại', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    const ca = await db.$client.connect();
    try {
      await ca.query('BEGIN');
      await loyalty.expireDueForAccount(ca, loyaltyA, AS_OF);
      expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 0, skipped: 1 });
      await ca.query('COMMIT');
    } finally {
      ca.release();
    }
    expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 0, skipped: 0 });
    expect(await expires(loyaltyA)).toEqual([{ points: -1000, exp: DEAD_1 }]);
  });

  it('hai lượt song song (hai connection) → trừ đúng một lần', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    await seedEarn(loyaltyB, 700, DEAD_1);
    const other = new LoyaltyService({ pointsExpiryMonths: 12 }, db);
    const [r1, r2] = await Promise.all([loyalty.expireDue(AS_OF), other.expireDue(AS_OF)]);
    expect(r1.accounts + r2.accounts).toBe(2);
    expect(r1.points + r2.points).toBe(1700);
    expect(await expires(loyaltyA)).toEqual([{ points: -1000, exp: DEAD_1 }]);
    expect(await expires(loyaltyB)).toEqual([{ points: -700, exp: DEAD_1 }]);
  });

  it('tài khoản closed → không ghi; tài khoản khác cùng lượt vẫn được xử lý', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    await seedEarn(loyaltyB, 700, DEAD_1);
    await q(
      "UPDATE credit_accounts SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1",
      [creditA],
    );
    expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 1, points: 700, skipped: 0 });
    expect(await expires(loyaltyA)).toEqual([]);
    expect(await balance(loyaltyA)).toBe(1000);
    expect(await expires(loyaltyB)).toEqual([{ points: -700, exp: DEAD_1 }]);
  });

  it('restore vào lô đã hết hạn đã expire ngay (D3 ⊕) → job không trừ thêm', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    const topUp = await newTopUp(creditA, 600);
    await inTx((c) => loyalty.redeemForTopUp(c, driverA, topUp, BEFORE));
    const restored = await inTx((c) => loyalty.restoreForTopUp(c, driverA, topUp, AS_OF));
    expect(restored).toMatchObject({ restoredPoints: 600, expiredPoints: 1000 });

    expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 0, points: 0 });
    expect(await expires(loyaltyA)).toEqual([{ points: -1000, exp: DEAD_1 }]);
    expect(await balance(loyaltyA)).toBe(0);
  });

  it('sổ hỏng ở một tài khoản → failed, rollback; tài khoản khác vẫn expire', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    await seedEarn(loyaltyB, 700, DEAD_1);
    await q('UPDATE loyalty_accounts SET points_balance=999 WHERE id=$1', [loyaltyA]);
    expect(await loyalty.expireDue(AS_OF)).toMatchObject({ accounts: 1, points: 700, failed: 1 });
    expect(await expires(loyaltyA)).toEqual([]);
    // Trả lại snapshot đúng cho bất biến của afterEach.
    await q('UPDATE loyalty_accounts SET points_balance=1000 WHERE id=$1', [loyaltyA]);
  });

  it('runDue trả số tài khoản đã ghi; thiếu DB → ném rõ', async () => {
    await seedEarn(loyaltyA, 1000, DEAD_1);
    // runDue dùng now() của DB: đưa hạn về quá khứ thật.
    await q(
      "UPDATE loyalty_transactions SET expires_at = now() - interval '1 day' WHERE loyalty_account_id=$1",
      [loyaltyA],
    );
    expect(await loyalty.runDue(10, new AbortController().signal)).toBe(1);
    await expect(new LoyaltyService({ pointsExpiryMonths: 12 }).expireDue()).rejects.toThrow(
      'loyalty_expire_missing_db',
    );
  });

  it('BillingModule thật: loyalty-expire được đăng ký (kick không ném)', async () => {
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
        expect(() => app.get(BackgroundWorkRunner).kick(LOYALTY_EXPIRE_WORK)).not.toThrow();
      } finally {
        await app.close();
      }
    } finally {
      if (saved === undefined) delete process.env['BILLING_WORKER_ENABLED'];
      else process.env['BILLING_WORKER_ENABLED'] = saved;
    }
  });
});
