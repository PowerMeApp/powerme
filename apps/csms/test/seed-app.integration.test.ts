/**
 * Test tích hợp demo/seed-app.sql (BE-27) — dữ liệu mẫu cho app tài xế trên staging.
 *
 * Vì sao tồn tại: staging chạy `seed-demo.mjs` (seed.sql rồi seed-app.sql) mỗi lần `--seed`, nên file
 * phải (1) chạy lại không nhân đôi dòng, (2) không ghi đè dữ liệu phát sinh (sổ cái credit, điểm),
 * (3) cho số dư khớp sổ cái, (4) thật sự hiện ra trong tìm trạm theo toạ độ của app (#98: chỉ trụ
 * in_service, lọc theo cổng của xe, VinFast-only). Phần đặt mật khẩu tài xế (seed-demo.mjs, cần
 * dist/) được kiểm bằng tay khi deploy; ở đây chỉ kiểm SQL.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, Db } from '../src/db/db.module.js';
import { searchStations } from '../src/sessions/station-search.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');
const [DS01, DS02, DS03] = [
  'app.ds01@powerme.test',
  'app.ds02@powerme.test',
  'app.ds03@powerme.test',
];
const EMAILS = [DS01, DS02, DS03];
// Toạ độ chợ Bến Thành (Quận 1).
const Q1 = { latitude: 10.7725, longitude: 106.698 };

const COUNTS = `SELECT
  (SELECT count(*) FROM sites)::int AS sites,
  (SELECT count(*) FROM charge_points)::int AS charge_points,
  (SELECT count(*) FROM connectors)::int AS connectors,
  (SELECT count(*) FROM vehicle_models)::int AS vehicle_models,
  (SELECT count(*) FROM users)::int AS users,
  (SELECT count(*) FROM vehicles)::int AS vehicles,
  (SELECT count(*) FROM credit_accounts)::int AS credit_accounts,
  (SELECT count(*) FROM top_ups)::int AS top_ups,
  (SELECT count(*) FROM credit_transactions)::int AS credit_transactions,
  (SELECT count(*) FROM loyalty_accounts)::int AS loyalty_accounts,
  (SELECT count(*) FROM loyalty_transactions)::int AS loyalty_transactions`;

describeDb('demo/seed-app.sql — dữ liệu mẫu cho app tài xế (BE-27)', () => {
  let db: Db;
  const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    (await db.$client.query(sql, args)).rows as T[];
  const seedAll = async () => {
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
  };
  const driver = async (email: string) =>
    (await q<{ id: string }>('SELECT id::text AS id FROM users WHERE email=$1', [email]))[0]!.id;
  const vehicle = async (plate: string) =>
    (
      await q<{ id: string }>('SELECT id::text AS id FROM vehicles WHERE plate_number=$1', [plate])
    )[0]!.id;
  const search = async (email: string, plate: string, extra = {}) => {
    const c = await db.$client.connect();
    try {
      return await searchStations(
        c,
        await driver(email),
        await vehicle(plate),
        { ...Q1, sort: 'distance', pageSize: 50, ...extra },
        60_000,
        120_000,
      );
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('lần đầu: 9 trạm, 12 trụ, 22 súng, 8 mẫu xe, 3 tài xế, 5 xe; trụ in_service không credential', async () => {
    await seedAll();
    const [row] = await q(
      `SELECT (SELECT count(*) FROM sites WHERE site_code LIKE 'HCM-APP-%')::int AS sites,
        (SELECT count(*) FILTER (WHERE vinfast_only) FROM sites WHERE site_code LIKE 'HCM-APP-%')::int AS vinfast_only,
        (SELECT count(*) FROM charge_points WHERE serial_number LIKE 'PMAPP-%')::int AS cps,
        (SELECT count(*) FROM charge_points WHERE serial_number LIKE 'PMAPP-%'
           AND lifecycle='in_service' AND basic_auth_password_hash IS NULL AND NOT is_online
           AND last_message_at IS NULL AND online_changed_at IS NULL)::int AS cps_offline_no_cred,
        (SELECT count(*) FROM connectors c JOIN charge_points cp ON cp.id=c.charge_point_id
           WHERE cp.serial_number LIKE 'PMAPP-%')::int AS connectors,
        (SELECT array_agg(DISTINCT c.connector_type::text ORDER BY c.connector_type::text) FROM connectors c
           JOIN charge_points cp ON cp.id=c.charge_point_id WHERE cp.serial_number LIKE 'PMAPP-%') AS kinds,
        (SELECT count(*) FROM vehicle_models)::int AS models,
        (SELECT count(*) FROM users u JOIN drivers d ON d.user_id=u.id
           WHERE u.email = ANY($1) AND u.role='driver' AND u.account_status='active')::int AS drivers,
        (SELECT count(*) FROM vehicles v JOIN users u ON u.id=v.driver_id WHERE u.email = ANY($1))::int AS vehicles,
        (SELECT count(*) FROM users WHERE email = ANY($1) AND password_hash IS NOT NULL)::int AS with_password`,
      [EMAILS],
    );
    expect(row).toEqual({
      sites: 9,
      vinfast_only: 3,
      cps: 12,
      cps_offline_no_cred: 12,
      connectors: 22,
      kinds: ['ccs2', 'chademo', 'type2'],
      models: 8,
      drivers: 3,
      vehicles: 5,
      // Mật khẩu do seed-demo.mjs đặt từ DEMO_DRIVER_PASSWORD, không bao giờ từ SQL trong repo.
      with_password: 0,
    });
  });

  it('số dư = sổ cái: DS-01 200.000, DS-02 30.000, DS-03 100.000 + 600 điểm (lô earn có hạn)', async () => {
    const rows = await q(
      `SELECT u.email, ca.balance_vnd::int AS balance,
         (SELECT sum(amount_vnd) FROM credit_transactions ct WHERE ct.credit_account_id=ca.id)::int AS ledger,
         (SELECT balance_after_vnd FROM credit_transactions ct WHERE ct.credit_account_id=ca.id
           ORDER BY entry_no DESC LIMIT 1)::int AS last_after,
         la.points_balance::int AS points,
         (SELECT coalesce(sum(points),0) FROM loyalty_transactions lt WHERE lt.loyalty_account_id=la.id)::int AS points_ledger,
         (SELECT bool_and(transaction_type='earn' AND expires_at > now()) FROM loyalty_transactions lt
           WHERE lt.loyalty_account_id=la.id) AS lots_alive
       FROM users u JOIN credit_accounts ca ON ca.driver_id=u.id JOIN loyalty_accounts la ON la.driver_id=u.id
       WHERE u.email = ANY($1) ORDER BY u.email`,
      [EMAILS],
    );
    expect(rows).toEqual([
      {
        email: DS01,
        balance: 200000,
        ledger: 200000,
        last_after: 200000,
        points: 0,
        points_ledger: 0,
        lots_alive: null,
      },
      {
        email: DS02,
        balance: 30000,
        ledger: 30000,
        last_after: 30000,
        points: 0,
        points_ledger: 0,
        lots_alive: null,
      },
      {
        email: DS03,
        balance: 100000,
        ledger: 100000,
        last_after: 100000,
        points: 600,
        points_ledger: 600,
        lots_alive: true,
      },
    ]);
  });

  it('chạy lại hai lần: không nhân đôi dòng nào', async () => {
    const [before] = await q(COUNTS);
    await seedAll();
    await seedAll();
    const [after] = await q(COUNTS);
    expect(after).toEqual(before);
  });

  it('không ghi đè dữ liệu phát sinh: sổ cái đã có dòng mới, xe mặc định do app đổi, trạng thái súng', async () => {
    const [acc] = await q<{ id: string }>(
      `SELECT ca.id::text AS id FROM credit_accounts ca JOIN users u ON u.id=ca.driver_id WHERE u.email=$1`,
      [DS01],
    );
    // Giả lập app đã phát sinh: một điều chỉnh -50.000, đổi xe mặc định, một StatusNotification.
    await q(
      `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd, balance_after_vnd)
       VALUES ($1, 2, 'adjustment', -50000, 150000)`,
      [acc!.id],
    );
    await q(`UPDATE credit_accounts SET balance_vnd=150000 WHERE id=$1`, [acc!.id]);
    await q(`UPDATE vehicles SET is_default = (plate_number = '51K-901.02')
             WHERE plate_number IN ('51K-901.01','51K-901.02')`);
    await q(`UPDATE connectors SET status='Faulted', status_changed_at=now()
             WHERE charge_point_id=(SELECT id FROM charge_points WHERE serial_number='PMAPP-Q3-01A') AND connector_no=2`);
    await seedAll();
    const [after] = await q(
      `SELECT ca.balance_vnd::int AS balance, (SELECT count(*) FROM credit_transactions WHERE credit_account_id=ca.id)::int AS entries,
         (SELECT string_agg(plate_number, ',') FROM vehicles WHERE driver_id=ca.driver_id AND is_default) AS default_plate,
         (SELECT status::text FROM connectors c JOIN charge_points cp ON cp.id=c.charge_point_id
           WHERE cp.serial_number='PMAPP-Q3-01A' AND c.connector_no=2) AS status
       FROM credit_accounts ca WHERE ca.id=$1`,
      [acc!.id],
    );
    expect(after).toEqual({
      balance: 150000,
      entries: 2,
      default_plate: '51K-901.02',
      status: 'Faulted',
    });
  });

  it('tìm trạm gần Quận 1: xe VinFast CCS2 thấy cả trạm VinFast-only, gần nhất trước, súng offline', async () => {
    const r = await search(DS01, '51K-901.01');
    const codes = r.items.map((s) => s.site_code);
    expect(codes).toEqual(
      expect.arrayContaining(['HCM-APP-Q1-01', 'HCM-APP-Q7-01', 'HCM-APP-TB-01']),
    );
    expect(codes).not.toContain('HCM-APP-Q10-01'); // chỉ Type2
    const distances = r.items.map((s) => s.distance_m!);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    const q1 = r.items.find((s) => s.site_code === 'HCM-APP-Q1-01')!;
    expect(q1.distance_m!).toBeLessThan(200);
    expect(
      q1.connectors.every((c) => c.connector_type === 'ccs2' && c.driver_status === 'offline'),
    ).toBe(true);
  });

  it('xe không VinFast không thấy trạm VinFast-only; CHAdeMO và Type2 chỉ thấy đúng cổng', async () => {
    const ioniq = (await search(DS03, '51K-903.01')).items.map((s) => s.site_code);
    expect(ioniq).toContain('HCM-APP-Q1-01');
    expect(
      ioniq.filter((c) => ['HCM-APP-Q7-01', 'HCM-APP-TD-02', 'HCM-APP-TB-01'].includes(c)),
    ).toEqual([]);
    const leaf = (await search(DS01, '51K-901.02')).items.map((s) => s.site_code).sort();
    expect(leaf).toEqual(['HCM-APP-Q3-01', 'HCM-APP-TD-01']);
    const mini = (await search(DS03, '51K-903.02')).items.map((s) => s.site_code).sort();
    expect(mini).toEqual(['HCM-APP-Q1-01', 'HCM-APP-Q10-01', 'HCM-APP-TD-01']);
  });
});
