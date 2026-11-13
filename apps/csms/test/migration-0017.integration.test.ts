/**
 * Test tích hợp migration 0017 (BE-30): chuẩn hoá `users.phone_number` cũ về E.164 rồi thêm UNIQUE
 * `users_phone_number_key`.
 *
 * Vì sao tồn tại: BE-30 cho đăng nhập bằng số điện thoại, nên một số phải trỏ đúng một tài khoản.
 * Hỏng âm thầm có thể là: số cũ dạng `0900…` không được chuẩn hoá (đăng nhập bằng số không thấy
 * tài khoản, đăng ký cùng số không bị 409), số lạ bị sửa / xoá, migration lặng lẽ "chọn" một trong
 * hai người cùng số, NULL bị coi là trùng, bản SQL của quy tắc lệch bản TypeScript, hoặc schema TS
 * lệch DB.
 *
 * Phần 1: DB ngay trước 0017 (có seed demo + seed-app và số cũ đủ dạng) → migrate → kiểm từng dòng.
 * Phần 2: hai người cùng số sau chuẩn hoá → migrate từ chối, liệt kê id, không đổi gì.
 * Phần 3: hàm SQL của migration chạy đúng bảng ca của unit test (`test/helpers/phone-cases.ts`).
 * Phần 4: DB sạch (0000 → mới nhất) + đối chiếu schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { createDb, Db } from '../src/db/db.module.js';
import { users } from '../src/db/schema/users.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';
import { PHONE_CASES } from './helpers/phone-cases.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0017 = '0017_sdt-tai-xe-duy-nhat';
const BEFORE_0017 = listMigrations().filter((n) => n < '0017');
const M0017_SQL = readFileSync(path.join(MIGRATIONS_DIR, `${M0017}.sql`), 'utf8');
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

async function buildBefore0017(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const name of BEFORE_0017)
    await query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
  await query(
    `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
     INSERT INTO _migrations (name) VALUES ${BEFORE_0017.map((n) => `('${n}')`).join(', ')};`,
  );
}

/** Chạy migrate trên client riêng để bắt RAISE NOTICE; trả danh sách đã áp hoặc lỗi. */
async function migrateCapturing(notices: string[]): Promise<string[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  client.on('notice', (n) => notices.push(n.message ?? ''));
  try {
    return await migrate(client);
  } finally {
    await client.end();
  }
}

