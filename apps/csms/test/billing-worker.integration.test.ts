/**
 * Test tích hợp worker quét DB dùng chung (T32 Phần 12, decisions D7): `claimDue` / `lockLeased` /
 * `runLeasedBatch` (giữ chỗ có hạn) và `BackgroundWorkRunner` trên Postgres thật.
 *
 * Vì sao tồn tại: "đúng một lần khi hai worker chạy song song" và "sập giữa chừng thì hết lease dòng quay
 * lại" chỉ kiểm được với khoá dòng thật. Chưa có việc nghiệp vụ (Phần 7/9), nên dùng một BackgroundWork
 * giả trên `e_invoices` / `refunds` dựng bằng SQL: `handle` đếm số lần gọi theo id rồi ghi `issued` ở tx2.
 *
 * Ca chồng nhau ép như `overlap` của billing-ledger / billing-loyalty: A giữ khoá chưa COMMIT, B phải đi
 * qua mà không chờ khoá. Bỏ `SKIP LOCKED` hoặc `FOR UPDATE` trong `claimDue` thì ca đó fail.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ScheduledTask, Scheduler } from '../src/common/scheduler.js';
import { BackgroundWork, BackgroundWorkRunner } from '../src/billing/background-work.js';
import type { BackgroundWorkConfig } from '../src/billing/background-work.config.js';
import {
  claimDue,
  LeasedRow,
  LeaseSpec,
  lockLeased,
  runLeasedBatch,
} from '../src/billing/due-rows.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const LOCK_WAIT_TIMEOUT_MS = 3000;
const LEASE_MS = 60_000;
const INVOICES: LeaseSpec = {
  table: 'e_invoices',
  statuses: ['requested', 'failed'],
  leaseMs: LEASE_MS,
};

class ManualScheduler implements Scheduler {
  readonly tasks: { fn: () => void; cancelled: boolean }[] = [];
  schedule(_delayMs: number, fn: () => void): ScheduledTask {
    const t = { fn, cancelled: false };
    this.tasks.push(t);
    return { cancel: () => (t.cancelled = true) };
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describeDb('billing: worker quét DB dùng chung — lease, SKIP LOCKED, runner (T32 Phần 12)', () => {
  let db: Db;
  let creditAccountId: number;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

  async function inTx<T>(c: PoolClient, work: () => Promise<T>): Promise<T> {
    await c.query('BEGIN');
    try {
      const r = await work();
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  }

  /** true nếu backend `pid` đứng chờ khoá trong `ms`; false nếu hết giờ mà không chờ. */
  async function waitsForLock(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const row = await one('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
      if (row?.['wait_event_type'] === 'Lock') return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  let seq = 0;
  /** Một top-up + một e_invoice; `dueSql` là biểu thức SQL cho `next_attempt_at`. */
  async function seedInvoice(status = 'requested', dueSql = "now() - interval '1 second'") {
    seq++;
    const topUp = Number(
      (
        await one(
          `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,
           idempotency_key,expires_at,status)
         VALUES($1,$2,100000,100000,$3,now()+interval '15 minutes','credited') RETURNING id`,
          [`GW-T32P12-${seq}`, creditAccountId, `idem-t32p12-${seq}`],
        )
      )['id'],
    );
    const issued = status === 'issued';
    return Number(
      (
        await one(
          `INSERT INTO e_invoices(top_up_id,status,amount_vnd,vat_amount_vnd,invoice_no,issued_at,
           next_attempt_at)
         VALUES($1,$2,100000,9091,$3,$4,${dueSql}) RETURNING id`,
          [topUp, status, issued ? `SEED-${seq}` : null, issued ? new Date() : null],
        )
      )['id'],
    );
  }

  const invoice = (id: number) =>
    one(
      `SELECT status, next_attempt_at::text AS next, updated_at::text AS updated
       FROM e_invoices WHERE id=$1`,
      [id],
    );

  /** Việc giả trên e_invoices: tx2 khoá lại theo lease rồi ghi `issued`. */
  class FakeInvoiceWork implements BackgroundWork {
    readonly calls = new Map<number, number>();
    lostLease = 0;
    constructor(
      readonly name: string,
      private readonly pool: Db['$client'],
      private readonly before: (row: LeasedRow, call: number) => Promise<void> = async () => {},
      private readonly spec: LeaseSpec = INVOICES,
    ) {}
    private total = 0;
    runDue(limit: number, signal: AbortSignal): Promise<number> {
      return runLeasedBatch(
        this.pool,
        { ...this.spec, limit },
        async (row) => {
          this.total++;
          this.calls.set(row.id, (this.calls.get(row.id) ?? 0) + 1);
          await this.before(row, this.total);
          const c = await this.pool.connect();
          try {
            await inTx(c, async () => {
              if (!(await lockLeased(c, 'e_invoices', row))) {
                this.lostLease++;
                return;
              }
              await c.query(
                `UPDATE e_invoices SET status='issued', invoice_no=$2, issued_at=now(),
                 attempt_count=attempt_count+1, last_attempt_at=now(), updated_at=now() WHERE id=$1`,
                [row.id, `INV-T32P12-${row.id}`],
              );
            });
          } finally {
            c.release();
          }
        },
        signal,
        { warn: () => undefined },
      );
    }
  }

  const config = (over: Partial<BackgroundWorkConfig> = {}): BackgroundWorkConfig => ({
    enabled: true,
    intervalMs: 30000,
    batchSize: 20,
    leaseMs: LEASE_MS,
    ...over,
  });

  beforeAll(async () => {
    if (new URL(DATABASE_URL!).pathname !== '/powerme_test')
      throw new Error('requires powerme_test');
    Logger.overrideLogger(false);
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    const u = Number(
      (
        await one(
          "INSERT INTO users(email,full_name,role) VALUES('w@t32p12.test','Worker','driver') RETURNING id",
        )
      )['id'],
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test-v1',now())",
      [u],
    );
    creditAccountId = Number(
      (await one('INSERT INTO credit_accounts(driver_id) VALUES($1) RETURNING id', [u]))['id'],
    );
  });
  afterAll(async () => {
    Logger.overrideLogger(['log', 'error', 'warn']);
    await db?.$client.end();
  });
  beforeEach(async () => {
    await q('TRUNCATE invoice_adjustments, e_invoices, refunds');
  });

  it('giữ chỗ chồng nhau: B không chờ khoá của A và không lấy dòng A đang giữ', async () => {
    const x = await seedInvoice('requested', "now() - interval '2 seconds'");
    const y = await seedInvoice('requested', "now() - interval '1 second'");
    const ca = await db.$client.connect();
    const cb = await db.$client.connect();
    try {
      await ca.query('BEGIN');
      const a = await claimDue(ca, { ...INVOICES, limit: 1 });
      expect(a.map((r) => r.id)).toEqual([x]);

      await cb.query('BEGIN');
      const pid = Number((await cb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const b = claimDue(cb, { ...INVOICES, limit: 1 });
      const blocked = await Promise.race([
        b.then(() => false),
        waitsForLock(pid, LOCK_WAIT_TIMEOUT_MS),
      ]);
      await ca.query('COMMIT');
      const bRows = await b;
      await cb.query('COMMIT');

      expect(blocked).toBe(false);
      expect(bRows.map((r) => r.id)).toEqual([y]);
      // Cả hai đang trong lease: lượt giữ chỗ sau không lấy lại.
      await inTx(ca, async () =>
        expect(await claimDue(ca, { ...INVOICES, limit: 10 })).toEqual([]),
      );
    } finally {
      ca.release();
      cb.release();
    }
  });

  it('hai runner trên hai pool chạy song song: mỗi dòng được xử lý đúng một lần', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(await seedInvoice());
    const db2 = createDb(DATABASE_URL!);
    try {
      // Lượt đầu của mỗi bên chờ nhau để hai runner chắc chắn chạy chồng lên nhau.
      let arrived = 0;
      const both = gate();
      const meet = async (_row: LeasedRow, call: number) => {
        if (call !== 1) return;
        if (++arrived === 2) both.open();
        await both.wait;
      };
      const wa = new FakeInvoiceWork('fake-invoice', db.$client, meet);
      const wb = new FakeInvoiceWork('fake-invoice', db2.$client, meet);
      const ra = new BackgroundWorkRunner(config({ batchSize: 3 }), new ManualScheduler());
      const rb = new BackgroundWorkRunner(config({ batchSize: 3 }), new ManualScheduler());
      ra.register(wa);
      rb.register(wb);
      await Promise.all([ra.sweep(), rb.sweep()]);

      const seen = new Map<number, number>();
      for (const w of [wa, wb])
        for (const [id, n] of w.calls) seen.set(id, (seen.get(id) ?? 0) + n);
      expect([...seen.keys()].sort((a, b) => a - b)).toEqual(ids);
      expect([...seen.values()].every((n) => n === 1)).toBe(true);
      expect(wa.calls.size).toBeGreaterThan(0);
      expect(wb.calls.size).toBeGreaterThan(0);
      const statuses = await q('SELECT DISTINCT status FROM e_invoices');
      expect(statuses).toEqual([{ status: 'issued' }]);
    } finally {
      await db2.$client.end();
    }
  });

  it('dòng chưa đến hạn và dòng sai trạng thái không bị đụng', async () => {
    const later = await seedInvoice('requested', "now() + interval '1 hour'");
    const issued = await seedInvoice('issued');
    const review = await seedInvoice('needs_review');
    const before = await Promise.all([later, issued, review].map(invoice));
    const w = new FakeInvoiceWork('fake-invoice', db.$client);
    expect(await w.runDue(20, new AbortController().signal)).toBe(0);
    expect(await Promise.all([later, issued, review].map(invoice))).toEqual(before);
  });

  it('dòng đang trong lease không bị lấy lại; runner sập sau khi giữ chỗ → hết lease thì runner khác lấy được', async () => {
    const x = await seedInvoice();
    const c = await db.$client.connect();
    let claimed: LeasedRow[];
    try {
      // "Runner sập": giữ chỗ, COMMIT, rồi không bao giờ ghi kết quả.
      claimed = await inTx(c, () => claimDue(c, { ...INVOICES, leaseMs: 300, limit: 1 }));
    } finally {
      c.release();
    }
    expect(claimed.map((r) => r.id)).toEqual([x]);
    expect((await invoice(x))['status']).toBe('requested');

    const other = new FakeInvoiceWork('fake-invoice', db.$client);
    expect(await other.runDue(20, new AbortController().signal)).toBe(0);

    await new Promise((r) => setTimeout(r, 400));
    expect(await other.runDue(20, new AbortController().signal)).toBe(1);
    expect((await invoice(x))['status']).toBe('issued');
  });

  it('lease mất: token cũ không khoá được dòng, token mới thì được', async () => {
    const x = await seedInvoice();
    const c = await db.$client.connect();
    try {
      const [old] = await inTx(c, () => claimDue(c, { ...INVOICES, leaseMs: 200, limit: 1 }));
      await new Promise((r) => setTimeout(r, 300));
      const [fresh] = await inTx(c, () => claimDue(c, { ...INVOICES, limit: 1 }));
      expect(fresh!.id).toBe(x);
      expect(fresh!.leaseToken).not.toBe(old!.leaseToken);
      await inTx(c, async () => {
        expect(await lockLeased(c, 'e_invoices', old!)).toBeNull();
        expect((await lockLeased(c, 'e_invoices', fresh!))?.['id']).toBe(String(x));
      });
    } finally {
      c.release();
    }
  });

  it('khởi động lại: runner mới quét lúc bootstrap bắt được việc còn tồn', async () => {
    const ids = [await seedInvoice(), await seedInvoice(), await seedInvoice('failed')];
    const db2 = createDb(DATABASE_URL!);
    const scheduler = new ManualScheduler();
    const runner = new BackgroundWorkRunner(config(), scheduler);
    try {
      runner.register(new FakeInvoiceWork('fake-invoice', db2.$client));
      runner.onApplicationBootstrap();
      await runner.idle();
      const rows = await q('SELECT id, status FROM e_invoices ORDER BY id');
      expect(rows.map((r) => Number(r['id']))).toEqual(ids);
      expect(rows.every((r) => r['status'] === 'issued')).toBe(true);
    } finally {
      await runner.beforeApplicationShutdown();
      expect(scheduler.tasks.every((t) => t.cancelled)).toBe(true);
      await db2.$client.end();
    }
  });

  it('refunds: dùng enum refund_status, chỉ lấy dòng requested đến hạn', async () => {
    const topUp = Number(
      (
        await one(
          `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,
           idempotency_key,expires_at,status)
         VALUES('GW-T32P12-R',$1,100000,100000,'idem-t32p12-r',now()+interval '15 minutes','credited') RETURNING id`,
          [creditAccountId],
        )
      )['id'],
    );
    const insert = (status: string, extra = 'NULL, NULL') =>
      one(
        `INSERT INTO refunds(top_up_id,kind,amount_vnd,status,next_attempt_at,completed_at,gateway_refund_no)
         VALUES($1,'account_closure',1000,$2,now() - interval '1 second',${extra}) RETURNING id`,
        [topUp, status],
      ).then((r) => Number(r['id']));
    const requested = await insert('requested');
    await insert('failed');
    await insert('done', "now(), 'RF-T32P12'");
    const c = await db.$client.connect();
    try {
      const rows = await inTx(c, () =>
        claimDue(c, { table: 'refunds', statuses: ['requested'], leaseMs: LEASE_MS, limit: 10 }),
      );
      expect(rows.map((r) => r.id)).toEqual([requested]);
    } finally {
      c.release();
    }
  });

  it('dừng giữa lô: shutdown chờ xong dòng đang làm, không giữ chỗ dòng kế', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedInvoice());
    const before = await Promise.all(ids.slice(1).map(invoice));
    const g = gate();
    const started = gate();
    const w = new FakeInvoiceWork('fake-invoice', db.$client, async (_row, call) => {
      if (call === 1) {
        started.open();
        await g.wait;
      }
    });
    const abort = new AbortController();
    const running = w.runDue(20, abort.signal);
    await started.wait;
    abort.abort();
    g.open();
    expect(await running).toBe(1);
    expect((await invoice(ids[0]!))['status']).toBe('issued');
    expect(await Promise.all(ids.slice(1).map(invoice))).toEqual(before);
  });

  it('handle ném ở một dòng: các dòng sau vẫn chạy; dòng lỗi giữ lease, hết lease thì được lấy lại', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedInvoice());
    let fail = true;
    const w = new FakeInvoiceWork('fake-invoice', db.$client, async (row) => {
      if (fail && row.id === ids[0]) throw new Error('provider timeout');
    });
    expect(await w.runDue(20, new AbortController().signal)).toBe(3);
    const first = await one(
      `SELECT status, next_attempt_at > now() + interval '50 seconds' AS leased
       FROM e_invoices WHERE id=$1`,
      [ids[0]],
    );
    expect(first).toEqual({ status: 'requested', leased: true });
    for (const id of ids.slice(1)) expect((await invoice(id))['status']).toBe('issued');

    // Vẫn trong lease → chưa lấy lại.
    expect(await w.runDue(20, new AbortController().signal)).toBe(0);
    // Giả lập hết lease.
    await q("UPDATE e_invoices SET next_attempt_at = now() - interval '1 second' WHERE id=$1", [
      ids[0],
    ]);
    fail = false;
    expect(await w.runDue(20, new AbortController().signal)).toBe(1);
    expect((await invoice(ids[0]!))['status']).toBe('issued');
    expect(w.calls.get(ids[0]!)).toBe(2);
  });
});
