/**
 * T108b — Admin transaction list service (UC-ADM-10, BR-P46; contract §4.1): one row per stopped
 * session, the same four kinds and period as the revenue report, totals of the whole filtered set
 * equal to `revenueReport()`, filters, paging and order, the 24 columns, null meter readings, and the
 * CSV row cap (K10). Calls the service straight on Postgres; HTTP and CSV are in
 * fe16-transactions-route. Needs DATABASE_URL; resets its schema. Data: helpers/revenue-fixture.ts.
 */
import { createDb, type Db } from '../src/db/db.module.js';
import {
  exportTransactions,
  listTransactions,
  type TransactionFilter,
  type TransactionRow,
} from '../src/operator-api/admin-transactions.js';
import { revenueReport } from '../src/operator-api/revenue-report.js';
import { AuthError } from '../src/users/auth.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';
import {
  buildRevenueFixture,
  OPERATOR_A_NOVEMBER,
  OPERATOR_A_OCTOBER,
  PROMOTION_CODE,
  SITE_A1_NAME,
} from './helpers/revenue-fixture.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const ZERO = {
  csms_billed_session_count: 0,
  csms_billed_energy_wh: 0,
  csms_billed_revenue_vnd: 0,
  unattributed_session_count: 0,
  unattributed_energy_wh: 0,
};

