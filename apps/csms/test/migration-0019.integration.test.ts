/**
 * Test tích hợp migration 0019 (T32 Phần 5): idempotency top-up theo tài khoản, `request_hash`,
 * mỗi tài khoản tối đa một top-up pending.
 *
 * Vì sao tồn tại: route tạo top-up (SD-2a) dựa vào ba ràng buộc này để không tạo trùng tiền thật.
 * Hỏng âm thầm có thể là: hai tài xế trùng key chặn nhau (UNIQUE cũ một cột còn sót), cùng key cùng
 * tài khoản lọt qua, key 100 ký tự của hợp đồng bị cắt / từ chối, hai pending cùng lúc, migrate
 * lặng lẽ "chọn" một trong hai pending của dữ liệu cũ, hoặc schema TS lệch DB.
 *
 * Phần 1: DB ngay trước 0019 (có seed demo + seed-app) → migrate → kiểm từng ràng buộc.
 * Phần 2: dữ liệu cũ có tài khoản 2 pending → migrate từ chối, nêu credit_account_id, không đổi gì.
 * Phần 3: DB sạch (0000 → mới nhất) + đối chiếu schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { topUps } from '../src/db/schema/billing.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0019 = '0019_top-up-idempotency-theo-tai-khoan';
const BEFORE_0019 = listMigrations().filter((n) => n < '0019');
const DEMO = path.join(__dirname, '..', 'demo');
const SEED_SQL = readFileSync(path.join(DEMO, 'seed.sql'), 'utf8');
const SEED_APP_SQL = readFileSync(path.join(DEMO, 'seed-app.sql'), 'utf8');

describeDb('migration 0019 — top-up idempotency theo tài khoản, một pending (T32 Phần 5)', () => {
  let db: Db;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  async function buildBefore0019(): Promise<void> {
    await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE_0019)
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await q(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE_0019.map((n) => `('${n}')`).join(', ')};`,
    );
  }

  /** Tài xế mới + tài khoản credit; trả credit_account_id. */
  async function account(): Promise<string> {
    seq += 1;
    const user = (
      await q(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m18-${seq}@t`],
      )
    )[0]!['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    return String(
      (await q('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user]))[0]![
        'id'
      ],
    );
  }

  const insertTopUp = (acc: string, key: string, status = 'pending') => {
    seq += 1;
    return q(
      `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
         status, idempotency_key, expires_at)
       VALUES ($1, $2, 100000, 100000, $3, $4, now() + interval '15 minutes') RETURNING id`,
      [`M18REF${seq}`, acc, status, key],
    );
  };

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('0019 là migration kế tiếp sau 0018 và chỉ có một file mang số 0019', () => {
    expect(listMigrations().filter((n) => n.startsWith('0019'))).toEqual([M0019]);
    expect(BEFORE_0019[BEFORE_0019.length - 1]).toBe('0018_go-xe-tai-xe');
  });

  describe('đường nâng cấp: DB ngay trước 0019 có seed demo + seed-app', () => {
    let before: Record<string, unknown>[] = [];
    let applied: string[] = [];

    beforeAll(async () => {
      await buildBefore0019();
      await q(SEED_SQL);
      await q(SEED_APP_SQL);
      before = await q('SELECT id, idempotency_key, status FROM top_ups ORDER BY id');
      applied = await migrate(db.$client);
    });

    it('áp 0019 rồi các migration sau; dữ liệu top-up cũ giữ nguyên, request_hash NULL', async () => {
      expect(applied[0]).toBe(M0019);
      expect(before.length).toBeGreaterThan(0);
      expect(await q('SELECT id, idempotency_key, status FROM top_ups ORDER BY id')).toEqual(
        before,
      );
      expect(await q('SELECT 1 FROM top_ups WHERE request_hash IS NOT NULL')).toEqual([]);
    });

    it('constraint, index, kiểu cột và COMMENT đúng', async () => {
      expect(
        await q(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'top_ups'::regclass AND contype = 'u' ORDER BY conname`,
        ),
      ).toEqual([
        {
          conname: 'top_ups_account_idempotency_key_key',
          def: 'UNIQUE (credit_account_id, idempotency_key)',
        },
        { conname: 'top_ups_gateway_reference_key', def: 'UNIQUE (gateway_reference)' },
        { conname: 'top_ups_late_gateway_ref_key', def: 'UNIQUE (late_gateway_ref)' },
      ]);
      expect(
        await q(
          `SELECT indexname FROM pg_indexes WHERE indexname IN
           ('top_ups_credit_account_id_idx','top_ups_idempotency_key_key')`,
        ),
      ).toEqual([]);
      expect(
        (
          await q(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'top_ups_one_pending_per_account_key'`,
          )
        )[0]!['indexdef'],
      ).toBe(
        "CREATE UNIQUE INDEX top_ups_one_pending_per_account_key ON public.top_ups USING btree (credit_account_id) WHERE (status = 'pending'::top_up_status)",
      );
      expect(
        await q(
          `SELECT column_name, data_type, character_maximum_length AS len, is_nullable
           FROM information_schema.columns
           WHERE table_name = 'top_ups' AND column_name IN ('idempotency_key','request_hash')
           ORDER BY column_name`,
        ),
      ).toEqual([
        {
          column_name: 'idempotency_key',
          data_type: 'character varying',
          len: 100,
          is_nullable: 'NO',
        },
        {
          column_name: 'request_hash',
          data_type: 'character varying',
          len: 64,
          is_nullable: 'YES',
        },
      ]);
      const comments = await q(
        `SELECT col_description('top_ups'::regclass, attnum) AS c FROM pg_attribute
         WHERE attrelid = 'top_ups'::regclass AND attname IN ('idempotency_key','request_hash')
         ORDER BY attname`,
      );
      expect(String(comments[0]!['c'])).toContain('UNIQUE theo tài khoản');
      expect(String(comments[1]!['c'])).toContain('NULL = dòng không tạo qua API');
      expect(
        (
          await q(`SELECT obj_description('top_ups_one_pending_per_account_key'::regclass) AS c`)
        )[0]!['c'],
      ).toContain('tối đa một top-up pending');
    });

    it('seed demo + seed-app chạy lại trên DB đã 0019 không lỗi, không thêm dòng', async () => {
      const n = await q('SELECT count(*)::int AS n FROM top_ups');
      await q(SEED_SQL);
      await q(SEED_APP_SQL);
      expect(await q('SELECT count(*)::int AS n FROM top_ups')).toEqual(n);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('dữ liệu cũ có tài khoản 2 pending → migrate từ chối, không sửa gì', () => {
    it('thông báo nêu credit_account_id kèm số dòng; _migrations và dữ liệu giữ nguyên', async () => {
      await buildBefore0019();
      const a = await account();
      const b = await account();
      await insertTopUp(a, 'key-a-0001');
      await insertTopUp(a, 'key-a-0002');
      await insertTopUp(b, 'key-b-0001');
      await insertTopUp(b, 'key-b-0002', 'expired');
      const before = await q('SELECT id, status FROM top_ups ORDER BY id');

      const err = await migrate(db.$client).then(
        () => null,
        (error: unknown) => error as { message: string; code?: string },
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('23505');
      expect(err!.message).toContain(`credit_account_id ${a} (2 dòng)`);
      expect(err!.message).not.toContain(`credit_account_id ${b}`);
      expect(await q('SELECT id, status FROM top_ups ORDER BY id')).toEqual(before);
      expect(await q('SELECT 1 FROM _migrations WHERE name = $1', [M0019])).toEqual([]);
      expect(
        await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'top_ups_credit_account_id_idx'`),
      ).toHaveLength(1);

      // Người vận hành sửa tay dòng thừa → migrate chạy được.
      await q(`UPDATE top_ups SET status = 'expired' WHERE idempotency_key = 'key-a-0002'`);
      expect((await migrate(db.$client))[0]).toBe(M0019);
    });
  });

  describe('DB sạch (0000 → mới nhất) và schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('cùng key khác tài khoản → được; cùng key cùng tài khoản → 23505', async () => {
      const a = await account();
      const b = await account();
      await insertTopUp(a, 'same-key-01', 'credited');
      await insertTopUp(b, 'same-key-01', 'credited');
      await expect(insertTopUp(a, 'same-key-01', 'expired')).rejects.toMatchObject({
        code: '23505',
        constraint: 'top_ups_account_idempotency_key_key',
      });
    });

    it('key 100 ký tự → được; 101 → 22001', async () => {
      const a = await account();
      await insertTopUp(a, 'k'.repeat(100), 'credited');
      await expect(insertTopUp(a, 'k'.repeat(101), 'credited')).rejects.toMatchObject({
        code: '22001',
      });
    });

    it('hai pending cùng tài khoản → 23505; một pending + nhiều expired/credited → được', async () => {
      const a = await account();
      await insertTopUp(a, 'p-0001');
      await expect(insertTopUp(a, 'p-0002')).rejects.toMatchObject({
        code: '23505',
        constraint: 'top_ups_one_pending_per_account_key',
      });
      await insertTopUp(a, 'e-0001', 'expired');
      await insertTopUp(a, 'e-0002', 'expired');
      await insertTopUp(a, 'c-0001', 'credited');
      await insertTopUp(a, 'f-0001', 'failed');
      // pending ở tài khoản khác không bị ảnh hưởng
      await insertTopUp(await account(), 'p-0001');
    });

    it('billing.ts khai đúng UNIQUE, partial UNIQUE và không còn index một cột', () => {
      const config = getTableConfig(topUps);
      expect(
        config.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)]).sort(),
      ).toEqual([
        ['top_ups_account_idempotency_key_key', ['credit_account_id', 'idempotency_key']],
        ['top_ups_gateway_reference_key', ['gateway_reference']],
        ['top_ups_late_gateway_ref_key', ['late_gateway_ref']],
      ]);
      const names = config.indexes.map((i) => i.config.name).sort();
      expect(names).toEqual([
        'top_ups_gateway_transaction_no_key',
        'top_ups_one_pending_per_account_key',
        'top_ups_status_expires_at_idx',
      ]);
      const pending = config.indexes.find(
        (i) => i.config.name === 'top_ups_one_pending_per_account_key',
      )!;
      expect(pending.config.unique).toBe(true);
      expect(config.columns.find((c) => c.name === 'request_hash')?.notNull).toBe(false);
    });
  });
});
