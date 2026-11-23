/**
 * Data for the T108a revenue tests (fe16-*), built with SQL like fe03 / fe04. Operator A: two sites
 * (one name with comma, quotes and Vietnamese; one `=SUM(A1)` for CSV injection), three charge
 * points; Operator B: one charge point. Users: one admin, staff A, staff B, staff A2 (suspended by
 * the route test after login). One driver with Charging Credit pays every debit.
 *
 * November 2026 (Vietnam time), Operator A:
 *   csms_billed 5 (4 app + 1 online card), 105 000 VND, 5 500 Wh — job `posted`
 *   unattributed 2 (unknown card closed 700 Wh, free vend reconciled 300 Wh)
 *   pending_reconciliation 1 (app `review`, `A.review`)
 *   unsettled 3: job pending promotion_unsupported, no job (ineligible), job posted w/o debit
 *   in no bucket: active, orphaned, failed
 *   + an `adjustment` on a billed session and a `top_up` of the same driver (not revenue)
 * Operator B, around the day boundary (Vietnam = UTC+7):
 *   10/11 app 70 000 VND 3 000 Wh; unattributed closed 400 Wh
 *   b1 priced 30/11 16:59:59Z (23:59:59 VN), received 17:05Z (01/12 VN) → 30/11, 1 000 VND
 *   b2 priced 30/11 17:00:00Z (00:00 VN 01/12) → 01/12, 2 000 VND
 *   b3 no priced time, cp stop 16:30Z (30/11 VN), received 17:30Z (01/12 VN) → 30/11, 4 000 VND
 *   b4 `review`, cp stop 16:30Z, received 17:30Z → pending on 01/12
 * T108b additions (no T108a number changes): promotion `FE16-KM10` on the promotion_unsupported
 * session, `delivered_offline` on one billed session, every session id in `ids`, and Operator A
 * October: billed 8 000 VND with no CSMS stop and no meter reading (energy_wh null), billed
 * 6 000 VND 1 200 Wh, and a closed session without CSMS stop (in no period).
 */
import type { Db } from '../../src/db/db.module.js';

export const OPERATOR_A_NOVEMBER = {
  csms_billed_session_count: 5,
  csms_billed_energy_wh: 5500,
  csms_billed_revenue_vnd: 105000,
  unattributed_session_count: 2,
  unattributed_energy_wh: 1000,
};
export const OPERATOR_B_NOVEMBER = {
  csms_billed_session_count: 3,
  csms_billed_energy_wh: 3300,
  csms_billed_revenue_vnd: 75000,
  unattributed_session_count: 1,
  unattributed_energy_wh: 400,
};
export const SITE_A1_NAME = 'Trạm "Bến Thành", Q1';
export const SITE_A2_NAME = '=SUM(A1)';

export interface SessionSpec {
  cp: string;
  status: string;
  mode?: 'csms_billed' | 'unattributed';
  origin?: 'app_qr' | 'rfid' | 'free_vend';
  energy?: number;
  pricedEndedAt?: string | null;
  cpStop?: string | null;
  receivedStop?: string | null;
  /** VND taken by the `session_debit` row; absent = no debit. */
  debit?: number;
  /** Settlement job after insert: the 0005 trigger creates `pending stop_observed`. */
  job?: { state: 'pending' | 'posted' | 'ineligible'; reason: string } | 'none';
  /** T108b: `sessions.promotion_id` (ids key). */
  promotion?: string;
  deliveredOffline?: boolean;
  /** cp / CSMS start time; default 2026-11-01T00:00:00Z. */
  startedAt?: string;
}

/** T108b: Operator A, October 2026 — one billed session without meter reading or CSMS stop time. */
export const OPERATOR_A_OCTOBER = {
  csms_billed_session_count: 2,
  csms_billed_energy_wh: 1200,
  csms_billed_revenue_vnd: 14000,
  unattributed_session_count: 0,
  unattributed_energy_wh: 0,
};
export const PROMOTION_CODE = 'FE16-KM10';

