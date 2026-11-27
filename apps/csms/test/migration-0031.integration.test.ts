// WP3: migration adds protection without allocating historical credit or reviving terminal settlement.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createDb, type Db } from '../src/db/db.module.js';
import { creditSummary } from '../src/driver/driver-credit.js';
import { migrate, MIGRATIONS_DIR } from './helpers/apply-migrations.js';
const url = process.env.MB03_TEST_DATABASE_URL;
(url ? describe : describe.skip)('migration 0031 RFID holds and stop jobs', () => {
  let db: Db;
  const q = async (s: string, p: unknown[] = []) => (await db.$client.query(s, p)).rows;
  const id = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0]!.id);
  beforeAll(async () => {
    if (
      !url ||
      process.env.MB03_TEST_ALLOW_EMPTY_DATABASE !== 'true' ||
      new URL(url).hostname !== '127.0.0.1' ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(new URL(url).pathname)
    )
      throw Error('Fresh isolated MB03 DB required');
    db = createDb(url);
  });
  afterAll(async () => {
    await db?.$client.end();
  });
  it('preserves old evidence and closed-account terminal jobs, reruns, and enforces ownership/amount/state constraints', async () => {
    const prior = path.join(process.env.TEMP!, 'pre-0031');
    mkdirSync(prior, { recursive: true });
    for (const file of readdirSync(MIGRATIONS_DIR).filter(
      (f) => /^\d{4}_.*\.sql$/.test(f) && f < '0031',
    ))
      copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(prior, file));
    await migrate(db.$client, prior);
    const op = await id(
      "INSERT INTO operators(tax_code,legal_name) VALUES('M0031','Fixture') RETURNING id",
    );
    const site = await id(
      "INSERT INTO sites(site_code,site_name,operator_id) VALUES('M0031','Fixture',$1) RETURNING id",
      [op],
    );
    const cp = await id(
      "INSERT INTO charge_points(serial_number,site_id,lifecycle) VALUES('M0031',$1,'in_service') RETURNING id",
      [site],
    );
    const connector = await id(
      'INSERT INTO connectors(charge_point_id,connector_no) VALUES($1,1) RETURNING id',
      [cp],
    );
    const driver = await id(
      "INSERT INTO users(email,full_name,role) VALUES('m0031@invalid.test','Fixture','driver') RETURNING id",
    );
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'fixture',now())",
      [driver],
    );
    const account = await id(
      "INSERT INTO credit_accounts(driver_id,balance_vnd,status,closed_at) VALUES($1,200000,'closed',now()) RETURNING id",
      [driver],
    );
    const session = await id(
      `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,driver_id,origin,payment_mode,status,
      cp_started_at,received_started_at,received_stopped_at,meter_start_wh) VALUES($1,$2,1,'M0031',$3,'rfid','csms_billed','review',now()-interval '3 years',now()-interval '3 years',now()-interval '3 years',1000) RETURNING id`,
      [connector, cp, driver],
    );
    await q(
      "UPDATE charge_settlement_jobs SET state='ineligible',reason='account_closed',attempts=7 WHERE session_id=$1",
      [session],
    );
    await q(
      "INSERT INTO charge_point_offline_auth_checks(charge_point_id,epoch,started_at,completed_at,offline_card_risk,risk_reason) VALUES($1,1,now(),now(),true,'not_supported')",
      [cp],
    );
    const tables = [
      'sessions',
      'credit_accounts',
      'credit_transactions',
      'loyalty_transactions',
      'charging_statements',
      'charge_settlement_jobs',
      'charge_point_offline_auth_checks',
    ];
    const before = await Promise.all(tables.map((t) => q('SELECT * FROM ' + t + ' ORDER BY 1')));
    expect(await migrate(db.$client)).toEqual(['0031_rfid-credit-protection']);
    expect(await migrate(db.$client)).toEqual([]);
    await q(readFileSync(path.join(MIGRATIONS_DIR, '0031_rfid-credit-protection.sql'), 'utf8'));
    expect(await Promise.all(tables.map((t) => q('SELECT * FROM ' + t + ' ORDER BY 1')))).toEqual(
      before,
    );
    expect(await q('SELECT * FROM rfid_credit_holds')).toEqual([]);
    expect(await creditSummary(db, String(driver))).toMatchObject({
      held_vnd: 0,
      available_vnd: 200000,
      blocking_rfid_sessions: 1,
    });
    await expect(
      q(
        "INSERT INTO rfid_credit_holds(session_id,credit_account_id,amount_vnd,reason) VALUES($1,$2,-1,'fixture')",
        [session, account],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      q(
        "INSERT INTO rfid_credit_holds(session_id,credit_account_id,amount_vnd,reason) VALUES($1,$2,'0.5','fixture')",
        [session, account],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
    await expect(
      q(
        "INSERT INTO rfid_credit_holds(session_id,credit_account_id,amount_vnd,reason) VALUES($1,999999,0,'fixture')",
        [session],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await q(
      "INSERT INTO rfid_credit_holds(session_id,credit_account_id,amount_vnd,reason) VALUES($1,$2,0,'offline_obligation')",
      [session, account],
    );
    await expect(
      q(
        "INSERT INTO rfid_credit_holds(session_id,credit_account_id,amount_vnd,reason) VALUES($1,$2,0,'fixture')",
        [session, account],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      q("UPDATE rfid_credit_holds SET state='released' WHERE session_id=$1", [session]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      q("INSERT INTO rfid_stop_jobs(session_id,reason,attempt_limit) VALUES($1,'fixture',0)", [
        session,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await q("INSERT INTO rfid_stop_jobs(session_id,reason,attempt_limit) VALUES($1,'fixture',3)", [
      session,
    ]);
    await expect(
      q('UPDATE rfid_stop_jobs SET attempts=4 WHERE session_id=$1', [session]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      q("UPDATE rfid_stop_jobs SET state='exhausted' WHERE session_id=$1", [session]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
