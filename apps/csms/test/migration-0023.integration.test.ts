/**
 * Test tích hợp migration 0023 (T134): đồng hồ tính giá `cp_offset` (giờ trụ cộng độ lệch đo được)
 * và hai loại bản ghi `tariff_clock_offset`, `tariff_boundary_interpolated`.
 *
 * Vì sao tồn tại: quyết toán ghi `sessions.priced_clock = 'cp_offset'` và một bản ghi
 * `tariff_clock_offset` trong cùng giao dịch với khoản trừ tiền. Hỏng âm thầm có thể là: CHECK cũ còn
 * đó nên mọi phiên có đồng hồ lệch quay lui cả giao dịch quyết toán (job thử lại mãi, không bao giờ
 * trừ tiền), migration đổi đồng hồ của phiên đã quyết toán, bằng chứng biên trên trục đã chỉnh bị từ
 * chối, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0023 có seed demo + seed-app + phiên đã quyết toán theo cp / csms → migrate.
 * Phần 2: DB sạch (0000 → mới nhất) + hành vi hai CHECK và enum + đối chiếu schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { reconciliationRecordTypeEnum } from '../src/db/schema/enums.js';
import { sessions } from '../src/db/schema/sessions.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0023 = '0023_t134-do-lech-dong-ho-tru';
const BEFORE = listMigrations().filter((n) => n < M0023);
// Migration đến sau 0023: migrate() áp cả chúng sau 0023.
const AFTER = listMigrations().filter((n) => n > M0023);
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');
const AT = '2026-11-01T04:30:00Z';
const BOUNDARY = '2026-11-01T04:10:00Z';

describe('migration 0023 — tĩnh', () => {
  it('chỉ một file mang số 0023, nằm ngay sau 0022', () => {
    expect(listMigrations().filter((n) => n.startsWith('0023'))).toEqual([M0023]);
    expect(BEFORE[BEFORE.length - 1]).toBe('0022_anh-mau-xe');
  });

  it('file không dùng giá trị enum mới trong chính transaction thêm nó', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, `${M0023}.sql`), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const value of ['tariff_clock_offset', 'tariff_boundary_interpolated']) {
      expect(sql.match(new RegExp(value, 'g'))).toHaveLength(1);
      expect(sql).toContain(`ALTER TYPE reconciliation_record_type ADD VALUE '${value}';`);
    }
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describeDb('migration 0023 — độ lệch đồng hồ trụ (T134)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  /** Một phiên đã dừng trên súng đầu tiên của seed, đã quyết toán theo `clock` (NULL = chưa); trả id. */
  async function session(idTag: string, clock: string | null): Promise<string> {
    const rows = await q(
      `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
         status, cp_started_at, meter_start_wh, meter_stop_wh, cp_stopped_at, received_stopped_at,
         energy_wh, total_cost_vnd, priced_clock, priced_ended_at)
       SELECT c.id, c.charge_point_id, c.connector_no, $1, 'rfid', 'unattributed', 'reconciled',
         '2026-11-01T04:00:00Z', 1000, 1800, $3, $3, 800, 4000, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE $3::timestamptz END
       FROM connectors c ORDER BY c.id LIMIT 1 RETURNING id::text`,
      [idTag, clock, AT],
    );
    return String(rows[0]!['id']);
  }
  const staff = async () =>
    String((await q("SELECT id::text FROM users WHERE role = 'operator_staff' LIMIT 1"))[0]!['id']);
  const evidence = (sid: string, clock: string, wh: number, op: string) =>
    q(
      `INSERT INTO charge_tariff_boundary_evidence (session_id, boundary_at, meter_wh, recorded_by, evidence_note, pricing_clock)
       VALUES ($1, $2, $3, $4, 'Bien 11:10', $5)`,
      [sid, BOUNDARY, wh, op, clock],
    );
  const record = (sid: string, no: number, type: string, resolution: string) =>
    q(
      `INSERT INTO reconciliation_records (session_id, record_no, record_type, resolution)
       VALUES ($1, $2, $3, $4)`,
      [sid, no, type, resolution],
    );
  const labels = async () =>
    (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'reconciliation_record_type' ORDER BY e.enumsortorder`,
      )
    ).map((r) => r['enumlabel']);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('nâng cấp DB có seed: phiên đã quyết toán, bản ghi và bằng chứng biên cũ giữ nguyên; giá trị mới chỉ dùng được sau migrate', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
    const op = await staff();
    const cp = await session('M0023-CP', 'cp');
    const csms = await session('M0023-CSMS', 'csms');
    await session('M0023-OPEN', null);
    await evidence(cp, 'cp', 1300, op);
    await evidence(csms, 'csms', 1350, op);
    await record(
      csms,
      1,
      'tariff_clock_fallback',
      'tariff_clock=csms_fallback reason=tariff_clock_ambiguous_delay',
    );
    await record(
      cp,
      1,
      'conflict',
      'meter_evidence_conflict reason=conflicting_sample message_log_id=1',
    );
    // Trước 0023: đồng hồ cp_offset và loại bản ghi mới chưa tồn tại.
    await expect(
      q("UPDATE sessions SET priced_clock = 'cp_offset' WHERE id = $1", [cp]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sessions_priced_clock_check' });
    await expect(evidence(cp, 'cp_offset', 1300, op)).rejects.toMatchObject({
      code: '23514',
      constraint: 'charge_tariff_boundary_evidence_pricing_clock_check',
    });
    for (const type of ['tariff_clock_offset', 'tariff_boundary_interpolated'])
      await expect(record(cp, 2, type, 'x')).rejects.toMatchObject({ code: '22P02' });
    const snapshot = async () => ({
      sessions: await q('SELECT to_jsonb(s) AS row FROM sessions s ORDER BY id'),
      records: await q('SELECT to_jsonb(r) AS row FROM reconciliation_records r ORDER BY id'),
      evidence: await q(
        'SELECT to_jsonb(e) AS row FROM charge_tariff_boundary_evidence e ORDER BY session_id',
      ),
    });
    const before = await snapshot();
    expect(before.sessions.length).toBeGreaterThanOrEqual(3);

    expect(await migrate(db.$client)).toEqual([M0023, ...AFTER]);

    expect(await snapshot()).toEqual(before);
    // Seed chạy lại trên schema mới vẫn nạp được và không đụng dữ liệu tính giá.
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
    expect((await snapshot()).sessions).toEqual(before.sessions);
    // Sau migrate (transaction đã commit): quyết toán theo cp_offset ghi được cả ba chỗ.
    await q("UPDATE sessions SET priced_clock = 'cp_offset', priced_ended_at = $2 WHERE id = $1", [
      cp,
      AT,
    ]);
    await evidence(cp, 'cp_offset', 1320, op);
    await record(
      cp,
      2,
      'tariff_clock_offset',
      'tariff_clock=cp_offset offset_s=600 epoch=1 live_frames=4',
    );
  });

  describe('DB sạch (0000 → mới nhất): ràng buộc và schema TS', () => {
    let sid = '';
    let op = '';

    beforeAll(async () => {
      await resetAndMigrate(db.$client);
      await db.$client.query(SEED_SQL);
      sid = await session('M0023-NEW', null);
      op = await staff();
    });

    it('sessions_priced_clock_check: nhận cp / cp_offset / csms kèm mốc dừng, chặn giá trị khác và thiếu mốc dừng', async () => {
      const set = (clock: string | null, ended: string | null) =>
        q('UPDATE sessions SET priced_clock = $2, priced_ended_at = $3 WHERE id = $1', [
          sid,
          clock,
          ended,
        ]);
      for (const clock of ['cp', 'cp_offset', 'csms']) await set(clock, AT);
      await set(null, null);
      const bad: [string | null, string | null][] = [
        ['cp_offset', null],
        [null, AT],
        ['offset', AT],
        ['cp-offset', AT],
        ['CP_OFFSET', AT],
        ['', AT],
      ];
      for (const [clock, ended] of bad) {
        await expect(set(clock, ended)).rejects.toMatchObject({
          code: '23514',
          constraint: 'sessions_priced_clock_check',
        });
      }
    });

    it('bằng chứng biên: cùng một biên có được ở cả ba trục giờ, giá trị khác bị chặn', async () => {
      await evidence(sid, 'cp', 1300, op);
      await evidence(sid, 'cp_offset', 1320, op);
      await evidence(sid, 'csms', 1350, op);
      await expect(evidence(sid, 'cp_offset', 1400, op)).rejects.toMatchObject({
        code: '23505',
        constraint: 'charge_tariff_boundary_evidence_pkey',
      });
      for (const clock of ['offset', 'CP', '']) {
        await expect(evidence(sid, clock, 1300, op)).rejects.toMatchObject({
          code: '23514',
          constraint: 'charge_tariff_boundary_evidence_pricing_clock_check',
        });
      }
      // Cột vẫn NOT NULL, mặc định cp (0020).
      expect(
        await q(
          `SELECT is_nullable, column_default FROM information_schema.columns
           WHERE table_name = 'charge_tariff_boundary_evidence' AND column_name = 'pricing_clock'`,
        ),
      ).toEqual([{ is_nullable: 'NO', column_default: "'cp'::text" }]);
    });

    it('hai loại bản ghi mới đứng ngay sau tariff_clock_fallback và ghi được', async () => {
      const all = await labels();
      const at = all.indexOf('tariff_clock_fallback');
      expect(all.slice(at, at + 3)).toEqual([
        'tariff_clock_fallback',
        'tariff_clock_offset',
        'tariff_boundary_interpolated',
      ]);
      await record(
        sid,
        2,
        'tariff_boundary_interpolated',
        'tariff_boundary=interpolated boundaries=1 max_gap_s=120',
      );
      await record(
        sid,
        1,
        'tariff_clock_offset',
        'tariff_clock=cp_offset offset_s=-600 epoch=2 live_frames=3',
      );
    });

    it('schema TS khớp DB: enum loại bản ghi, ba giá trị của priced_clock và CHECK', async () => {
      expect(await labels()).toEqual([...reconciliationRecordTypeEnum.enumValues]);
      const cfg = getTableConfig(sessions);
      const pricedClock = cfg.columns.find((c) => c.name === 'priced_clock');
      expect(pricedClock?.enumValues).toEqual(['cp', 'cp_offset', 'csms']);
      expect(pricedClock?.notNull).toBe(false);
      expect(cfg.checks.map((c) => c.name)).toContain('sessions_priced_clock_check');
      const defs = await q(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname IN ('sessions_priced_clock_check', 'charge_tariff_boundary_evidence_pricing_clock_check')
         ORDER BY conname`,
      );
      expect(defs.map((d) => d['conname'])).toEqual([
        'charge_tariff_boundary_evidence_pricing_clock_check',
        'sessions_priced_clock_check',
      ]);
      for (const d of defs) {
        for (const clock of pricedClock?.enumValues ?? [])
          expect(String(d['def'])).toContain(`'${clock}'`);
      }
    });
  });
});
