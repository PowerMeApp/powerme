/**
 * Test tích hợp migration 0032 (T32 hoàn tiền thủ công, WP5): `refunds.failure_reason`, hai CHECK mới,
 * bỏ `refunds_next_attempt_check` và DEFAULT của `next_attempt_at`.
 *
 * Vì sao tồn tại: refund `failed` không lý do thì CSKH không biết vì sao cổng từ chối; dòng `failed`
 * có sẵn phải được điền lý do, nếu không nâng cấp vỡ ở CHECK; code mới không ghi `next_attempt_at`
 * nên CHECK cũ phải bỏ, nếu không mọi lần làm lại (`failed → requested`) đều lỗi.
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

const M0032 = '0032_refund-ghi-nhan-thu-cong';
const BEFORE = listMigrations().filter((n) => n < M0032);
const AFTER = listMigrations().filter((n) => n > M0032);

describe('migration 0032 — tĩnh', () => {
  it('chỉ một file mang số 0032, đứng sau 0031', () => {
    expect(listMigrations().filter((n) => n.startsWith('0032'))).toEqual([M0032]);
    expect(BEFORE).toContain('0031_rfid-credit-protection');
  });

  it('schema TS khai khớp: cột failure_reason, hai CHECK mới, không còn refunds_next_attempt_check', () => {
    const cfg = getTableConfig(refunds);
    const col = cfg.columns.find((x) => x.name === 'failure_reason')!;
    expect([col.getSQLType(), col.notNull]).toEqual(['text', false]);
    const next = cfg.columns.find((x) => x.name === 'next_attempt_at')!;
    expect(next.hasDefault).toBe(false);
    const names = cfg.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'refunds_failure_reason_length_check',
        'refunds_failure_reason_check',
      ]),
    );
    expect(names).not.toContain('refunds_next_attempt_check');
  });
});

describeDb('migration 0032 — failure_reason (hoàn tiền thủ công)', () => {
  let db: Db;
  let seq = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as { code?: string; constraint?: string };
    }
    throw new Error('expected rejection');
  };

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
        [`m32-${seq}@t`],
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
          [`M32REF${seq}`, acc, String(97_000_000 + seq), `m32-key-${seq}`],
        )
      )['id'],
    );
  }

  /** Refund `account_closure` (không cần admin). `extra` là cột thêm của INSERT. */
  async function refund(status: string, extra: Record<string, unknown> = {}) {
    const cols = ['top_up_id', 'kind', 'amount_vnd', 'status', ...Object.keys(extra)];
    const vals: unknown[] = [
      await topUp(),
      'account_closure',
      1000,
      status,
      ...Object.values(extra),
    ];
    if (status === 'done') {
      cols.push('completed_at', 'gateway_refund_no');
      vals.push(new Date(), `M32-RF-${seq}`);
    }
    return one(
      `INSERT INTO refunds (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id, status::text, next_attempt_at${'failure_reason' in extra ? ', failure_reason' : ''}`,
      vals,
    );
  }

  it('nâng cấp DB có refund failed / requested / done: failed được điền lý do từ lỗi cũ, dòng khác giữ nguyên; chạy lại không áp gì', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    const withMsg = await refund('failed', {
      attempt_count: 1,
      last_error_kind: 'data',
      last_error_message: 'vnpay_rejected rc=95',
      last_attempt_at: new Date(),
      next_attempt_at: null,
    });
    const noMsg = await refund('failed', { next_attempt_at: null });
    const longMsg = await refund('failed', {
      last_error_kind: 'transient',
      last_error_message: 'x'.repeat(1200),
      last_attempt_at: new Date(),
      next_attempt_at: null,
    });
    const req = await refund('requested');
    const done = await refund('done', { next_attempt_at: null });
    const snapshot = () =>
      q(
        `SELECT id, status::text, gateway_refund_no, completed_at, next_attempt_at, updated_at
         FROM refunds ORDER BY id`,
      );
    const before = await snapshot();

    expect(await migrate(db.$client)).toEqual([M0032, ...AFTER]);
    expect(await snapshot()).toEqual(before);
    const reason = async (r: Record<string, unknown>) =>
      (await one('SELECT failure_reason FROM refunds WHERE id=$1', [r['id']]))['failure_reason'];
    expect(await reason(withMsg)).toBe('Luồng gửi tự động cũ: vnpay_rejected rc=95');
    expect(await reason(noMsg)).toBe('Luồng gửi tự động cũ: không rõ');
    expect(String(await reason(longMsg))).toHaveLength(1000);
    expect(await reason(req)).toBeNull();
    expect(await reason(done)).toBeNull();
    expect(await migrate(db.$client)).toEqual([]);
  });

  describe('DB sạch (0000 → mới nhất)', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('failed không lý do → refunds_failure_reason_check; có lý do → được', async () => {
      expect((await rejection(refund('failed'))).constraint).toBe('refunds_failure_reason_check');
      expect(await refund('failed', { failure_reason: 'cổng từ chối' })).toMatchObject({
        status: 'failed',
        failure_reason: 'cổng từ chối',
      });
    });

    it('lý do 1–1000 ký tự; requested / done được giữ lý do (làm lại giữ lý do cũ)', async () => {
      for (const bad of ['', 'x'.repeat(1001)])
        expect((await rejection(refund('failed', { failure_reason: bad }))).constraint).toBe(
          'refunds_failure_reason_length_check',
        );
      expect(await refund('failed', { failure_reason: 'x'.repeat(1000) })).toMatchObject({
        status: 'failed',
      });
      expect(await refund('requested', { failure_reason: 'lần trước' })).toMatchObject({
        status: 'requested',
        failure_reason: 'lần trước',
      });
      expect(await refund('done', { failure_reason: 'lần trước' })).toMatchObject({
        status: 'done',
      });
    });

    it('requested không có next_attempt_at: mặc định NULL, không còn CHECK', async () => {
      expect(await refund('requested')).toMatchObject({
        status: 'requested',
        next_attempt_at: null,
      });
      expect(
        await q(
          `SELECT conname FROM pg_constraint
           WHERE conrelid = 'refunds'::regclass AND conname = 'refunds_next_attempt_check'`,
        ),
      ).toEqual([]);
    });

    it('done vẫn cần mã hoàn (0028 giữ), mã vẫn UNIQUE', async () => {
      const e = await rejection(
        q(
          `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, completed_at)
           VALUES ($1, 'account_closure', 1000, 'done', now())`,
          [await topUp()],
        ),
      );
      expect(e.constraint).toBe('refunds_gateway_refund_no_check');
      const a = await refund('done');
      const dup = await rejection(
        q(
          `INSERT INTO refunds (top_up_id, kind, amount_vnd, status, completed_at, gateway_refund_no)
           SELECT $1, 'account_closure', 1000, 'done', now(), gateway_refund_no
           FROM refunds WHERE id = $2`,
          [await topUp(), a['id']],
        ),
      );
      expect(dup.constraint).toBe('refunds_gateway_refund_no_key');
    });

    it('COMMENT theo luồng thủ công', async () => {
      const comment = async (col: string) =>
        String(
          (
            await one(
              `SELECT col_description('refunds'::regclass,
                 (SELECT attnum FROM pg_attribute WHERE attrelid = 'refunds'::regclass
                  AND attname = $1)) AS c`,
              [col],
            )
          )['c'],
        );
      expect(await comment('gateway_refund_no')).toContain('cổng merchant');
      expect(await comment('completed_at')).toContain('Admin ghi nhận');
      expect(await comment('failure_reason')).toContain('Bắt buộc khi failed');
      expect(await comment('next_attempt_at')).toContain('Không dùng từ 0032');
    });
  });
});
