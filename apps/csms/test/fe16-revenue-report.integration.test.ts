/**
 * T108a — revenue report service (F-16, BR-P46; contract §4): which sessions count as revenue,
 * unsettled reasons, K3 period in Vietnam time, rows = totals, Operator scope. Calls
 * `revenueReport()` straight on Postgres; the HTTP routes and CSV are in fe16-revenue-route.
 * Needs DATABASE_URL; resets its schema. Data: helpers/revenue-fixture.ts.
 */
import { createDb, type Db } from '../src/db/db.module.js';
import {
  revenueReport,
  type RevenueGroupBy,
  type RevenueParams,
} from '../src/operator-api/revenue-report.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import {
  buildRevenueFixture,
  OPERATOR_A_NOVEMBER,
  OPERATOR_B_NOVEMBER,
} from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const BUCKET_KEYS = [
  'csms_billed_session_count',
  'csms_billed_energy_wh',
  'csms_billed_revenue_vnd',
  'unattributed_session_count',
  'unattributed_energy_wh',
] as const;

describeDb('T108a revenue report (BR-P46, K2, K3, K6, K11)', () => {
  let db: Db;
  let ids: Record<string, string>;
  let fixture: Awaited<ReturnType<typeof buildRevenueFixture>>;
  const report = (p: Partial<RevenueParams>) =>
    revenueReport(db, {
      from: '2026-11-01',
      to: '2026-11-30',
      groupBy: 'charge_point',
      operatorId: null,
      siteId: null,
      ...p,
    });

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    fixture = await buildRevenueFixture(db, 'x');
    ids = fixture.ids;
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('TC-F16-01 counts only csms_billed reconciled sessions with a session_debit, once each (§4 scenario)', async () => {
    const r = await report({ operatorId: ids['opA']! });
    expect(r.totals).toEqual(OPERATOR_A_NOVEMBER);
    expect(r.pending_reconciliation).toEqual({ session_count: 1 });
    expect(r).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      group_by: 'charge_point',
      operator_id: ids['opA'],
      currency: 'VND',
    });
    expect(r.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('puts reconciled csms_billed sessions without a debit in unsettled, by settlement job reason', async () => {
    const r = await report({ operatorId: ids['opA']! });
    expect(r.unsettled).toEqual({
      session_count: 3,
      by_reason: { promotion_unsupported: 1, ineligible: 1, posted_without_debit: 1 },
    });
    expect(r.totals.csms_billed_revenue_vnd).toBe(105000);
  });

  it('does not add adjustment or top-up ledger rows to revenue (K2)', async () => {
    const before = (await report({ operatorId: ids['opA']! })).totals;
    await fixture.ledger('adjustment', -3000, ids['A.billed1']!);
    expect((await report({ operatorId: ids['opA']! })).totals).toEqual(before);
  });

  it('counts free vend as unattributed and leaves running, orphaned and failed sessions out', async () => {
    const r = await report({ operatorId: ids['opA']!, groupBy: 'site' });
    // 700 Wh unknown card + 300 Wh free vend; the failed session's 99 000 VND debit is not revenue.
    expect(r.totals.unattributed_session_count).toBe(2);
    expect(r.totals.unattributed_energy_wh).toBe(1000);
    expect(r.totals.csms_billed_revenue_vnd).toBe(105000);
    const all = await report({});
    expect(all.totals.csms_billed_session_count).toBe(
      OPERATOR_A_NOVEMBER.csms_billed_session_count + OPERATOR_B_NOVEMBER.csms_billed_session_count,
    );
  });

  it('places sessions by the K3 time in Vietnam days', async () => {
    const day = (d: string) => report({ operatorId: ids['opB']!, from: d, to: d });
    const nov30 = await day('2026-11-30');
    // b1: priced 16:59:59Z = 23:59:59 VN (received the next VN day) · b3: no priced time → cp stop.
    expect(nov30.totals.csms_billed_revenue_vnd).toBe(5000);
    expect(nov30.totals.csms_billed_session_count).toBe(2);
    expect(nov30.pending_reconciliation.session_count).toBe(0);
    const dec1 = await day('2026-12-01');
    // b2: priced 17:00:00Z = 00:00 VN 01/12 · b4 review → received_stopped_at.
    expect(dec1.totals.csms_billed_revenue_vnd).toBe(2000);
    expect(dec1.pending_reconciliation.session_count).toBe(1);
    const byDay = await report({
      operatorId: ids['opB']!,
      groupBy: 'day',
      to: '2026-12-01',
    });
    expect(byDay.rows.map((r) => [r.key, r.day, r.csms_billed_revenue_vnd])).toEqual([
      ['2026-11-10', '2026-11-10', 70000],
      ['2026-11-30', '2026-11-30', 5000],
      ['2026-12-01', '2026-12-01', 2000],
    ]);
  });

  it.each([
    ['opA', 'charge_point'],
    ['opA', 'site'],
    ['opA', 'day'],
    [null, 'operator'],
    [null, 'site'],
    [null, 'charge_point'],
    [null, 'day'],
  ] as const)('sums rows to totals (operator %s, group_by %s)', async (op, groupBy) => {
    const r = await report({
      operatorId: op ? ids[op]! : null,
      groupBy: groupBy as RevenueGroupBy,
    });
    expect(r.rows.length).toBeGreaterThan(0);
    for (const k of BUCKET_KEYS)
      expect(r.rows.reduce((sum, row) => sum + row[k], 0)).toBe(r.totals[k]);
  });

  it('fills the group fields of each row in a fixed order', async () => {
    const cps = await report({ operatorId: ids['opA']! });
    // operator name, site name, serial: "=SUM(A1)" sorts before "Trạm…"; A3's only billed session.
    expect(cps.rows.map((r) => r.serial_number)).toEqual(['FE16-A3', 'FE16-A1', 'FE16-A2']);
    expect(cps.rows[1]).toEqual({
      key: ids['cpA1'],
      operator_id: ids['opA'],
      operator_name: 'Operator A',
      site_id: ids['siteA1'],
      site_name: 'Trạm "Bến Thành", Q1',
      charge_point_id: ids['cpA1'],
      serial_number: 'FE16-A1',
      day: null,
      csms_billed_session_count: 3,
      csms_billed_energy_wh: 3000,
      csms_billed_revenue_vnd: 60000,
      unattributed_session_count: 2,
      unattributed_energy_wh: 1000,
    });
    const ops = await report({ groupBy: 'operator' });
    expect(ops.rows.map((r) => [r.key, r.operator_name, r.site_id])).toEqual([
      [ids['opA'], 'Operator A', null],
      [ids['opB'], 'Operator B', null],
    ]);
  });

  it('scopes to the Operator: no rows of B for A, and a site of B under A is an empty report', async () => {
    const a = await report({ operatorId: ids['opA']!, groupBy: 'site' });
    expect(a.rows.map((r) => r.operator_id)).toEqual([ids['opA'], ids['opA']]);
    const foreignSite = await report({ operatorId: ids['opA']!, siteId: ids['siteB1']! });
    expect(foreignSite.rows).toEqual([]);
    expect(foreignSite.totals.csms_billed_session_count).toBe(0);
    expect(foreignSite.unsettled).toEqual({ session_count: 0, by_reason: {} });
    const ownSite = await report({ operatorId: ids['opA']!, siteId: ids['siteA2']! });
    expect(ownSite.totals.csms_billed_revenue_vnd).toBe(5000);
    expect((await report({ operatorId: ids['opB']! })).totals).toEqual(OPERATOR_B_NOVEMBER);
  });

  it('returns zero totals and no rows for a period without sessions', async () => {
    const r = await report({ from: '2025-01-01', to: '2025-01-31', groupBy: 'day' });
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual({
      csms_billed_session_count: 0,
      csms_billed_energy_wh: 0,
      csms_billed_revenue_vnd: 0,
      unattributed_session_count: 0,
      unattributed_energy_wh: 0,
    });
    expect(r.pending_reconciliation).toEqual({ session_count: 0 });
    expect(r.unsettled).toEqual({ session_count: 0, by_reason: {} });
  });

  it('moves a review session resolved later into its November charging day (§4 scenario)', async () => {
    const sid = ids['A.review']!;
    await db.$client.query(
      `UPDATE sessions SET status='reconciled',priced_clock='cp',priced_ended_at='2026-11-15T03:00:00Z'
       WHERE id=$1`,
      [sid],
    );
    await fixture.ledger('session_debit', -7000, sid);
    const r = await report({ operatorId: ids['opA']! });
    expect(r.totals.csms_billed_session_count).toBe(6);
    expect(r.totals.csms_billed_revenue_vnd).toBe(112000);
    expect(r.pending_reconciliation.session_count).toBe(0);
  });
});
