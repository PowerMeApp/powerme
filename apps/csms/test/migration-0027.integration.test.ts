/**
 * Test tích hợp migration 0027 (T32 Phần 8c, WP5): bộ đếm `unfinished_claims` trên bốn bảng dùng
 * lease, giá trị enum `retry_exhausted` và CHECK `top_ups_exception_kind_status_check` mới.
 *
 * Vì sao tồn tại: hỏng âm thầm có thể là cột thiếu ở một bảng (`due-rows.ts` dùng chung cho cả bốn,
 * claimDue sẽ lỗi SQL ở bảng đó), cột cho NULL / âm, dòng cũ không nhận 0, CHECK mới để lọt
 * `retry_exhausted` trên `pending`, hoặc làm mất nhánh cũ (`unresolved_*`, `loyalty_error`). File
 * có hai transaction (enum phải COMMIT trước khi CHECK dùng), nên kiểm cả việc chạy lại.
 *
 * Phần 1: tĩnh. Phần 2: DB ngay trước 0027 (mọi migration có tên nhỏ hơn, gồm cả 0026 nếu đã có)
 * có dòng trên bốn bảng → migrate → nhận 0. Phần 3: DB sạch: ràng buộc, enum, schema TS.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì describe DB bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDb, Db } from '../src/db/db.module.js';
import { eInvoices, invoiceAdjustments, refunds, topUps } from '../src/db/schema/billing.js';
import { topUpExceptionKindEnum } from '../src/db/schema/enums.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0027 = '0027_dem-lan-giu-cho';
const BEFORE = listMigrations().filter((n) => n < M0027);
const AFTER = listMigrations().filter((n) => n > M0027);
const TABLES = ['top_ups', 'e_invoices', 'invoice_adjustments', 'refunds'] as const;

describe('migration 0027 — tĩnh', () => {
  it('chỉ một file mang số 0027, đứng sau 0025 (0026 để cho PR khác, có hay chưa đều được)', () => {
    expect(listMigrations().filter((n) => n.startsWith('0027'))).toEqual([M0027]);
    expect(BEFORE).toContain('0025_e-invoice-vat-rate');
  });
});

describeDb('migration 0027 — unfinished_claims, retry_exhausted (T32 Phần 8c)', () => {
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

  /** Tài xế + tài khoản mới, trả credit_account_id. */
  async function account(): Promise<number> {
    seq += 1;
    const user = (
      await one(
        `INSERT INTO users (email, full_name, role) VALUES ($1, 'X', 'driver') RETURNING id`,
        [`m27-${seq}@t`],
      )
    )['id'];
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
      [user],
    );
    return Number(
      (await one('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [user]))['id'],
    );
  }

  /** Top-up với status / exception_kind cho trước (ghi thẳng bằng SQL). */
  async function topUp(status: string, exceptionKind: string | null = null): Promise<number> {
    const acc = await account();
    seq += 1;
    const credited = status === 'credited';
    return Number(
      (
        await one(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd,
             status, gateway_transaction_no, idempotency_key, expires_at, completed_at,
             exception_kind)
           VALUES ($1, $2, 100000, 100000, $3::top_up_status, $4, $5,
             now() + interval '15 minutes', CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
             $6::top_up_exception_kind)
           RETURNING id`,
          [
            `M27REF${seq}`,
            acc,
            status,
            credited ? String(97_000_000 + seq) : null,
            `m27-key-${seq}`,
            exceptionKind,
          ],
        )
      )['id'],
    );
  }

  it('nâng cấp DB có dòng trên bốn bảng: dòng cũ nhận 0, cột khác giữ nguyên; chạy lại không áp gì', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await db.$client.query(
      `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO _migrations (name) VALUES ${BEFORE.map((n) => `('${n}')`).join(', ')};`,
    );
    await topUp('pending');
    const t = await topUp('credited');
    const inv = (
      await one(
        `INSERT INTO e_invoices (top_up_id, amount_vnd, vat_rate, vat_amount_vnd)
         VALUES ($1, 100000, 8, 7407) RETURNING id`,
        [t],
      )
    )['id'];
    await q(
      `INSERT INTO invoice_adjustments (e_invoice_id, adjustment_no, reason, amount_vnd)
       VALUES ($1, 1, 'r', -1000)`,
      [inv],
    );
    await q(
      `INSERT INTO refunds (top_up_id, kind, amount_vnd) VALUES ($1, 'account_closure', 1000)`,
      [t],
    );
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const table of TABLES)
        out[table] = await q(
          `SELECT id, status::text, next_attempt_at, updated_at FROM ${table} ORDER BY id`,
        );
      return out;
    };
    const before = await snapshot();

    expect(await migrate(db.$client)).toEqual([M0027, ...AFTER]);
    expect(await snapshot()).toEqual(before);
    for (const table of TABLES)
      expect(await q(`SELECT DISTINCT unfinished_claims FROM ${table}`)).toEqual([
        { unfinished_claims: 0 },
      ]);
    expect(await migrate(db.$client)).toEqual([]);
  });

  it('chạy lại file 0027 khi khối enum đã commit (khối 2 lỗi lần trước): IF NOT EXISTS không lỗi', async () => {
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    for (const name of BEFORE)
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
    await q(`ALTER TYPE top_up_exception_kind ADD VALUE 'retry_exhausted'`);
    await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, `${M0027}.sql`), 'utf8'));
    expect(await one(`SELECT 'retry_exhausted'::top_up_exception_kind::text AS v`)).toEqual({
      v: 'retry_exhausted',
    });
  });

  describe('DB sạch (0000 → mới nhất): ràng buộc, enum và schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('bốn bảng có unfinished_claims integer NOT NULL DEFAULT 0', async () => {
      const cols = await q(
        `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE column_name = 'unfinished_claims' ORDER BY table_name`,
      );
      expect(cols).toEqual(
        [...TABLES].sort().map((table_name) => ({
          table_name,
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: '0',
        })),
      );
    });

    it('CHECK <bảng>_unfinished_claims_check từ chối số âm, nhận 0', async () => {
      const t = await topUp('pending');
      await q('UPDATE top_ups SET unfinished_claims = 0 WHERE id = $1', [t]);
      await expect(
        q('UPDATE top_ups SET unfinished_claims = -1 WHERE id = $1', [t]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'top_ups_unfinished_claims_check' });
      for (const table of TABLES)
        expect(
          await one(
            `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
             WHERE conname = $1`,
            [`${table}_unfinished_claims_check`],
          ),
        ).toEqual({ d: 'CHECK ((unfinished_claims >= 0))' });
    });

    it('enum có retry_exhausted; CHECK nhận retry_exhausted + expired, từ chối + pending / credited', async () => {
      const labels = await q(
        `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'top_up_exception_kind'::regtype
         ORDER BY enumsortorder`,
      );
      expect(labels.map((r) => r['enumlabel'])).toEqual([
        'unresolved_04',
        'unresolved_07',
        'loyalty_error',
        'retry_exhausted',
      ]);
      await topUp('expired', 'retry_exhausted');
      for (const status of ['pending', 'credited', 'failed'])
        await expect(topUp(status, 'retry_exhausted')).rejects.toMatchObject({
          code: '23514',
          constraint: 'top_ups_exception_kind_status_check',
        });
    });

    it('nhánh cũ của CHECK giữ nguyên: unresolved_* chỉ expired, loyalty_error chỉ credited / refunded', async () => {
      await topUp('expired', 'unresolved_04');
      await topUp('expired', 'unresolved_07');
      await topUp('credited', 'loyalty_error');
      await expect(topUp('pending', 'unresolved_04')).rejects.toMatchObject({ code: '23514' });
      await expect(topUp('expired', 'loyalty_error')).rejects.toMatchObject({ code: '23514' });
    });

    it('COMMENT ghi bộ đếm và lịch querydr mới', async () => {
      const col = async (table: string, column: string) =>
        String(
          (
            await one(
              `SELECT col_description($1::regclass,
                 (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2))
               AS c`,
              [table, column],
            )
          )['c'],
        );
      expect(await col('top_ups', 'unfinished_claims')).toContain('retry_exhausted');
      expect(await col('e_invoices', 'unfinished_claims')).toContain('needs_review');
      expect(await col('top_ups', 'next_attempt_at')).toContain('15, 30, 45, 60');
    });

    it('schema TS khai khớp: unfinishedClaims trên bốn bảng, CHECK cùng tên, enum có retry_exhausted', () => {
      for (const table of [topUps, eInvoices, invoiceAdjustments, refunds]) {
        const cfg = getTableConfig(table);
        const col = cfg.columns.find((c) => c.name === 'unfinished_claims')!;
        expect(col.getSQLType()).toBe('integer');
        expect(col.notNull).toBe(true);
        expect(col.default).toBe(0);
        expect(cfg.checks.map((c) => c.name)).toContain(`${cfg.name}_unfinished_claims_check`);
      }
      expect(topUpExceptionKindEnum.enumValues).toContain('retry_exhausted');
    });
  });
});
