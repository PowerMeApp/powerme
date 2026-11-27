/**
 * T32 Phần 10a — `BillingExceptionsQuery` (màn Billing Exceptions, chỉ đọc) trên Postgres thật.
 * Mỗi mục: đúng điều kiện lọc kể cả nhánh loại trừ, giới hạn + total, mới nhất trước. Không có mục
 * refund (hoàn tiền thủ công, WF-02 D1, D-AC / BR-P51).
 * Route + phân quyền: `admin-billing-route.integration.test.ts`. Cần DATABASE_URL; reset schema.
 */
import { BillingExceptionsQuery } from '../src/billing/billing-exceptions.query.js';
import { createDb, Db } from '../src/db/db.module.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('billing: BillingExceptionsQuery (T32 Phần 10a)', () => {
  let db: Db;
  let query: BillingExceptionsQuery;
  let seq = 0;
  let admin: number;

  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const id = async (sql: string, params: unknown[] = []) =>
    Number((await q(sql, params))[0]!['id']);

  async function newDriver() {
    seq += 1;
    const driver = await id(
      `INSERT INTO users (email, full_name, role, phone_number)
       VALUES ($1, $2, 'driver', $3) RETURNING id`,
      [`p10a-${seq}@t32.test`, `Tài xế ${seq}`, `+8490000${String(seq).padStart(4, '0')}`],
    );
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [driver],
    );
    const account = await id('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [
      driver,
    ]);
    return { driver, account };
  }

  type Made = { id: number; ref: string; driver: number };
  async function topUp(
    opts: { status?: string; late?: boolean; exception?: string; reviewed?: boolean } = {},
  ): Promise<Made> {
    const { status = 'credited', late = false, exception = null, reviewed = false } = opts;
    const owner = await newDriver();
    seq += 1;
    const ref = `P10AREF${seq}`;
    const paid = status === 'credited' || status === 'refunded';
    const topUpId = await id(
      `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
         status, gateway_transaction_no, idempotency_key, expires_at, created_at, completed_at,
         refunded_at, late_gateway_ref, late_paid_at, late_amount_vnd, exception_kind,
         exception_reviewed_at)
       VALUES ($1, $2, 100000, 100000, $3::top_up_status, $4, $5, now() + interval '15 minutes',
         now() - interval '1 hour', now() - interval '50 minutes',
         CASE WHEN $3 = 'refunded' THEN now() END,
         $6, CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() - interval '40 minutes' END,
         CASE WHEN $6::varchar IS NULL THEN NULL ELSE 60000 END,
         $7::top_up_exception_kind, CASE WHEN $8 THEN now() END)
       RETURNING id`,
      [
        ref,
        owner.account,
        status,
        paid ? String(80_000_000 + seq) : null,
        `p10a-key-${seq}`,
        late ? String(85_000_000 + seq) : null,
        exception,
        reviewed,
      ],
    );
    return { id: topUpId, ref, driver: owner.driver };
  }

  async function refund(topUpId: number, kind: string, status: string): Promise<number> {
    return id(
      `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, requested_by, next_attempt_at,
         completed_at, confirmed_via_query, attempt_count, last_error_kind, last_error_message,
         last_attempt_at, failure_reason)
       VALUES ($1, $2::refund_kind, 50000, $3::refund_status,
         CASE WHEN $2 = 'account_closure' THEN NULL ELSE $4::bigint END,
         CASE WHEN $3 = 'requested' THEN now() END,
         CASE WHEN $3 = 'done' THEN now() END, $3 = 'done',
         CASE WHEN $3 = 'failed' THEN 4 ELSE 0 END,
         CASE WHEN $3 = 'failed' THEN 'transient'::e_invoice_error_kind END,
         CASE WHEN $3 = 'failed' THEN 'retry_exhausted' END,
         CASE WHEN $3 = 'failed' THEN now() END,
         CASE WHEN $3 = 'failed' THEN 'cổng từ chối' END)
       RETURNING id`,
      [topUpId, kind, status, admin],
    );
  }

  async function invoice(topUpId: number, status: string): Promise<number> {
    const err = status === 'needs_review';
    return id(
      `INSERT INTO e_invoices (top_up_id, status, amount_vnd, vat_rate, vat_amount_vnd,
         attempt_count, last_error_kind, last_error_message, last_attempt_at, next_attempt_at,
         invoice_no, issued_at)
       VALUES ($1, $2::e_invoice_status, 100000, 8, 7407, $3,
         CASE WHEN $4 THEN 'data'::e_invoice_error_kind END,
         CASE WHEN $4 THEN 'mst_sai' END, CASE WHEN $4 THEN now() END,
         CASE WHEN $2 IN ('requested','failed') THEN now() END,
         CASE WHEN $2 = 'issued' THEN $5 END, CASE WHEN $2 = 'issued' THEN now() END)
       RETURNING id`,
      [topUpId, status, err ? 1 : 0, err, `INV${seq}`],
    );
  }

  async function conflict(topUpId: number, reviewed: boolean): Promise<number> {
    seq += 1;
    return id(
      `INSERT INTO top_up_payment_conflicts (top_up_id, gateway_transaction_no, amount_vnd, paid_at,
         source, reason, reviewed_at, reviewed_by, review_note)
       VALUES ($1, $2, 70000, now(), 'ipn', 'extra_payment',
         CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN $4::bigint END,
         CASE WHEN $3 THEN 'đã hoàn tay' END)
       RETURNING id`,
      [topUpId, String(88_000_000 + seq), reviewed, admin],
    );
  }

  const ids = (items: object[], key: string) =>
    items.map((i) => Number((i as Record<string, unknown>)[key]));

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    query = new BillingExceptionsQuery(db);
    admin = await id(
      `INSERT INTO users (email, full_name, role) VALUES ('p10a-admin@t32.test','A','admin')
       RETURNING id`,
    );
    await q('INSERT INTO admins (user_id) VALUES ($1)', [admin]);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('bốn mục, không có failed_refunds: refund failed (mọi kind) không thành mục riêng', async () => {
    const a = await topUp({ status: 'refunded' });
    await refund(a.id, 'top_up', 'failed');
    const c = await topUp({ status: 'refunded' });
    await refund(c.id, 'account_closure', 'failed');
    const r = await query.list();
    expect(Object.keys(r).sort()).toEqual(
      [
        'generated_at',
        'limit',
        'late_payments',
        'invoices_needs_review',
        'top_up_exceptions',
        'payment_conflicts',
      ].sort(),
    );
    expect(r).not.toHaveProperty('failed_refunds');
  });

  it('late_payments: chưa có refund late_payment (kể cả refund đó failed thì không hiện); mọi status', async () => {
    const onFailed = await topUp({ status: 'failed', late: true });
    const onCredited = await topUp({ status: 'credited', late: true });
    const onRefunded = await topUp({ status: 'refunded', late: true });
    const onExpired = await topUp({ status: 'expired', late: true });
    const withFailedRefund = await topUp({ status: 'failed', late: true });
    await refund(withFailedRefund.id, 'late_payment', 'failed');
    const withDone = await topUp({ status: 'expired', late: true });
    await refund(withDone.id, 'late_payment', 'done');
    const noLate = await topUp({ status: 'credited' });
    // Refund top_up không chặn khoản trễ.
    const lateAndTopUpRefund = await topUp({ status: 'refunded', late: true });
    await refund(lateAndTopUpRefund.id, 'top_up', 'done');

    const r = await query.list();
    const got = ids(r.late_payments.items, 'top_up_id');
    expect(got).toEqual(
      expect.arrayContaining([
        onFailed.id,
        onCredited.id,
        onRefunded.id,
        onExpired.id,
        lateAndTopUpRefund.id,
      ]),
    );
    for (const out of [withFailedRefund, withDone, noLate]) expect(got).not.toContain(out.id);
    expect(r.late_payments.items.find((i) => Number(i.top_up_id) === onFailed.id)).toMatchObject({
      gateway_reference: onFailed.ref,
      status: 'failed',
      late_amount_vnd: 60000,
      late_gateway_ref: expect.any(String),
      late_paid_at: expect.any(String),
      driver: { driver_id: String(onFailed.driver) },
    });
  });

  it('invoices_needs_review: chỉ needs_review, kèm lỗi và attempt_count', async () => {
    const a = await topUp();
    const nr = await invoice(a.id, 'needs_review');
    const b = await topUp();
    const issued = await invoice(b.id, 'issued');
    const c = await topUp();
    const req = await invoice(c.id, 'requested');

    const r = await query.list();
    const got = ids(r.invoices_needs_review.items, 'e_invoice_id');
    expect(got).toContain(nr);
    expect(got).not.toContain(issued);
    expect(got).not.toContain(req);
    expect(r.invoices_needs_review.items.find((i) => Number(i.e_invoice_id) === nr)).toMatchObject({
      top_up_id: String(a.id),
      amount_vnd: 100000,
      attempt_count: 1,
      last_error_kind: 'data',
      last_error_message: 'mst_sai',
      driver: { driver_id: String(a.driver) },
    });
  });

  it('top_up_exceptions: có exception_kind và chưa xem; đã xem không hiện', async () => {
    const loyalty = await topUp({ status: 'credited', exception: 'loyalty_error' });
    const u04 = await topUp({ status: 'expired', exception: 'unresolved_04' });
    const u07 = await topUp({ status: 'expired', exception: 'unresolved_07' });
    const exhausted = await topUp({ status: 'expired', exception: 'retry_exhausted' });
    const reviewed = await topUp({
      status: 'expired',
      exception: 'unresolved_04',
      reviewed: true,
    });
    const none = await topUp({ status: 'expired' });

    const r = await query.list();
    const got = ids(r.top_up_exceptions.items, 'top_up_id');
    expect(got).toEqual(expect.arrayContaining([loyalty.id, u04.id, u07.id, exhausted.id]));
    expect(got).not.toContain(reviewed.id);
    expect(got).not.toContain(none.id);
    expect(r.top_up_exceptions.items.find((i) => Number(i.top_up_id) === u07.id)).toMatchObject({
      gateway_reference: u07.ref,
      status: 'expired',
      exception_kind: 'unresolved_07',
      amount_paid_vnd: 100000,
    });
  });

  it('payment_conflicts: chưa review; đã review không hiện', async () => {
    const t = await topUp({ status: 'expired', late: true });
    const open = await conflict(t.id, false);
    const done = await conflict(t.id, true);
    const r = await query.list();
    const got = ids(r.payment_conflicts.items, 'conflict_id');
    expect(got).toContain(open);
    expect(got).not.toContain(done);
    expect(r.payment_conflicts.items.find((i) => Number(i.conflict_id) === open)).toMatchObject({
      top_up_id: String(t.id),
      gateway_reference: t.ref,
      amount_vnd: 70000,
      source: 'ipn',
      reason: 'extra_payment',
    });
  });

  it('giới hạn mỗi mục + total là tổng thật của mục; mặc định 200', async () => {
    const counts = Object.fromEntries(
      (
        await q(
          `SELECT
             (SELECT count(*)::int FROM top_ups t WHERE late_gateway_ref IS NOT NULL AND NOT EXISTS
                (SELECT 1 FROM refunds f WHERE f.top_up_id=t.id AND f.kind='late_payment')) AS late_payments,
             (SELECT count(*)::int FROM e_invoices WHERE status='needs_review') AS invoices_needs_review,
             (SELECT count(*)::int FROM top_ups WHERE exception_kind IS NOT NULL
                AND exception_reviewed_at IS NULL) AS top_up_exceptions,
             (SELECT count(*)::int FROM top_up_payment_conflicts WHERE reviewed_at IS NULL)
                AS payment_conflicts`,
        )
      ).map((row) => Object.entries(row))[0]!,
    ) as Record<string, number>;
    expect(counts['late_payments']).toBeGreaterThan(2);
    const small = await query.list(2);
    expect(small.limit).toBe(2);
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      const section = small[key as 'late_payments'];
      expect(section.total).toBe(counts[key]);
      expect(section.items.length).toBe(Math.min(2, counts[key]!));
    }
    const all = await query.list();
    expect(all.limit).toBe(200);
    expect(all.late_payments.items).toHaveLength(counts['late_payments']!);
    expect(typeof all.generated_at).toBe('string');
  });
});