describeDb('migration 0017 — số điện thoại E.164 và UNIQUE (BE-30)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const addUser = async (email: string, phone: string | null) =>
    String(
      (
        await q(
          `INSERT INTO users (email, full_name, phone_number, role, updated_at)
           VALUES ($1, 'X', $2, 'driver', '2026-10-01T00:00:00Z') RETURNING id`,
          [email, phone],
        )
      )[0]!['id'],
    );

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('0017 là migration kế tiếp sau 0016 và chỉ có một file mang số 0017', () => {
    expect(listMigrations().filter((n) => n.startsWith('0017'))).toEqual([M0017]);
    expect(BEFORE_0017[BEFORE_0017.length - 1]).toBe('0016_bo-the-wallet-station-wallet');
  });

  describe('đường nâng cấp: DB ngay trước 0017 có seed demo + seed-app và số cũ đủ dạng', () => {
    const notices: string[] = [];
    const ids: Record<string, string> = {};
    let applied: string[] = [];

    beforeAll(async () => {
      await buildBefore0017((sql) => db.$client.query(sql));
      await db.$client.query(SEED_SQL);
      await db.$client.query(SEED_APP_SQL);
      // Tài xế demo như seed.sql TRƯỚC BE-30 (staging hiện có): số dạng nội địa.
      await q(
        `UPDATE users SET phone_number = '0900000001' WHERE email = 'driver.demo@powerme.test'`,
      );
      await q(
        `UPDATE users SET phone_number = '0900000002' WHERE email = 'driver2.demo@powerme.test'`,
      );
      ids['dots'] = await addUser('dots@m17.test', '091.234.5678');
      ids['cc'] = await addUser('cc@m17.test', '84912345679');
      ids['us'] = await addUser('us@m17.test', '+14155550123');
      ids['e164'] = await addUser('e164@m17.test', '+84912345670');
      ids['junk'] = await addUser('junk@m17.test', 'goi-cho-toi');
      ids['short'] = await addUser('short@m17.test', '12345');
      ids['null1'] = await addUser('null1@m17.test', null);
      ids['null2'] = await addUser('null2@m17.test', null);
      applied = await migrateCapturing(notices);
    });

    it('migrate() áp 0017 rồi các migration sau; in số dòng chuẩn hoá / không nhận ra', () => {
      expect(applied[0]).toBe(M0017);
      expect(applied).toEqual(listMigrations().slice(BEFORE_0017.length));
      // 11 số: 2 demo + 3 app (đã E.164) + 6 thêm ở trên; đổi 4 (2 demo, dots, cc); lạ 2.
      expect(notices).toContain(
        '0017: 11 số điện thoại; 4 dòng chuẩn hoá về E.164; 2 dòng không nhận ra (giữ nguyên)',
      );
    });

    it('số cũ → E.164, updated_at được ghi; số đã đúng, số lạ và NULL không bị đụng', async () => {
      const rows = Object.fromEntries(
        (
          await q(
            `SELECT email, phone_number, updated_at > '2026-10-02'::timestamptz AS touched FROM users`,
          )
        ).map((r) => [String(r['email']), [r['phone_number'], r['touched']]]),
      );
      expect(rows['driver.demo@powerme.test']).toEqual(['+84900000001', true]);
      expect(rows['driver2.demo@powerme.test']).toEqual(['+84900000002', true]);
      expect(rows['app.ds01@powerme.test']?.[0]).toBe('+84900000101');
      expect(rows['app.ds02@powerme.test']?.[0]).toBe('+84900000102');
      expect(rows['app.ds03@powerme.test']?.[0]).toBe('+84900000103');
      expect(rows['dots@m17.test']).toEqual(['+84912345678', true]);
      expect(rows['cc@m17.test']).toEqual(['+84912345679', true]);
      expect(rows['us@m17.test']).toEqual(['+14155550123', false]);
      expect(rows['e164@m17.test']).toEqual(['+84912345670', false]);
      expect(rows['junk@m17.test']).toEqual(['goi-cho-toi', false]);
      expect(rows['short@m17.test']).toEqual(['12345', false]);
      expect(rows['null1@m17.test']).toEqual([null, false]);
      expect(rows['null2@m17.test']).toEqual([null, false]);
    });

    it('UNIQUE users_phone_number_key có mặt, index cũ đã bỏ, hàm tạm không còn', async () => {
      expect(
        await q(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'users'::regclass AND contype = 'u' ORDER BY conname`,
        ),
      ).toEqual([
        { conname: 'users_email_key', def: 'UNIQUE (email)' },
        { conname: 'users_phone_number_key', def: 'UNIQUE (phone_number)' },
      ]);
      expect(
        await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'users_phone_number_idx'`),
      ).toEqual([]);
      expect(await q(`SELECT 1 FROM pg_proc WHERE proname = 'be30_normalize_phone'`)).toEqual([]);
    });

    it('seed demo + seed-app chạy lại trên DB đã 0017 không lỗi, không đổi số', async () => {
      const before = await q('SELECT id, phone_number FROM users ORDER BY id');
      await db.$client.query(SEED_SQL);
      await db.$client.query(SEED_APP_SQL);
      expect(await q('SELECT id, phone_number FROM users ORDER BY id')).toEqual(before);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('còn số trùng sau chuẩn hoá → migrate từ chối, không sửa gì', () => {
    it('liệt kê id từng nhóm (không in số), _migrations và dữ liệu giữ nguyên', async () => {
      await buildBefore0017((sql) => db.$client.query(sql));
      const a = await addUser('a@m17.test', '0901234567');
      const b = await addUser('b@m17.test', '+84 901 234 567');
      const c = await addUser('c@m17.test', '84901234567');
      const d = await addUser('d@m17.test', 'abc');
      const e = await addUser('e@m17.test', 'abc');
      await addUser('f@m17.test', '0911111111');
      await addUser('g@m17.test', null);
      await addUser('h@m17.test', null);
      const before = await q('SELECT id, phone_number, updated_at FROM users ORDER BY id');

      const err = await migrateCapturing([]).then(
        () => null,
        (error: unknown) => error as { message: string; code?: string },
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('23505');
      expect(err!.message).toBe(
        `0017: số điện thoại trùng sau chuẩn hoá (id ${a}, ${b}, ${c}; id ${d}, ${e}). Không sửa gì; tự quyết mỗi số thuộc tài khoản nào (UPDATE users SET phone_number = ...) rồi chạy lại migrate`,
      );
      expect(err!.message).not.toContain('090');
      expect(await q('SELECT id, phone_number, updated_at FROM users ORDER BY id')).toEqual(before);
      expect(await q(`SELECT 1 FROM _migrations WHERE name = $1`, [M0017])).toEqual([]);
      expect(
        await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'users_phone_number_idx'`),
      ).toHaveLength(1);

      // Người vận hành gỡ trùng bằng tay → migrate chạy được.
      await q('UPDATE users SET phone_number = NULL WHERE id = ANY($1)', [[b, c, e]]);
      expect((await migrate(db.$client))[0]).toBe(M0017);
      expect(
        (await q('SELECT phone_number FROM users WHERE id = ANY($1) ORDER BY id', [[a, d]])).map(
          (r) => r['phone_number'],
        ),
      ).toEqual(['+84901234567', 'abc']);
    });
  });

  describe('hàm SQL của migration = quy tắc TypeScript', () => {
    it('cùng kết quả trên toàn bộ bảng ca của phone-number.spec.ts', async () => {
      const start = M0017_SQL.indexOf('CREATE FUNCTION pg_temp.be30_normalize_phone');
      const end = M0017_SQL.indexOf('$fn$;', start) + '$fn$;'.length;
      expect(start).toBeGreaterThan(0);
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        await client.query(M0017_SQL.slice(start, end));
        const got: [string, string | null][] = [];
        for (const [raw] of PHONE_CASES) {
          const { rows } = await client.query<{ out: string | null }>(
            'SELECT pg_temp.be30_normalize_phone($1) AS out',
            [raw],
          );
          got.push([raw, rows[0]!.out]);
        }
        expect(got).toEqual(PHONE_CASES);
      } finally {
        await client.end();
      }
    });
  });

  describe('DB sạch (0000 → mới nhất) và schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('hai người cùng số → 23505 users_phone_number_key; nhiều NULL cùng tồn tại', async () => {
      await addUser('n1@m17.test', null);
      await addUser('n2@m17.test', null);
      await addUser('p1@m17.test', '+84901234567');
      await expect(addUser('p2@m17.test', '+84901234567')).rejects.toMatchObject({
        code: '23505',
        constraint: 'users_phone_number_key',
      });
    });

    it('users.ts khai đúng UNIQUE users_phone_number_key và không còn index thường', () => {
      const config = getTableConfig(users);
      expect(config.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)])).toEqual([
        ['users_email_key', ['email']],
        ['users_phone_number_key', ['phone_number']],
      ]);
      expect(config.indexes).toEqual([]);
    });
  });
});
