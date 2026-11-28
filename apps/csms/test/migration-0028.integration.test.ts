/**
 * Test tích hợp migration 0028 (T32 Phần 9a, WP5): `refunds.confirmed_via_query` và hai CHECK.
 *
 * Vì sao tồn tại: nới `refunds_gateway_refund_no_check` có thể để lọt refund `done` không có bằng
 * chứng nào (không mã hoàn, không cờ), hoặc dòng vừa có mã hoàn vừa có cờ, hoặc cờ trên dòng chưa
 * `done`. Nâng cấp phải giữ nguyên dòng cũ.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì describe DB bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { refunds } from '../src/db/schema/billing.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0028 = '0028_refund-xac-nhan-qua-truy-van';
const BEFORE = listMigrations().filter((n) => n < M0028);
const AFTER = listMigrations().filter((n) => n > M0028);

describe('migration 0028 — tĩnh', () => {
  it('chỉ một file mang số 0028, đứng sau 0027', () => {
    expect(listMigrations().filter((n) => n.startsWith('0028'))).toEqual([M0028]);
    expect(BEFORE).toContain('0027_dem-lan-giu-cho');
  });
});

describeDb('migration 0028 — confirmed_via_query (T32 Phần 9a)', () => {
  let db: Db;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  async function topUp(): Promise<number> {
    seq += 1;
    const user = (
      await one(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m28-${seq}@t`],
      )
    )['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    const acc = (
      await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user])
    )['id'];
    return Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
             status, gateway_transaction_no, idempotency_key, expires_at, completed_at)
           VALUES ($1, $2, 100000, 100000, 'credited', $3, $4, now() + interval '15 minutes', now())
           RETURNING id`,
          [`M28REF${seq}`, acc, String(96_000_000 + seq), `m28-key-${seq}`],
        )
      )['id'],
    );
  }

  /** Refund `account_closure` (không cần admin) với trạng thái cho trước. */
  async function refund(status: string, refundNo: string | null, viaQuery?: boolean) {
    const t = await topUp();
    const done = status === 'done';
    const cols = viaQuery === undefined ? '' : ', confirmed_via_query';
    const vals = viaQuery === undefined ? '' : ', $5';
    const params: unknown[] = [t, status, refundNo, done];
    if (viaQuery !== undefined) params.push(viaQuery);
    return one(
      `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, gateway_refund_no, completed_at${cols})
       VALUES ($1, 'account_closure', 1000, $2::refund_status, $3,
               CASE WHEN $4::boolean THEN now() ELSE NULL END${vals})
       RETURNING id`,
      params,
    );
  }

  it('nâng cấp DB có refund requested / done: dòng cũ nhận false, cột khác giữ nguyên; chạy lại không áp gì', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    await refund('requested', null);
    await refund('done', 'OLD-RF-1');
    await refund('failed', null);
    const snapshot = () =>
      q(
        `SELECT id, status::text, gateway_refund_no, completed_at, next_attempt_at, updated_at
         FROM refunds ORDER BY id`,
      );
    const before = await snapshot();

    expect(await migrate(db.$client)).toEqual([M0028, ...AFTER]);
    expect(await snapshot()).toEqual(before);
    expect(await q('SELECT DISTINCT confirmed_via_query FROM refunds')).toEqual([
      { confirmed_via_query: false },
    ]);
    expect(await migrate(db.$client)).toEqual([]);
  });

  describe('DB sạch (0000 → mới nhất)', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('cột boolean NOT NULL DEFAULT false', async () => {
      expect(
        await one(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_name = 'refunds' AND column_name = 'confirmed_via_query'`,
        ),
      ).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    });

    it('hợp lệ: done + mã hoàn; done qua querydr (cờ, mã NULL); requested / failed không cờ', async () => {
      await refund('done', 'M28-RF-1');
      await refund('done', 'M28-RF-2', false);
      await refund('done', null, true);
      await refund('requested', null);
      // Từ 0032 refund failed phải có failure_reason.
      await q(
        `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, failure_reason)
         VALUES ($1, 'account_closure', 1000, 'failed', 'cổng từ chối')`,
        [await topUp()],
      );
    });

    it('bị chặn: done không mã, không cờ', async () => {
      await expect(refund('done', null)).rejects.toMatchObject({
        code: '23514',
        constraint: 'refunds_gateway_refund_no_check',
      });
    });

    it('bị chặn: cờ cùng mã hoàn', async () => {
      await expect(refund('done', 'M28-RF-3', true)).rejects.toMatchObject({
        code: '23514',
        constraint: 'refunds_confirmed_via_query_check',
      });
    });

    it.each(['requested', 'failed'])('bị chặn: cờ trên dòng %s', async (status) => {
      await expect(refund(status, null, true)).rejects.toMatchObject({
        code: '23514',
        constraint: 'refunds_confirmed_via_query_check',
      });
    });

    it('UNIQUE gateway_refund_no giữ nguyên; nhiều dòng qua querydr (NULL) không đụng nhau', async () => {
      await refund('done', 'M28-RF-DUP');
      await expect(refund('done', 'M28-RF-DUP')).rejects.toMatchObject({
        code: '23505',
        constraint: 'refunds_gateway_refund_no_key',
      });
      await refund('done', null, true);
      await refund('done', null, true);
    });

    it('COMMENT ghi nghĩa của cờ', async () => {
      const c = await one(
        `SELECT col_description('refunds'::regclass,
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'refunds'::regclass
            AND attname = 'confirmed_via_query')) AS c`,
      );
      expect(String(c['c'])).toContain('querydr');
    });

    it('schema TS khai khớp: cột và hai CHECK', () => {
      const cfg = getTableConfig(refunds);
      const col = cfg.columns.find((x) => x.name === 'confirmed_via_query')!;
      expect(col.getSQLType()).toBe('boolean');
      expect(col.notNull).toBe(true);
      expect(col.default).toBe(false);
      expect(cfg.checks.map((x) => x.name)).toEqual(
        expect.arrayContaining([
          'refunds_gateway_refund_no_check',
          'refunds_confirmed_via_query_check',
        ]),
      );
    });
  });
});
