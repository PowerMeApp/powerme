// WP3/T148: recovery changes only the durable queue; financial evidence must remain byte-for-byte stable.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, type Db } from '../src/db/db.module.js';
import { CreditLedgerService } from '../src/billing/credit-ledger.service.js';
import { LoyaltyService } from '../src/billing/loyalty.service.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { chargeTransaction } from '../src/sessions/charge-sql.js';
import { migrate, MIGRATIONS_DIR } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const name = '0029_t148-rfid-settlement-recovery';
const sql = readFileSync(path.join(MIGRATIONS_DIR, name + '.sql'), 'utf8');
const policy = {
  minimumStartVnd: 50000,
  cutoffReserveVnd: 10000,
  pointsExpiryMonths: 12,
  commandTimeoutMs: 3000,
  stationStaleAfterMs: 600000,
};

describeDb('migration 0029: bounded RFID queue recovery', () => {
  let db: Db, cp: number, driver: number, account: number, settlement: ChargeSettlementService;
  let n = 0;
  const q = async (s: string, p: unknown[] = []) => (await db.$client.query(s, p)).rows;
  const id = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0]!.id);
  async function session(
    overrides: {
      origin?: string;
      payment?: string;
      owner?: number | null;
      status?: string;
      stopped?: boolean;
    } = {},
  ) {
    return id(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,driver_id,origin,payment_mode,status,
      cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,meter_start_wh,meter_stop_wh,energy_wh)
      SELECT id,$1,1,$2,$3,$4,$5,$6,now()-interval '10 seconds',now()-interval '10 seconds',
        CASE WHEN $7 THEN now() END,CASE WHEN $7 THEN now() END,1000,
        CASE WHEN $7 THEN 2000 END,CASE WHEN $7 THEN 1000 END
      FROM connectors WHERE charge_point_id=$1 RETURNING id`,
      [
        cp,
        'T148-MIG-' + ++n,
        overrides.owner === undefined ? driver : overrides.owner,
        overrides.origin ?? 'rfid',
        overrides.payment ?? 'csms_billed',
        overrides.status ?? 'reconciled',
        overrides.stopped ?? true,
      ],
    );
  }
  async function snapshot(tables: string[]) {
    const result: Record<string, unknown> = {};
    for (const table of tables) result[table] = await q('SELECT * FROM ' + table + ' ORDER BY 1');
    return result;
  }
  beforeAll(async () => {
    if (
      !url ||
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw new Error('Requires a new isolated MB03 loopback database');
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS t"))[0]!.t)
      throw new Error('Database must be empty');
    await migrate(db.$client);
    const op = await id(
      "INSERT INTO operators(tax_code,legal_name) VALUES('T148M','T148 Migration') RETURNING id",
    );
    const site = await id(
      "INSERT INTO sites(site_code,operator_id,site_name) VALUES('T148M',$1,'T148 Migration') RETURNING id",
      [op],
    );
    cp = await id(
      "INSERT INTO charge_points(serial_number,site_id,lifecycle) VALUES('T148M-CP',$1,'in_service') RETURNING id",
      [site],
    );
    await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1)', [cp]);
    driver = await id(
      "INSERT INTO users(email,full_name,role) VALUES('migration@t148.invalid','Migration','driver') RETURNING id",
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'t148',now())",
      [driver],
    );
    account = await id('INSERT INTO credit_accounts(driver_id) VALUES($1) RETURNING id', [driver]);
    await q(
      `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      VALUES($1,'normal','00:00','24:00',5000,current_date-2)`,
      [op],
    );
    settlement = new ChargeSettlementService(
      db,
      new CreditLedgerService(db),
      new LoyaltyService(policy),
      policy,
    );
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('requeues only missing/ineligible stopped owned RFID jobs, preserves evidence, and is idempotent twice', async () => {
    const missing = await session();
    await q('DELETE FROM charge_settlement_jobs WHERE session_id=$1', [missing]);
    const ineligible = await session();
    await q(
      "UPDATE charge_settlement_jobs SET state='ineligible',reason='ineligible',attempts=3,last_error_code='old',updated_at=now() WHERE session_id=$1",
      [ineligible],
    );
    const review = await session({ status: 'review' });
    await q(
      "UPDATE charge_settlement_jobs SET state='ineligible',updated_at=now() WHERE session_id=$1",
      [review],
    );
    const pending = await session();
    await q(
      "UPDATE charge_settlement_jobs SET reason='missing_meter',next_attempt_at=now()+interval '1 day',updated_at=now() WHERE session_id=$1",
      [pending],
    );
    const postedJob = await session();
    await q(
      "UPDATE charge_settlement_jobs SET state='posted',reason='posted',updated_at=now() WHERE session_id=$1",
      [postedJob],
    );
    const posted = await session();
    expect(await settlement.settle(posted)).toBe('posted');
    const debitOnly = await session();
    await chargeTransaction(db, (c) =>
      new CreditLedgerService(db).post(c, account, 'session_debit', -5000, {
        sessionId: debitOnly,
      }),
    );
    const excluded = [
      await session({ origin: 'app_qr' }),
      await session({ origin: 'free_vend' }),
      await session({ payment: 'unattributed' }),
      await session({ owner: null }),
      await session({ status: 'active', stopped: false }),
      await session({ status: 'active' }),
      debitOnly,
    ];
    for (const sid of excluded)
      await q(
        "UPDATE charge_settlement_jobs SET state='ineligible',updated_at=now() WHERE session_id=$1",
        [sid],
      );
    const future = await session();
    await q(
      "UPDATE sessions SET received_stopped_at=now()+interval '1 day',updated_at=now() WHERE id=$1",
      [future],
    );
    await q(
      "UPDATE charge_settlement_jobs SET state='ineligible',updated_at=now() WHERE session_id=$1",
      [future],
    );
    excluded.push(future);
    const protectedJobs = await q(
      'SELECT * FROM charge_settlement_jobs WHERE session_id<>ALL($1::bigint[]) ORDER BY session_id',
      [[missing, ineligible, review]],
    );
    const financialTables = [
      'sessions',
      'credit_accounts',
      'credit_transactions',
      'loyalty_accounts',
      'loyalty_transactions',
      'charging_statements',
      'session_tariff_segments',
    ];
    const before = await snapshot(financialTables);
    // Replay the official migration against simulated pre-T148 queue state in this isolated database.
    await q('DELETE FROM _migrations WHERE name=$1', [name]);
    expect(await migrate(db.$client)).toEqual([name]);
    const jobs = await q(
      'SELECT session_id,state,reason,attempts,last_error_code FROM charge_settlement_jobs WHERE session_id=ANY($1::bigint[]) ORDER BY session_id',
      [[missing, ineligible, review]],
    );
    expect(jobs).toEqual([
      {
        session_id: String(missing),
        state: 'pending',
        reason: 't148_rfid_recovered',
        attempts: 0,
        last_error_code: null,
      },
      {
        session_id: String(ineligible),
        state: 'pending',
        reason: 't148_rfid_recovered',
        attempts: 3,
        last_error_code: null,
      },
      {
        session_id: String(review),
        state: 'pending',
        reason: 't148_rfid_recovered',
        attempts: 0,
        last_error_code: null,
      },
    ]);
    expect(
      await q(
        'SELECT * FROM charge_settlement_jobs WHERE session_id<>ALL($1::bigint[]) ORDER BY session_id',
        [[missing, ineligible, review]],
      ),
    ).toEqual(protectedJobs);
    expect(await snapshot(financialTables)).toEqual(before);
    const once = await snapshot(['charge_settlement_jobs']);
    expect(await migrate(db.$client)).toEqual([]);
    await q(sql);
    await q(sql);
    expect(await snapshot(['charge_settlement_jobs'])).toEqual(once);
    expect(await snapshot(financialTables)).toEqual(before);
    expect(await settlement.settle(ineligible)).toBe('posted');
    expect(await settlement.settle(ineligible)).toBe('already_posted');
    expect(await settlement.settle(review)).toBe('pending');
    expect(
      (await q('SELECT reason FROM charge_settlement_jobs WHERE session_id=$1', [review]))[0]!
        .reason,
    ).toBe('awaiting_reconciliation');
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM credit_transactions WHERE session_id=$1 AND transaction_type='session_debit'",
          [ineligible],
        )
      )[0]!.n,
    ).toBe(1);
  });
});
