// WP3/T72: compose the released billing migration with WP3 without resetting an existing user DB.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDb, Db } from '../src/db/db.module.js';
import { listMigrations, MIGRATIONS_DIR, migrate } from './helpers/apply-migrations.js';

const url = process.env['DATABASE_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('WP3 migration compatibility after billing #60', () => {
  let db: Db;
  const q = async (query: string, args: unknown[] = []) =>
    (await db.$client.query(query, args)).rows;

  beforeAll(() => {
    if (!url || new URL(url).pathname !== '/powerme_test')
      throw new Error('WP3 migrations require powerme_test');
    db = createDb(url);
  });
  beforeEach(async () => {
    await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
    await q(
      'CREATE TABLE _migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of listMigrations().slice(0, 4)) {
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
      await q('INSERT INTO _migrations(name) VALUES($1)', [name]);
    }
  });
  afterAll(async () => db?.$client.end());

  it('upgrades a populated #60 database, preserves billing, and enforces earn/segment keys', async () => {
    const op = (
      await q("INSERT INTO operators(tax_code,legal_name) VALUES('M-WP3','Test') RETURNING id")
    )[0]!.id;
    const cp = (
      await q("INSERT INTO charge_points(serial_number) VALUES('M-WP3') RETURNING id")
    )[0]!.id;
    const connector = (
      await q('INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id', [
        cp,
      ])
    )[0]!.id;
    const driver = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES('migration@wp3.test','Test','driver') RETURNING id",
      )
    )[0]!.id;
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'test',now())",
      [driver],
    );
    const account = (
      await q('INSERT INTO credit_accounts(driver_id,balance_vnd) VALUES($1,200000) RETURNING id', [
        driver,
      ])
    )[0]!.id;
    const topup = (
      await q(
        `INSERT INTO top_ups(gateway_reference,credit_account_id,amount_vnd,amount_paid_vnd,idempotency_key,expires_at)
      VALUES('M-WP3',$1,50000,50000,'M-WP3',now()+interval '15 minutes') RETURNING id`,
        [account],
      )
    )[0]!.id;
    await q(
      `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd,top_up_id)
      VALUES($1,1,'top_up',50000,200000,$2),($1,2,'refund',-50000,150000,$2)`,
      [account, topup],
    );
    const sid = (
      await q(
        `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,origin,payment_mode,status,cp_started_at,meter_start_wh)
      VALUES($1,$2,1,'migration','rfid','csms_billed','active',now(),0) RETURNING id`,
        [connector, cp],
      )
    )[0]!.id;
    const tariff = (
      await q(
        `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
      VALUES($1,'normal','00:00','24:00',5000,current_date) RETURNING id`,
        [op],
      )
    )[0]!.id;
    await q(
      `INSERT INTO session_tariff_segments(session_id,tariff_period_id,segment_start,segment_end,energy_wh,amount_vnd)
      VALUES($1,$2,'2026-10-20T00:00Z','2026-10-20T01:00Z',1000,5000)`,
      [sid, tariff],
    );
    const loyalty = (
      await q('INSERT INTO loyalty_accounts(driver_id) VALUES($1) RETURNING id', [driver])
    )[0]!.id;
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,session_id)
      VALUES($1,1,'earn',5,$2)`,
      [loyalty, sid],
    );

    expect(await migrate(db.$client)).toEqual(listMigrations().slice(4));
    const history = await q('SELECT * FROM _migrations ORDER BY name');
    expect(await migrate(db.$client)).toEqual([]);
    expect(await q('SELECT * FROM _migrations ORDER BY name')).toEqual(history);
    expect(
      (await q('SELECT balance_vnd FROM credit_accounts WHERE id=$1', [account]))[0]!.balance_vnd,
    ).toBe('200000');
    expect(await q('SELECT 1 FROM credit_transactions WHERE top_up_id=$1', [topup])).toHaveLength(
      2,
    );
    await expect(
      q(
        `INSERT INTO credit_transactions(credit_account_id,entry_no,transaction_type,amount_vnd,balance_after_vnd,top_up_id)
      VALUES($1,3,'top_up',50000,200000,$2)`,
        [account, topup],
      ),
    ).rejects.toMatchObject({ constraint: 'credit_transactions_one_per_top_up_and_type' });
    await expect(
      q(
        `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,session_id)
      VALUES($1,2,'earn',5,$2)`,
        [loyalty, sid],
      ),
    ).rejects.toMatchObject({ constraint: 'loyalty_transactions_one_earn_per_session' });
    await q(
      `INSERT INTO loyalty_transactions(loyalty_account_id,entry_no,transaction_type,points,session_id)
      VALUES($1,2,'adjust',-1,$2),($1,3,'restore',1,$2)`,
      [loyalty, sid],
    );
    expect(
      (await q('SELECT amount_vnd FROM session_tariff_segments WHERE session_id=$1', [sid]))[0]!
        .amount_vnd,
    ).toBe('5000');
    const segment = `INSERT INTO session_tariff_segments(session_id,tariff_period_id,segment_start,segment_end,energy_wh,amount_vnd,exact_amount_milli_vnd)
      VALUES($1,$2,'2026-10-21T00:00Z','2026-10-21T01:00Z',500,2500,2500000)`;
    await q(segment, [sid, tariff]);
    await expect(q(segment, [sid, tariff])).rejects.toMatchObject({
      constraint: 'session_tariff_segments_pkey',
    });
    expect(
      await q('SELECT 1 FROM session_tariff_segments WHERE session_id=$1', [sid]),
    ).toHaveLength(2);
  });

  it('both runners refuse legacy WP3 names before changing schema or migration history', async () => {
    await q("DELETE FROM _migrations WHERE name='0003_billing-wf02'");
    await q("INSERT INTO _migrations(name) VALUES('0003_wp3_t31_charging')");
    const before = await q('SELECT * FROM _migrations ORDER BY name');
    await expect(migrate(db.$client)).rejects.toThrow('legacy_wp3_migration_history');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: url! },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('legacy_wp3_migration_history');
    expect(await q('SELECT * FROM _migrations ORDER BY name')).toEqual(before);
    expect((await q("SELECT to_regclass('driver_charge_intents') AS name"))[0]!.name).toBeNull();
  });
});
