/**
 * Test tích hợp migration 0022 (BE-38): ảnh mẫu xe (`vehicle_models.image_url`, `image_credit`).
 *
 * Vì sao tồn tại: hỏng âm thầm có thể là migration đổi dữ liệu mẫu xe đang có, seed chạy lại ghi đè
 * ảnh đã đổi tay, CHECK cho qua URL http / có khoảng trắng (app tải lỗi hoặc tải qua kênh không mã
 * hoá), ghi công tồn tại mà không có ảnh, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0022 có seed demo + seed-app → migrate → dữ liệu cũ giữ nguyên, seed điền ảnh.
 * Phần 2: DB sạch (0000 → mới nhất) + hành vi hai CHECK + đối chiếu schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { vehicleModels } from '../src/db/schema/sessions.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0022 = '0022_anh-mau-xe';
const BEFORE = listMigrations().filter((n) => n < M0022);
// Migration đến sau 0022: migrate() áp cả chúng sau 0022.
const AFTER = listMigrations().filter((n) => n > M0022);
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');
const IMAGE_BLOCK_START = SEED_APP_SQL.indexOf('-- Ảnh mẫu xe (BE-38');
const IMAGE_BLOCK_END_MARK = 'AND m.image_url IS NULL;';
const IMAGE_BLOCK_END = SEED_APP_SQL.indexOf(IMAGE_BLOCK_END_MARK) + IMAGE_BLOCK_END_MARK.length;

describe('migration 0022 — tĩnh', () => {
  it('chỉ một file mang số của 0022, nằm ngay sau 0021', () => {
    expect(listMigrations().filter((n) => n.startsWith('0022'))).toEqual([M0022]);
    expect(BEFORE[BEFORE.length - 1]).toBe('0021_top-up-ipn-ngoai-le');
  });

  it('seed có đúng 8 ảnh: tên file không khoảng trắng, có ghi công kèm giấy phép', () => {
    expect(IMAGE_BLOCK_START).toBeGreaterThan(0);
    const block = SEED_APP_SQL.slice(IMAGE_BLOCK_START, IMAGE_BLOCK_END);
    const rows = [...block.matchAll(/\('[^']+',\s*'[^']+',\s*'([^']+)',\s*'([^']+)'\)/g)];
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row[1]).toMatch(/^[^\s?#/]+\.jpg$/);
      expect(row[2]).toMatch(/Wikimedia Commons, CC BY-SA 4\.0$/);
    }
  });
});

describeDb('migration 0022 — ảnh mẫu xe (BE-38)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const models = () =>
    q(`SELECT id, brand, model_name, connector_type, battery_capacity_kwh, rated_range_km,
              max_dc_kw, is_vinfast FROM vehicle_models ORDER BY id`);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('nâng cấp DB có seed: mẫu xe cũ giữ nguyên, ảnh NULL; seed lại điền ảnh và không ghi đè', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    await db.$client.query(SEED_SQL);
    // Schema trước 0022 chưa có cột ảnh: khối ảnh của seed-app tự bỏ qua, phần còn lại vẫn nạp.
    await db.$client.query(SEED_APP_SQL);
    const before = await models();
    expect(before).toHaveLength(8);

    expect(await migrate(db.$client)).toEqual([M0022, ...AFTER]);
    expect(await models()).toEqual(before);
    expect(
      await q(
        'SELECT count(*)::int AS n FROM vehicle_models WHERE image_url IS NOT NULL OR image_credit IS NOT NULL',
      ),
    ).toEqual([{ n: 0 }]);

    await db.$client.query(SEED_APP_SQL);
    const filled = await q(
      'SELECT brand, model_name, image_url, image_credit FROM vehicle_models ORDER BY brand, model_name',
    );
    expect(filled).toHaveLength(8);
    for (const m of filled) {
      expect(m['image_url']).toMatch(
        /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/[^\s?]+\.jpg\?width=640$/,
      );
      expect(m['image_credit']).toMatch(/CC BY-SA 4\.0$/);
    }
    expect(await models()).toEqual(before);

    // Ảnh đã đổi tay không bị seed ghi đè.
    await q(
      "UPDATE vehicle_models SET image_url='https://example.invalid/vf3.png', image_credit='Anh rieng' WHERE model_name='VF 3'",
    );
    await db.$client.query(SEED_APP_SQL);
    expect(
      await q("SELECT image_url, image_credit FROM vehicle_models WHERE model_name='VF 3'"),
    ).toEqual([{ image_url: 'https://example.invalid/vf3.png', image_credit: 'Anh rieng' }]);
  });

  it('DB sạch: CHECK chặn URL không phải https / có khoảng trắng / quá dài và ghi công không có ảnh', async () => {
    await resetAndMigrate(db.$client);
    let n = 0;
    const ins = (url: string | null, credit: string | null) =>
      q(
        "INSERT INTO vehicle_models(brand,model_name,image_url,image_credit) VALUES('T',$3,$1,$2)",
        [url, credit, `mau-${++n}`],
      );
    await ins(null, null);
    await ins('https://example.invalid/a.jpg', null);
    await ins('https://example.invalid/a_(1),b.jpg?width=640', 'Tac gia, CC BY-SA 4.0');
    const bad: [string | null, string | null, string][] = [
      ['http://example.invalid/a.jpg', null, 'vehicle_models_image_url_check'],
      ['https://example.invalid/a b.jpg', null, 'vehicle_models_image_url_check'],
      ['javascript:alert(1)', null, 'vehicle_models_image_url_check'],
      ['', null, 'vehicle_models_image_url_check'],
      [`https://example.invalid/${'a'.repeat(500)}`, null, 'vehicle_models_image_url_check'],
      [null, 'Tac gia', 'vehicle_models_image_credit_check'],
      ['https://example.invalid/a.jpg', '', 'vehicle_models_image_credit_check'],
      ['https://example.invalid/a.jpg', 'x'.repeat(201), 'vehicle_models_image_credit_check'],
    ];
    for (const [url, credit, constraint] of bad) {
      await expect(ins(url, credit)).rejects.toMatchObject({ code: '23514', constraint });
    }
  });

  it('schema TS khớp DB: hai cột nullable và hai CHECK', async () => {
    const cfg = getTableConfig(vehicleModels);
    const cols = Object.fromEntries(cfg.columns.map((c) => [c.name, c]));
    expect(cols['image_url']?.notNull).toBe(false);
    expect(cols['image_credit']?.notNull).toBe(false);
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([
      'vehicle_models_image_credit_check',
      'vehicle_models_image_url_check',
    ]);
    const dbCols = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'vehicle_models' AND column_name IN ('image_url', 'image_credit') ORDER BY 1`,
    );
    expect(dbCols).toEqual([
      { column_name: 'image_credit', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'image_url', data_type: 'text', is_nullable: 'YES' },
    ]);
  });
});