export async function buildRevenueFixture(db: Db, passwordHash: string) {
  const ids: Record<string, string> = {};
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[]) => String((await q(sql, params))[0].id);

  for (const op of ['A', 'B'] as const)
    ids[`op${op}`] = await one(
      'INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id',
      [`031000000${op === 'A' ? 1 : 2}`, `Operator ${op}`],
    );
  for (const [key, op, name] of [
    ['siteA1', 'A', SITE_A1_NAME],
    ['siteA2', 'A', SITE_A2_NAME],
    ['siteB1', 'B', 'Trạm B'],
  ] as const)
    ids[key] = await one(
      `INSERT INTO sites(site_code,operator_id,site_name,address,latitude,longitude)
       VALUES($1,$2,$3,'x',10.7,106.7) RETURNING id`,
      [`FE16-${key}`, ids[`op${op}`], name],
    );
  for (const [key, site] of [
    ['A1', 'siteA1'],
    ['A2', 'siteA1'],
    ['A3', 'siteA2'],
    ['B1', 'siteB1'],
  ] as const) {
    ids[`cp${key}`] = await one(
      `INSERT INTO charge_points(serial_number,site_id,lifecycle) VALUES($1,$2,'in_service') RETURNING id`,
      [`FE16-${key}`, ids[site]],
    );
    ids[`conn${key}`] = await one(
      `INSERT INTO connectors(charge_point_id,connector_no,connector_type,max_power_kw)
       VALUES($1,1,'ccs2',60) RETURNING id`,
      [ids[`cp${key}`]],
    );
  }
  async function user(key: string, email: string, role: string) {
    ids[key] = await one(
      `INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id`,
      [email, `User ${key}`, role, passwordHash],
    );
  }
  await user('admin', 'admin@fe16.test', 'admin');
  await q('INSERT INTO admins(user_id) VALUES($1)', [ids['admin']]);
  for (const [key, op] of [
    ['staffA', 'A'],
    ['staffB', 'B'],
    ['staffA2', 'A'],
  ] as const) {
    await user(key, `${key.toLowerCase()}@fe16.test`, 'operator_staff');
    await q("INSERT INTO operator_staff(user_id,operator_id,staff_role) VALUES($1,$2,'manager')", [
      ids[key],
      ids[`op${op}`],
    ]);
  }
  await user('driver', 'driver@fe16.test', 'driver');
  await q("INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t',now())", [
    ids['driver'],
  ]);
  ids['account'] = await one(
    'INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,1000000) RETURNING id',
    [ids['driver']],
  );

  let seq = 0;
  let entry = 0;
  const ledger = (type: string, amount: number, sessionId: string | null, topUp?: string) =>
    q(
      `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,
         balance_after_vnd,session_id,top_up_id) VALUES($1,$2,$3,$4,0,$5,$6)`,
      [ids['account'], ++entry, type, amount, sessionId, topUp ?? null],
    );

  async function session(s: SessionSpec): Promise<string> {
    seq += 1;
    const mode = s.mode ?? 'csms_billed';
    const stop = s.receivedStop === undefined ? '2026-11-10T03:00:00Z' : s.receivedStop;
    const cpStop = s.cpStop === undefined ? stop : s.cpStop;
    const priced =
      s.pricedEndedAt === undefined ? (s.debit !== undefined ? stop : null) : s.pricedEndedAt;
    const energy = s.energy ?? 1000;
    const id = await one(
      `INSERT INTO sessions(charge_point_id,connector_id,connector_no,id_tag,driver_id,origin,
         payment_mode,status,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,
         meter_start_wh,meter_stop_wh,energy_wh,priced_clock,priced_ended_at,promotion_id,
         delivered_offline)
       VALUES($1,$2,1,$3,$4,$5,$6,$7,$14,$14,$8,$9,
         0,$10,$10,CASE WHEN $11::timestamptz IS NULL THEN NULL ELSE 'cp' END,$11,$12,$13)
       RETURNING id`,
      [
        ids[`cp${s.cp}`],
        ids[`conn${s.cp}`],
        `FE16-${seq}`,
        mode === 'csms_billed' ? ids['driver'] : null,
        s.origin ?? (mode === 'csms_billed' ? 'app_qr' : 'rfid'),
        mode,
        s.status,
        cpStop,
        stop,
        stop === null ? null : energy,
        priced,
        s.promotion ? ids[s.promotion] : null,
        s.deliveredOffline ?? false,
        s.startedAt ?? '2026-11-01T00:00:00Z',
      ],
    );
    if (s.debit !== undefined) await ledger('session_debit', -s.debit, id);
    const job = s.job ?? (s.debit !== undefined ? { state: 'posted', reason: 'posted' } : null);
    if (job === 'none') await q('DELETE FROM charge_settlement_jobs WHERE session_id=$1', [id]);
    else if (job)
      await q('UPDATE charge_settlement_jobs SET state=$2,reason=$3 WHERE session_id=$1', [
        id,
        job.state,
        job.reason,
      ]);
    return id;
  }

  // T108b: a promotion of Operator A, on the session held as `promotion_unsupported` (K6).
  ids['promo'] = await one(
    `INSERT INTO promotions(promotion_code,operator_id,discount_type,discount_value,valid_from,valid_to)
     VALUES($1,$2,'percent',10,'2026-10-01T00:00:00Z','2027-01-01T00:00:00Z') RETURNING id`,
    [PROMOTION_CODE, ids['opA']],
  );

  // ---- Operator A, November ------------------------------------------------------------------
  ids['A.billed1'] = await session({ cp: 'A1', status: 'reconciled', debit: 10000 });
  ids['A.billed2'] = await session({ cp: 'A1', status: 'reconciled', debit: 20000 });
  ids['A.billed3'] = await session({ cp: 'A1', status: 'reconciled', debit: 30000 });
  ids['A.billed4'] = await session({
    cp: 'A2',
    status: 'reconciled',
    debit: 40000,
    energy: 2000,
    deliveredOffline: true,
  });
  ids['A.billedCard'] = await session({
    cp: 'A3',
    status: 'reconciled',
    origin: 'rfid',
    debit: 5000,
    energy: 500,
  });
  ids['A.unknownCard'] = await session({
    cp: 'A1',
    status: 'closed',
    mode: 'unattributed',
    energy: 700,
  });
  ids['A.free'] = await session({
    cp: 'A1',
    status: 'reconciled',
    mode: 'unattributed',
    origin: 'free_vend',
    energy: 300,
  });
  ids['A.review'] = await session({
    cp: 'A2',
    status: 'review',
    receivedStop: '2026-11-15T03:00:00Z',
  });
  ids['A.promo'] = await session({
    cp: 'A3',
    status: 'reconciled',
    job: { state: 'pending', reason: 'promotion_unsupported' },
    promotion: 'promo',
  });
  ids['A.ineligible'] = await session({
    cp: 'A3',
    status: 'reconciled',
    origin: 'rfid',
    job: 'none',
  });
  ids['A.postedNoDebit'] = await session({
    cp: 'A3',
    status: 'reconciled',
    job: { state: 'posted', reason: 'posted' },
  });
  ids['A.active'] = await session({ cp: 'A1', status: 'active', receivedStop: null, cpStop: null });
  ids['A.orphaned'] = await session({ cp: 'A1', status: 'orphaned' });
  ids['A.failed'] = await session({ cp: 'A1', status: 'failed', debit: 99000 });
  // Not revenue: an adjustment tied to a billed session and a top-up of the same driver.
  await ledger('adjustment', 5000, ids['A.billed1']);
  const topUp = await one(
    `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,
       idempotency_key,expires_at) VALUES('FE16-GW-1',$1,100000,100000,'fe16-idem-1',now()+interval '15 minutes')
     RETURNING id`,
    [ids['account']],
  );
  await ledger('top_up', 100000, null, topUp);

  // ---- Operator B ----------------------------------------------------------------------------
  ids['B.billed'] = await session({ cp: 'B1', status: 'reconciled', debit: 70000, energy: 3000 });
  ids['B.unknownCard'] = await session({
    cp: 'B1',
    status: 'closed',
    mode: 'unattributed',
    energy: 400,
  });
  ids['B.b1'] = await session({
    cp: 'B1',
    status: 'reconciled',
    debit: 1000,
    energy: 100,
    pricedEndedAt: '2026-11-30T16:59:59Z',
    receivedStop: '2026-11-30T17:05:00Z',
  });
  ids['B.b2'] = await session({
    cp: 'B1',
    status: 'reconciled',
    debit: 2000,
    energy: 100,
    pricedEndedAt: '2026-11-30T17:00:00Z',
    receivedStop: '2026-11-30T17:00:00Z',
  });
  ids['B.b3'] = await session({
    cp: 'B1',
    status: 'reconciled',
    debit: 4000,
    energy: 200,
    pricedEndedAt: null,
    cpStop: '2026-11-30T16:30:00Z',
    receivedStop: '2026-11-30T17:30:00Z',
  });
  ids['B.b4'] = await session({
    cp: 'B1',
    status: 'review',
    cpStop: '2026-11-30T16:30:00Z',
    receivedStop: '2026-11-30T17:30:00Z',
  });

  // ---- T108b: Operator A, October (no T108a test reads October) -------------------------------
  // Reconciled and billed, but no CSMS stop time and no meter reading: in the period through
  // priced_ended_at (K3), energy_wh null (not 0 Wh).
  ids['A.oct.nullEnergy'] = await session({
    cp: 'A1',
    status: 'reconciled',
    debit: 8000,
    startedAt: '2026-10-15T01:00:00Z',
    receivedStop: null,
    cpStop: null,
    pricedEndedAt: '2026-10-15T03:00:00Z',
  });
  ids['A.oct.billed'] = await session({
    cp: 'A2',
    status: 'reconciled',
    debit: 6000,
    energy: 1200,
    startedAt: '2026-10-20T01:00:00Z',
    receivedStop: '2026-10-20T03:00:00Z',
  });
  // closed without a CSMS stop time: in no period at all.
  ids['A.oct.closedNoStop'] = await session({
    cp: 'A1',
    status: 'closed',
    mode: 'unattributed',
    startedAt: '2026-10-21T01:00:00Z',
    receivedStop: null,
    cpStop: '2026-10-21T03:00:00Z',
  });
  return { ids, session, ledger };
}
