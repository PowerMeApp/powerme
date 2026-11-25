/**
 * Test tích hợp migration 0020 (T101): đồng hồ tính giá của phiên (`sessions.priced_clock`,
 * `priced_ended_at`), loại bản ghi `tariff_clock_fallback`, trục giờ của bằng chứng biên
 * (`charge_tariff_boundary_evidence.pricing_clock` nằm trong khoá chính).
 *
 * Vì sao tồn tại: 0020 được merge (#120) mà chưa có test riêng. Hỏng âm thầm có thể là: migration
 * gán đồng hồ cho phiên đã quyết toán từ trước (báo cáo doanh thu K3 nhóm sai ngày), bằng chứng biên
 * cũ mất hoặc đổi trục, CHECK cho qua phiên có đồng hồ mà không có mốc dừng, khoá chính mới vẫn chặn
 * hai trục giờ của cùng một biên, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0020 có seed demo + seed-app + phiên / bản ghi / bằng chứng cũ → migrate.
 * Phần 2: DB dừng ĐÚNG ở 0020 (chưa có migration sau) → hành vi các ràng buộc của riêng 0020.
 * Phần 3: DB sạch (0000 → mới nhất) → đối chiếu schema TS.
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

const M0020 = '0020_t101_tariff_clock';
const BEFORE = listMigrations().filter((n) => n < M0020);
// Migration đến sau 0020 (0021 …): migrate() áp cả chúng sau 0020.
const AFTER = listMigrations().filter((n) => n > M0020);
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

describe('migration 0020 — tĩnh', () => {
  it('chỉ một file mang số 0020, nằm ngay sau 0019', () => {
    expect(listMigrations().filter((n) => n.startsWith('0020'))).toEqual([M0020]);
    expect(BEFORE[BEFORE.length - 1]).toBe('0019_top-up-idempotency-theo-tai-khoan');
  });
});

describeDb('migration 0020 — đồng hồ tính giá (T101)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  /** DB có đúng các migration `names` (đã ghi vào `_migrations`), chưa có dữ liệu. */
  async function build(names: string[]): Promise<void> {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of names)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${names.map((n) => `('${n}')`).join(', ')};`,
    );
  }

  /** Một phiên đã dừng trên súng đầu tiên của seed; trả id. */
  async function session(idTag: string): Promise<string> {
    const rows = await q(
      `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
         status, cp_started_at, meter_start_wh, meter_stop_wh, cp_stopped_at, received_stopped_at,
         energy_wh, total_cost_vnd)
       SELECT c.id, c.charge_point_id, c.connector_no, $1, 'rfid', 'unattributed', 'reconciled',
         '2026-11-01T04:00:00Z', 1000, 1800, '2026-11-01T04:30:00Z', '2026-11-01T04:30:01Z', 800, 4000
       FROM connectors c ORDER BY c.id LIMIT 1 RETURNING id::text`,
      [idTag],
    );
    return String(rows[0]!['id']);
  }
  const staff = async () =>
    String((await q("SELECT id::text FROM users WHERE role = 'operator_staff' LIMIT 1"))[0]!['id']);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('nâng cấp DB có seed: phiên, bản ghi đối soát và bằng chứng biên cũ giữ nguyên; đồng hồ NULL; bằng chứng cũ thuộc trục cp', async () => {
    await build(BEFORE);
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
    const sid = await session('M0020-OLD');
    await q(
      `INSERT INTO reconciliation_records (session_id, record_no, record_type, resolution)
       VALUES ($1, 1, 'conflict', 'conflict: diff=5')`,
      [sid],
    );
    await q(
      `INSERT INTO charge_tariff_boundary_evidence (session_id, boundary_at, meter_wh, recorded_by, evidence_note)
       VALUES ($1, '2026-11-01T04:10:00Z', 1300, $2, 'Bien 11:10 truoc 0020')`,
      [sid, await staff()],
    );
    const sessionsBefore = await q('SELECT to_jsonb(s) AS row FROM sessions s ORDER BY id');
    const recordsBefore = await q(
      'SELECT to_jsonb(r) AS row FROM reconciliation_records r ORDER BY id',
    );
    const evidenceBefore = await q(
      'SELECT to_jsonb(e) AS row FROM charge_tariff_boundary_evidence e',
    );
    // Trước 0020 chưa có giá trị enum và cột mới.
    await expect(
      q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type) VALUES ($1, 2, 'tariff_clock_fallback')`,
        [sid],
      ),
    ).rejects.toMatchObject({ code: '22P02' });

    expect(await migrate(db.$client)).toEqual([M0020, ...AFTER]);

    expect(
      await q(
        `SELECT to_jsonb(s) - 'priced_clock' - 'priced_ended_at' AS row FROM sessions s ORDER BY id`,
      ),
    ).toEqual(sessionsBefore);
    // Phiên quyết toán trước 0020 không được gán đồng hồ: không biết thì để NULL.
    expect(
      await q(
        'SELECT count(*)::int AS n FROM sessions WHERE priced_clock IS NOT NULL OR priced_ended_at IS NOT NULL',
      ),
    ).toEqual([{ n: 0 }]);
    expect(await q('SELECT to_jsonb(r) AS row FROM reconciliation_records r ORDER BY id')).toEqual(
      recordsBefore,
    );
    expect(
      await q(`SELECT to_jsonb(e) - 'pricing_clock' AS row FROM charge_tariff_boundary_evidence e`),
    ).toEqual(evidenceBefore);
    expect(await q('SELECT pricing_clock FROM charge_tariff_boundary_evidence')).toEqual([
      { pricing_clock: 'cp' },
    ]);
    // Seed chạy lại trên schema mới vẫn nạp được.
    await db.$client.query(SEED_SQL);
    await db.$client.query(SEED_APP_SQL);
  });

  describe('DB dừng đúng ở 0020: ràng buộc của riêng migration này', () => {
    let sid = '';
    let op = '';

    beforeAll(async () => {
      await build([...BEFORE, M0020]);
      await db.$client.query(SEED_SQL);
      sid = await session('M0020-NEW');
      op = await staff();
    });

    it('sessions_priced_clock_check: đồng hồ và mốc dừng cùng có hoặc cùng NULL; chỉ cp / csms', async () => {
      const set = (clock: string | null, ended: string | null) =>
        q('UPDATE sessions SET priced_clock = $2, priced_ended_at = $3 WHERE id = $1', [
          sid,
          clock,
          ended,
        ]);
      const at = '2026-11-01T04:30:00Z';
      await set('cp', at);
      await set('csms', at);
      await set(null, null);
      const bad: [string | null, string | null][] = [
        ['cp', null],
        [null, at],
        ['cp_offset', at], // chỉ hợp lệ từ 0023
        ['', at],
        ['CP', at],
      ];
      for (const [clock, ended] of bad) {
        await expect(set(clock, ended)).rejects.toMatchObject({
          code: '23514',
          constraint: 'sessions_priced_clock_check',
        });
      }
    });

    it('bằng chứng biên: mặc định trục cp, cùng một biên được có ở hai trục, trùng trục bị chặn', async () => {
      const ins = (clock: string | null, wh: number) =>
        clock === null
          ? q(
              `INSERT INTO charge_tariff_boundary_evidence (session_id, boundary_at, meter_wh, recorded_by, evidence_note)
               VALUES ($1, '2026-11-01T04:10:00Z', $2, $3, 'Bien 11:10') RETURNING pricing_clock`,
              [sid, wh, op],
            )
          : q(
              `INSERT INTO charge_tariff_boundary_evidence (session_id, boundary_at, meter_wh, recorded_by, evidence_note, pricing_clock)
               VALUES ($1, '2026-11-01T04:10:00Z', $2, $3, 'Bien 11:10', $4) RETURNING pricing_clock`,
              [sid, wh, op, clock],
            );
      expect(await ins(null, 1300)).toEqual([{ pricing_clock: 'cp' }]);
      expect(await ins('csms', 1350)).toEqual([{ pricing_clock: 'csms' }]);
      await expect(ins('cp', 1400)).rejects.toMatchObject({
        code: '23505',
        constraint: 'charge_tariff_boundary_evidence_pkey',
      });
      for (const clock of ['cp_offset', 'x', '']) {
        await expect(ins(clock, 1300)).rejects.toMatchObject({
          code: '23514',
          constraint: 'charge_tariff_boundary_evidence_pricing_clock_check',
        });
      }
      expect(
        await q(
          `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = 'charge_tariff_boundary_evidence'::regclass AND i.indisprimary
           ORDER BY array_position(i.indkey::int2[], a.attnum)`,
        ),
      ).toEqual([
        { attname: 'session_id' },
        { attname: 'boundary_at' },
        { attname: 'pricing_clock' },
      ]);
    });

    it('loại bản ghi tariff_clock_fallback dùng được sau khi migration đã commit, đứng cuối enum', async () => {
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type, resolution)
         VALUES ($1, 1, 'tariff_clock_fallback', 'tariff_clock=csms_fallback reason=tariff_clock_future_timestamp')`,
        [sid],
      );
      const labels = (
        await q(
          `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = 'reconciliation_record_type' ORDER BY e.enumsortorder`,
        )
      ).map((r) => r['enumlabel']);
      expect(labels[labels.length - 1]).toBe('tariff_clock_fallback');
      expect(labels).toHaveLength(8);
    });
  });

  it('schema TS khớp DB mới nhất: hai cột nullable, CHECK, enum loại bản ghi', async () => {
    await resetAndMigrate(db.$client);
    const cfg = getTableConfig(sessions);
    const cols = Object.fromEntries(cfg.columns.map((c) => [c.name, c]));
    expect(cols['priced_clock']?.notNull).toBe(false);
    expect(cols['priced_ended_at']?.notNull).toBe(false);
    expect(cfg.checks.map((c) => c.name)).toContain('sessions_priced_clock_check');
    expect(
      await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'sessions' AND column_name IN ('priced_clock', 'priced_ended_at') ORDER BY 1`,
      ),
    ).toEqual([
      { column_name: 'priced_clock', data_type: 'text', is_nullable: 'YES' },
      {
        column_name: 'priced_ended_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
      },
    ]);
    const labels = (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'reconciliation_record_type' ORDER BY e.enumsortorder`,
      )
    ).map((r) => r['enumlabel']);
    expect(labels).toEqual([...reconciliationRecordTypeEnum.enumValues]);
    expect(labels).toContain('tariff_clock_fallback');
  });
});