describeDb('T108b admin transactions (UC-ADM-10, BR-P46, K7–K12)', () => {
  let db: Db;
  let ids: Record<string, string>;
  const filter = (p: Partial<TransactionFilter> = {}): TransactionFilter => ({
    from: '2026-11-01',
    to: '2026-11-30',
    operatorId: null,
    siteId: null,
    chargePointId: null,
    kind: null,
    origin: null,
    ...p,
  });
  const list = (p: Partial<TransactionFilter> = {}, page = 1, pageSize = 100) =>
    listTransactions(db, filter(p), page, pageSize);
  const byId = (items: TransactionRow[]) => new Map(items.map((r) => [r.session_id, r]));

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await resetAndMigrate(db.$client);
    ids = (await buildRevenueFixture(db, 'x')).ids;
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('totals, pending and unsettled equal revenueReport() without extra filters (§4.1)', async () => {
    for (const operatorId of [ids['opA']!, ids['opB']!, null]) {
      const t = await list({ operatorId });
      const r = await revenueReport(db, {
        from: '2026-11-01',
        to: '2026-11-30',
        groupBy: 'day',
        operatorId,
        siteId: null,
      });
      expect(t.totals).toEqual(r.totals);
      expect(t.pending_reconciliation).toEqual(r.pending_reconciliation);
      expect(t.unsettled).toEqual(r.unsettled);
      const billed = t.items.filter((i) => i.kind === 'csms_billed');
      expect(billed.every((i) => i.amount_vnd !== null)).toBe(true);
      expect(billed).toHaveLength(t.totals.csms_billed_session_count);
      expect(billed.reduce((s, i) => s + i.amount_vnd!, 0)).toBe(t.totals.csms_billed_revenue_vnd);
      expect(t.total).toBe(t.items.length);
    }
    const a = await list({ operatorId: ids['opA']! });
    // Fixed numbers too: a change to the shared KIND_SQL moves both sides of the equality above.
    expect(a.totals).toEqual(OPERATOR_A_NOVEMBER);
    // 5 csms_billed + 3 unsettled + 1 pending + 2 unattributed
    expect(a.total).toBe(11);
    expect(a).toMatchObject({ from: '2026-11-01', to: '2026-11-30', currency: 'VND' });
    expect(Date.parse(a.generated_at)).not.toBeNaN();
  });

  it('kind: four values, unsettled reasons, free vend unattributed, no running/orphaned/failed', async () => {
    const { items } = await list({ operatorId: ids['opA']! });
    const rows = byId(items);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(['csms_billed', 'unsettled', 'pending_reconciliation', 'unattributed']),
    );
    for (const [key, reason] of [
      ['A.promo', 'promotion_unsupported'],
      ['A.ineligible', 'ineligible'],
      ['A.postedNoDebit', 'posted_without_debit'],
    ] as const)
      expect(rows.get(ids[key]!)).toMatchObject({
        kind: 'unsettled',
        unsettled_reason: reason,
        amount_vnd: null,
      });
    expect(rows.get(ids['A.free']!)).toMatchObject({
      kind: 'unattributed',
      origin: 'free_vend',
      amount_vnd: null,
      unsettled_reason: null,
    });
    expect(rows.get(ids['A.review']!)).toMatchObject({
      kind: 'pending_reconciliation',
      amount_vnd: null,
      unsettled_reason: null,
    });
    for (const key of ['A.active', 'A.orphaned', 'A.failed'])
      expect(rows.has(ids[key]!)).toBe(false);
    expect(
      items.filter((i) => i.unsettled_reason !== null).every((i) => i.kind === 'unsettled'),
    ).toBe(true);
  });

  it('each filter narrows the set and the sums follow the filtered set', async () => {
    const all = (await list({ operatorId: ids['opA']! })).items;
    const cases: [Partial<TransactionFilter>, (r: TransactionRow) => boolean][] = [
      [{ kind: 'unsettled' }, (r) => r.kind === 'unsettled'],
      [{ kind: 'csms_billed' }, (r) => r.kind === 'csms_billed'],
      [{ origin: 'rfid' }, (r) => r.origin === 'rfid'],
      [{ origin: 'free_vend' }, (r) => r.origin === 'free_vend'],
      [{ siteId: ids['siteA2']! }, (r) => r.site_id === ids['siteA2']],
      [{ chargePointId: ids['cpA2']! }, (r) => r.charge_point_id === ids['cpA2']],
    ];
    for (const [f, keep] of cases) {
      const t = await list({ operatorId: ids['opA']!, ...f });
      const expected = all.filter(keep);
      expect(expected.length).toBeGreaterThan(0);
      expect(t.items).toEqual(expected);
      expect(t.total).toBe(expected.length);
      const billed = expected.filter((r) => r.kind === 'csms_billed');
      expect(t.totals.csms_billed_session_count).toBe(billed.length);
      expect(t.totals.csms_billed_revenue_vnd).toBe(billed.reduce((s, r) => s + r.amount_vnd!, 0));
      expect(t.unsettled.session_count).toBe(expected.filter((r) => r.kind === 'unsettled').length);
    }
    const unsettled = await list({ operatorId: ids['opA']!, kind: 'unsettled' });
    expect(unsettled.totals).toEqual(ZERO);
    expect(unsettled.pending_reconciliation).toEqual({ session_count: 0 });
    expect(unsettled.unsettled.by_reason).toEqual({
      promotion_unsupported: 1,
      ineligible: 1,
      posted_without_debit: 1,
    });

    // operator_id alone: only that Operator's sessions.
    const b = await list({ operatorId: ids['opB']! });
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.items.every((r) => r.operator_id === ids['opB'])).toBe(true);
    expect(b.items.some((r) => all.some((a) => a.session_id === r.session_id))).toBe(false);

    // A site of another Operator than the filtered one: empty, not an error (§2.3).
    for (const f of [{ siteId: ids['siteA1']! }, { chargePointId: ids['cpA1']! }]) {
      const empty = await list({ operatorId: ids['opB']!, ...f });
      expect(empty).toMatchObject({ items: [], total: 0, totals: ZERO });
      expect(empty.unsettled).toEqual({ session_count: 0, by_reason: {} });
    }
  });

  it('paging: page_size 2 walks every row once in period_at DESC, session_id DESC order', async () => {
    const full = await list();
    expect(full.total).toBe(15);
    const sorted = [...full.items].sort(
      (x, y) =>
        Date.parse(y.period_at) - Date.parse(x.period_at) ||
        Number(BigInt(y.session_id) - BigInt(x.session_id)),
    );
    expect(full.items).toEqual(sorted);

    const walked: TransactionRow[] = [];
    for (let page = 1; page <= 8; page++) {
      const p = await list({}, page, 2);
      expect(p).toMatchObject({ page, page_size: 2, total: 15 });
      expect(p.totals).toEqual(full.totals);
      expect(p.unsettled).toEqual(full.unsettled);
      walked.push(...p.items);
    }
    expect(walked).toEqual(full.items);
    expect(new Set(walked.map((r) => r.session_id)).size).toBe(15);

    const past = await list({}, 9, 2);
    expect(past.items).toEqual([]);
    expect(past.total).toBe(15);
    expect(past.totals).toEqual(full.totals);
    expect(past.pending_reconciliation).toEqual(full.pending_reconciliation);
    expect(past.unsettled).toEqual(full.unsettled);
  });

  it('a csms_billed row has the 24 columns from the right sources (K8, K12)', async () => {
    const { items } = await list({ operatorId: ids['opA']! });
    const rows = byId(items);
    const { rows: db1 } = await db.$client.query<{ transaction_no: number }>(
      'SELECT transaction_no FROM sessions WHERE id=$1',
      [ids['A.billed4']],
    );
    const row = rows.get(ids['A.billed4']!)!;
    expect(Object.keys(row)).toHaveLength(24);
    expect(row).toEqual({
      session_id: ids['A.billed4'],
      transaction_no: db1[0]!.transaction_no,
      kind: 'csms_billed',
      session_status: 'reconciled',
      payment_mode: 'csms_billed',
      origin: 'app_qr',
      operator_id: ids['opA'],
      operator_name: 'Operator A',
      site_id: ids['siteA1'],
      site_code: 'FE16-siteA1',
      site_name: SITE_A1_NAME,
      charge_point_id: ids['cpA2'],
      serial_number: 'FE16-A2',
      connector_no: 1,
      started_at: '2026-11-01T00:00:00.000Z',
      stopped_at: '2026-11-10T03:00:00.000Z',
      period_at: '2026-11-10T03:00:00.000Z',
      period_day: '2026-11-10',
      energy_wh: 2000,
      amount_vnd: 40000,
      unsettled_reason: null,
      driver_id: ids['driver'],
      promotion_code: null,
      delivered_offline: true,
    });
    expect(rows.get(ids['A.promo']!)!.promotion_code).toBe(PROMOTION_CODE);
    expect(rows.get(ids['A.unknownCard']!)).toMatchObject({
      kind: 'unattributed',
      driver_id: null,
      payment_mode: 'unattributed',
      session_status: 'closed',
    });
  });

  it('period_day follows the Vietnam day of period_at around 30/11 – 01/12 (Operator B)', async () => {
    const day = async (d: string) =>
      byId((await list({ operatorId: ids['opB']!, from: d, to: d })).items);
    const nov30 = await day('2026-11-30');
    const dec1 = await day('2026-12-01');
    expect([...nov30.keys()].sort()).toEqual([ids['B.b1']!, ids['B.b3']!].sort());
    expect(nov30.get(ids['B.b1']!)).toMatchObject({
      period_at: '2026-11-30T16:59:59.000Z',
      stopped_at: '2026-11-30T17:05:00.000Z',
      period_day: '2026-11-30',
    });
    expect(nov30.get(ids['B.b3']!)).toMatchObject({
      period_at: '2026-11-30T16:30:00.000Z',
      period_day: '2026-11-30',
    });
    expect([...dec1.keys()].sort()).toEqual([ids['B.b2']!, ids['B.b4']!].sort());
    expect(dec1.get(ids['B.b2']!)).toMatchObject({ period_day: '2026-12-01', kind: 'csms_billed' });
    // `review`: period by received_stopped_at (17:30Z = 00:30 VN 01/12), not cp stop.
    expect(dec1.get(ids['B.b4']!)).toMatchObject({
      period_at: '2026-11-30T17:30:00.000Z',
      period_day: '2026-12-01',
      kind: 'pending_reconciliation',
    });
  });

  it('null meter reading / CSMS stop: in the period through priced_ended_at, sums skip null (§4.1)', async () => {
    const oct = { operatorId: ids['opA']!, from: '2026-10-01', to: '2026-10-31' };
    const t = await list(oct);
    const rows = byId(t.items);
    expect(rows.get(ids['A.oct.nullEnergy']!)).toMatchObject({
      kind: 'csms_billed',
      energy_wh: null,
      stopped_at: null,
      amount_vnd: 8000,
      period_at: '2026-10-15T03:00:00.000Z',
      period_day: '2026-10-15',
    });
    expect(rows.has(ids['A.oct.closedNoStop']!)).toBe(false);
    expect(t.total).toBe(2);
    expect(t.totals).toEqual(OPERATOR_A_OCTOBER);
    const r = await revenueReport(db, {
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'day',
      operatorId: ids['opA']!,
      siteId: null,
    });
    expect(t.totals).toEqual(r.totals);
    expect(t.pending_reconciliation).toEqual({ session_count: 0 });
    const e = await exportTransactions(db, filter(oct));
    expect(e.all_energy_wh).toBe(1200);
  });

  it('export: every row of the list; over the cap → export_too_large, nothing returned (K10)', async () => {
    const full = await list();
    const all = await exportTransactions(db, filter());
    expect(all.items).toEqual(full.items);
    expect(all.totals).toEqual(full.totals);
    expect(all.all_energy_wh).toBe(full.items.reduce((s, r) => s + (r.energy_wh ?? 0), 0));

    // Operator B, November: 3 csms_billed + 1 unattributed.
    const b = { operatorId: ids['opB']! };
    const atCap = await exportTransactions(db, filter({ ...b, kind: 'csms_billed' }), 3);
    expect(atCap.items).toHaveLength(3);
    expect(atCap.total).toBe(3);
    const over = exportTransactions(db, filter(b), 3);
    await expect(over).rejects.toBeInstanceOf(AuthError);
    await expect(over).rejects.toMatchObject({ status: 400, code: 'export_too_large' });
  });
});
