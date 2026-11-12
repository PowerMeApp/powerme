/**
 * Test tích hợp migration 0018 (BE-34): xoá mềm xe (`vehicles.removed_at`), biển số duy nhất
 * trong xe đang dùng theo khoá chữ + số (`vehicles_plate_key_active`), CHECK xe đã gỡ không mặc định.
 *
 * Vì sao tồn tại: hỏng âm thầm có thể là dữ liệu cũ hai biển "cùng một xe" (`51K-901.01` và
 * `51K90101`) bị migrate cho qua rồi API không biết chọn xe nào, migration sửa / xoá xe cũ, seed
 * chạy lại vấp lỗi vì `ON CONFLICT ON CONSTRAINT vehicles_plate_number_key` không còn, seed hồi sinh
 * xe tài xế đã gỡ, biểu thức khoá của API lệch index, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0018 có seed demo + seed-app → migrate → kiểm dữ liệu, ràng buộc, seed lại.
 * Phần 2: hai xe cùng khoá biển → migrate từ chối, liệt kê id, không đổi gì.
 * Phần 3: DB sạch (0000 → mới nhất) + hành vi ràng buộc + đối chiếu schema TS và PLATE_KEY_SQL.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 * Số migration có thể phải đổi nếu PR khác chiếm 0018 trước: đổi M0018 ở dưới.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { vehicles } from '../src/db/schema/sessions.js';
import { PLATE_KEY_SQL } from '../src/driver/vehicles.http.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0018 = '0018_go-xe-tai-xe';
const BEFORE = listMigrations().filter((n) => n < M0018);
const M0018_SQL = readFileSync(path.join(MIGRATIONS_DIR, `${M0018}.sql`), 'utf8');
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

async function buildBefore(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const name of BEFORE)
    await query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
  await query(
    `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
     INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
  );
}

describe('migration 0018 — tĩnh', () => {
  it('chỉ một file mang số của 0018, nằm ngay sau 0017', () => {
    expect(listMigrations().filter((n) => n.startsWith(M0018.slice(0, 4)))).toEqual([M0018]);
    expect(BEFORE[BEFORE.length - 1]).toBe('0017_sdt-tai-xe-duy-nhat');
  });

  it('biểu thức khoá biển số của API = biểu thức của index trong migration', () => {
    expect(M0018_SQL).toContain(`ON vehicles ((${PLATE_KEY_SQL}))`);
    expect(M0018_SQL).toContain(`GROUP BY ${PLATE_KEY_SQL}`);
  });
});

describeDb('migration 0018 — xoá mềm xe, biển số duy nhất trong xe đang dùng (BE-34)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const vehicleRows = () =>
    q('SELECT id, plate_number, driver_id, vehicle_model_id, is_default FROM vehicles ORDER BY id');

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  describe('đường nâng cấp: DB ngay trước 0018 có seed demo + seed-app', () => {
    let before: Record<string, unknown>[];
    let applied: string[];

    beforeAll(async () => {
      await buildBefore((sql) => db.$client.query(sql));
      await db.$client.query(SEED_SQL);
      await db.$client.query(SEED_APP_SQL);
      before = await vehicleRows();
      applied = await migrate(db.$client);
    });

    it('áp 0018 rồi các migration sau; mọi xe cũ giữ nguyên và đang dùng', async () => {
      expect(applied[0]).toBe(M0018);
      expect(applied).toEqual(listMigrations().slice(BEFORE.length));
      expect(before.length).toBeGreaterThanOrEqual(5);
      expect(await vehicleRows()).toEqual(before);
      expect(
        await q('SELECT count(*)::int AS n FROM vehicles WHERE removed_at IS NOT NULL'),
      ).toEqual([{ n: 0 }]);
    });

    it('UNIQUE cũ đã bỏ; index khoá biển số có điều kiện và CHECK có mặt', async () => {
      expect(
        await q(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'vehicles'::regclass AND contype IN ('u', 'c') ORDER BY conname`,
        ),
      ).toEqual([
        {
          conname: 'vehicles_removed_not_default',
          def: 'CHECK (((removed_at IS NULL) OR (NOT is_default)))',
        },
      ]);
      expect(
        await q(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE tablename = 'vehicles' AND indexname = 'vehicles_plate_key_active'`,
        ),
      ).toEqual([
        {
          indexname: 'vehicles_plate_key_active',
          indexdef:
            "CREATE UNIQUE INDEX vehicles_plate_key_active ON public.vehicles USING btree (upper(regexp_replace((plate_number)::text, '[^A-Za-z0-9]'::text, ''::text, 'g'::text))) WHERE (removed_at IS NULL)",
        },
      ]);
    });

    it('seed demo + seed-app chạy lại không lỗi, không đổi xe; không hồi sinh xe tài xế đã gỡ', async () => {
      await db.$client.query(SEED_SQL);
      await db.$client.query(SEED_APP_SQL);
      expect(await vehicleRows()).toEqual(before);
      // DS-01 gỡ xe phụ 51K-901.02 qua app → seed lại không tạo xe mới cùng biển.
      await q(
        `UPDATE vehicles SET removed_at = now(), is_default = false, updated_at = now()
         WHERE plate_number = '51K-901.02'`,
      );
      await db.$client.query(SEED_APP_SQL);
      expect(
        await q(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE removed_at IS NULL)::int AS active
           FROM vehicles WHERE plate_number = '51K-901.02'`,
        ),
      ).toEqual([{ n: 1, active: 0 }]);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('dữ liệu cũ có hai xe cùng khoá biển số → migrate từ chối, không sửa gì', () => {
    it('liệt kê id từng nhóm (không in biển), _migrations và dữ liệu giữ nguyên', async () => {
      await buildBefore((sql) => db.$client.query(sql));
      await db.$client.query(SEED_SQL);
      await db.$client.query(SEED_APP_SQL);
      const [driver] = await q(
        "SELECT d.user_id::text AS id FROM drivers d JOIN users u ON u.id=d.user_id WHERE u.email='app.ds02@powerme.test'",
      );
      const [model] = await q('SELECT id::text AS id FROM vehicle_models ORDER BY id LIMIT 1');
      const ids: string[] = [];
      for (const plate of ['59A-123.45', '59a12345', '59A 123.46', '59-A12346'])
        ids.push(
          String(
            (
              await q(
                'INSERT INTO vehicles (plate_number, driver_id, vehicle_model_id) VALUES ($1, $2, $3) RETURNING id',
                [plate, driver!['id'], model!['id']],
              )
            )[0]!['id'],
          ),
        );
      const snapshot = await vehicleRows();
      const err = await migrate(db.$client).then(
        () => null,
        (error: unknown) => error as { message: string; code?: string },
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('23505');
      expect(err!.message).toBe(
        `0018: biển số trùng khi bỏ dấu và khoảng trắng (id ${ids[0]}, ${ids[1]}; id ${ids[2]}, ${ids[3]}). Không sửa gì; tự quyết biển đúng của từng xe (UPDATE vehicles SET plate_number = ...) rồi chạy lại migrate`,
      );
      expect(err!.message).not.toContain('59');
      expect(await vehicleRows()).toEqual(snapshot);
      expect(await q('SELECT 1 FROM _migrations WHERE name = $1', [M0018])).toEqual([]);
      expect(
        await q(
          "SELECT 1 FROM information_schema.columns WHERE table_name='vehicles' AND column_name='removed_at'",
        ),
      ).toEqual([]);

      // Người vận hành sửa tay → migrate chạy được.
      await q("UPDATE vehicles SET plate_number = '59A-999.01' WHERE id = $1", [ids[1]]);
      await q("UPDATE vehicles SET plate_number = '59A-999.02' WHERE id = $1", [ids[3]]);
      expect((await migrate(db.$client))[0]).toBe(M0018);
    });
  });

  describe('DB sạch (0000 → mới nhất) và schema TS', () => {
    let driver: string;
    let model: string;
    const addVehicle = (plate: string, isDefault = false, removed = false) =>
      q(
        `INSERT INTO vehicles (plate_number, driver_id, vehicle_model_id, is_default, removed_at)
         VALUES ($1, $2, $3, $4, ${removed ? 'now()' : 'NULL'}) RETURNING id`,
        [plate, driver, model, isDefault],
      );

    beforeAll(async () => {
      await resetAndMigrate(db.$client);
      driver = String(
        (
          await q(
            "INSERT INTO users (email, full_name, role) VALUES ('m18@example.invalid', 'X', 'driver') RETURNING id",
          )
        )[0]!['id'],
      );
      await q(
        "INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'test', now())",
        [driver],
      );
      model = String(
        (
          await q(
            "INSERT INTO vehicle_models (brand, model_name) VALUES ('M18', 'Test') RETURNING id",
          )
        )[0]!['id'],
      );
    });

    it('cùng khoá biển với xe đang dùng → 23505 vehicles_plate_key_active; xe đã gỡ không giữ biển', async () => {
      await addVehicle('51K-111.11', false, true);
      await addVehicle('51K-111.11');
      await expect(addVehicle('51k11111')).rejects.toMatchObject({
        code: '23505',
        constraint: 'vehicles_plate_key_active',
      });
      await addVehicle('51K-111.11', false, true);
      expect(
        await q("SELECT count(*)::int AS n FROM vehicles WHERE plate_number = '51K-111.11'"),
      ).toEqual([{ n: 3 }]);
    });

    it('xe đã gỡ không thể là xe mặc định (CHECK); một xe mặc định mỗi tài xế vẫn giữ', async () => {
      await expect(addVehicle('51K-222.22', true, true)).rejects.toMatchObject({
        code: '23514',
        constraint: 'vehicles_removed_not_default',
      });
      await addVehicle('51K-333.33', true);
      await expect(addVehicle('51K-444.44', true)).rejects.toMatchObject({
        code: '23505',
        constraint: 'vehicles_one_default_per_driver',
      });
    });

    it('sessions.ts khai đúng: không còn UNIQUE biển số, có removed_at, index khoá, CHECK', () => {
      const config = getTableConfig(vehicles);
      const dialect = new PgDialect();
      expect(config.uniqueConstraints).toEqual([]);
      expect(config.columns.find((c) => c.name === 'removed_at')).toMatchObject({
        notNull: false,
        columnType: 'PgTimestamp',
      });
      const index = config.indexes.find((i) => i.config.name === 'vehicles_plate_key_active')!;
      expect(index.config.unique).toBe(true);
      const on = index.config.columns.map((c) => dialect.sqlToQuery(c as never).sql).join();
      expect(on).toBe(
        `(upper(regexp_replace("vehicles"."plate_number", '[^A-Za-z0-9]', '', 'g')))`,
      );
      expect(dialect.sqlToQuery(index.config.where!).sql).toBe('"vehicles"."removed_at" IS NULL');
      expect(config.checks.map((c) => [c.name, dialect.sqlToQuery(c.value).sql])).toEqual([
        [
          'vehicles_removed_not_default',
          '"vehicles"."removed_at" IS NULL OR NOT "vehicles"."is_default"',
        ],
      ]);
      expect(config.indexes.map((i) => i.config.name).sort()).toEqual([
        'vehicles_driver_id_idx',
        'vehicles_one_default_per_driver',
        'vehicles_plate_key_active',
        'vehicles_vehicle_model_id_idx',
      ]);
    });
  });
});
