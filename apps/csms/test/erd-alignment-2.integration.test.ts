/**
 * Test tích hợp migration 0013 (BE-16, đợt 2): C1 độ dài VARCHAR(n) và C2 cột created_at/updated_at.
 *
 * Vì sao tồn tại: đổi kiểu text → varchar(n) ghi lại cả bảng và có thể làm hỏng dữ liệu cũ dài hơn;
 * thêm updated_at chỉ có ích nếu mọi nơi UPDATE đều cập nhật nó — Drizzle `$onUpdate` chỉ phủ
 * `db.update()`, còn SQL thô phải tự đặt `updated_at = now()`. Test chạy trên Postgres thật:
 *
 *   1. Đường nâng cấp: DB ở 0012 có dữ liệu → 0013; dữ liệu quá dài làm migration DỪNG (không đổi gì).
 *   2. C1: 48 cột đúng độ dài; vượt độ dài bị Postgres từ chối (22001); hai CHECK ≤ 20 đã được thay.
 *   3. C2: cột có mặt, NOT NULL DEFAULT now(); `$onUpdate` hoạt động; quét mã nguồn: không UPDATE
 *      thô nào lên bảng có updated_at mà quên cột này.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, Db } from '../src/db/db.module.js';
import { connectors } from '../src/db/schema/index.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const VARCHAR_TABLE: [string, string, number][] = [
  ['users', 'email', 254],
  ['users', 'phone_number', 16],
  ['drivers', 'consent_version', 20],
  ['operators', 'tax_code', 14],
  ['sites', 'site_code', 20],
  ['charge_points', 'serial_number', 25],
  ['charge_points', 'display_code', 100],
  ['charge_points', 'model', 20],
  ['charge_points', 'firmware_version', 50],
  ['charge_points', 'free_vend_tag', 20],
  ['connector_status_events', 'error_code', 30],
  ['connector_status_events', 'vendor_error_code', 50],
  ['connector_status_events', 'info', 50],
  ['remote_commands', 'action', 40],
  ['remote_commands', 'idempotency_key', 64],
  ['fault_events', 'error_code', 50],
  ['policy_templates', 'template_code', 30],
  ['policy_templates', 'template_type', 30],
  ['promotions', 'promotion_code', 20],
  ['sessions', 'id_tag', 20],
  ['sessions', 'stop_reason', 20],
  ['session_status_history', 'event', 50],
  ['session_status_history', 'actor', 50],
  ['meter_values', 'measurand', 40],
  ['meter_values', 'unit', 20],
  ['meter_values', 'context', 20],
  ['meter_values', 'phase', 10],
  ['vehicles', 'plate_number', 12],
  ['rfid_cards', 'card_identifier', 20],
  ['top_ups', 'gateway_reference', 100],
  ['top_ups', 'idempotency_key', 64],
  ['top_ups', 'gateway_transaction_no', 20],
  ['top_ups', 'late_gateway_ref', 100],
  ['e_invoices', 'invoice_no', 20],
  ['ocpp_message_log', 'unique_id', 36],
  ['ocpp_message_log', 'action', 40],
  ['charge_point_connections', 'remote_address', 64],
  ['driver_charge_intents', 'id_tag', 20],
  ['driver_charge_intents', 'idempotency_key', 64],
  ['driver_charge_intents', 'request_hash', 64],
  ['driver_charge_intents', 'state', 20],
  ['driver_stop_intents', 'idempotency_key', 64],
  ['driver_stop_intents', 'state', 20],
  ['driver_stop_attempts', 'kind', 20],
  ['driver_charge_intent_events', 'event', 50],
  ['charge_settlement_jobs', 'state', 20],
  ['charge_settlement_jobs', 'reason', 50],
  ['charge_settlement_jobs', 'last_error_code', 50],
];

/** [bảng, created_at thêm ở 0013?, updated_at thêm ở 0013?] */
const AUDIT_ADDED: [string, boolean, boolean][] = [
  ['operators', false, true],
  ['sites', false, true],
  ['connectors', true, true],
  ['remote_commands', false, true],
  ['fault_events', false, true],
  ['fault_reports', false, true],
  ['maintenance_tickets', false, true],
  ['tariff_periods', true, true],
  ['promotions', true, true],
  ['reservations', false, true],
  ['vehicles', false, true],
  ['vehicle_models', true, true],
  ['rfid_cards', false, true],
  ['session_pauses', false, true],
  ['session_tariff_segments', true, false],
  ['reconciliation_records', false, true],
  ['top_ups', false, true],
  ['e_invoices', false, true],
  ['driver_stop_intents', true, true],
  ['driver_charge_intents', false, true],
  ['charge_settlement_jobs', true, false],
];

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

async function rejection(p: Promise<unknown>): Promise<PgError> {
  try {
    await p;
  } catch (err) {
    return err as PgError;
  }
  throw new Error('kỳ vọng Postgres từ chối nhưng câu lệnh đã chạy được');
}

/** Mọi file .ts không phải spec trong src/. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describeDb('migration 0013 — C1 VARCHAR(n) và C2 created_at/updated_at', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};
  const id = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))['id']);
  const MIG = '0013_erd-alignment-varchar-audit';

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  async function buildAt0012(): Promise<void> {
    await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await q(
      'CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of listMigrations().filter((n) => n < MIG)) {
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
      await q('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    }
  }

  describe('đường nâng cấp (DB ở 0012 có dữ liệu)', () => {
    let cp: number;
    beforeAll(async () => {
      await buildAt0012();
      cp = await id(`INSERT INTO charge_points (serial_number) VALUES ('UP-13') RETURNING id`);
      await q(`INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1,1)`, [cp]);
      await q(`INSERT INTO users (email, full_name, role) VALUES ('up13@t','U','driver')`);
      // Dữ liệu quá dài mà text cũ cho phép: free_vend_tag 25 ký tự (> varchar(20)).
      await q(`UPDATE charge_points SET free_vend_tag = repeat('x', 25) WHERE id = $1`, [cp]);
    });

    it('dừng rõ ràng, không đổi gì, khi có giá trị dài hơn độ dài mới', async () => {
      const client = await db.$client.connect();
      try {
        const err = await rejection(
          client.query(readFileSync(path.join(MIGRATIONS_DIR, `${MIG}.sql`), 'utf8')),
        );
        expect(err.message).toContain('0013/C1');
        expect(err.message).toContain('charge_points.free_vend_tag: dài nhất 25 > varchar(20)');
        await client.query('ROLLBACK'); // BEGIN tường minh trong file
      } finally {
        client.release();
      }
      const col = await one(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'charge_points' AND column_name = 'free_vend_tag'`,
      );
      expect(col['data_type']).toBe('text'); // chưa đổi gì
      const upd = await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name='operators' AND column_name='updated_at'`,
      );
      expect(upd).toEqual([]);
    });

    it('sau khi xử lý tay dữ liệu, migrate áp 0013; dữ liệu cũ còn nguyên; dòng cũ có created/updated', async () => {
      await q(`UPDATE charge_points SET free_vend_tag = 'FREE-VEND' WHERE id = $1`, [cp]);
      expect(await migrate(db.$client)).toEqual([MIG]);
      expect(
        (await one('SELECT free_vend_tag FROM charge_points WHERE id=$1', [cp]))['free_vend_tag'],
      ).toBe('FREE-VEND');
      const c = await one(
        'SELECT created_at, updated_at FROM connectors WHERE charge_point_id=$1',
        [cp],
      );
      expect(c['created_at']).toBeInstanceOf(Date);
      expect(c['updated_at']).toBeInstanceOf(Date);
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('trên DB sạch (0000 → 0013)', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('C1: đủ 48 cột, đúng varchar(n)', async () => {
      expect(VARCHAR_TABLE).toHaveLength(48);
      const rows = await q(
        `SELECT table_name t, column_name c, data_type d, character_maximum_length l
         FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const have = new Map(rows.map((r) => [`${String(r['t'])}.${String(r['c'])}`, r]));
      const wrong = VARCHAR_TABLE.filter(([t, c, n]) => {
        const r = have.get(`${t}.${c}`);
        return !r || r['d'] !== 'character varying' || Number(r['l']) !== n;
      }).map(([t, c, n]) => `${t}.${c} != varchar(${n})`);
      expect(wrong).toEqual([]);
    });

    it('C1: văn bản tự do giữ text (ví dụ users.full_name, sessions... ghi chú, reason)', async () => {
      const rows = await q(
        `SELECT table_name t, column_name c, data_type d FROM information_schema.columns
         WHERE table_schema='public' AND ((table_name='users' AND column_name IN ('full_name','password_hash'))
            OR (table_name='invoice_adjustments' AND column_name='reason')
            OR (table_name='sites' AND column_name IN ('site_name','address')))`,
      );
      expect(rows.length).toBe(5);
      expect(rows.every((r) => r['d'] === 'text')).toBe(true);
    });

    it('C1: hai CHECK char_length ≤ 20 đã được thay bằng kiểu VARCHAR(20)', async () => {
      const gone = await q(
        `SELECT conname FROM pg_constraint WHERE conname IN
         ('rfid_cards_card_identifier_check','driver_charge_intents_id_tag_check')`,
      );
      expect(gone).toEqual([]);
    });

    const reject = (sql: string) => rejection(q(sql));

    it('C1: vượt độ dài bị Postgres từ chối (22001) — một ca cho mỗi nhóm nguồn', async () => {
      // [RFC] email
      expect(
        (
          await reject(
            `INSERT INTO users (email, full_name, role) VALUES (repeat('a',255), 'x', 'driver')`,
          )
        ).code,
      ).toBe('22001');
      // [OCPP] serial CiString25
      expect(
        (await reject(`INSERT INTO charge_points (serial_number) VALUES (repeat('s',26))`)).code,
      ).toBe('22001');
      // thay CHECK ≤ 20 của rfid_cards
      expect(
        (
          await reject(
            `INSERT INTO rfid_cards (card_identifier, card_kind) VALUES (repeat('c',21), 'online')`,
          )
        ).code,
      ).toBe('22001');
      await q(
        `INSERT INTO rfid_cards (card_identifier, card_kind) VALUES (repeat('c',20), 'online')`,
      );
      // [VNPay] vnp_TxnRef 100
      const driver = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('c1@t','x','driver') RETURNING id`,
      );
      await q(
        `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1,'v1',now())`,
        [driver],
      );
      const acc = await id('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [
        driver,
      ]);
      expect(
        (
          await rejection(
            q(
              `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd, idempotency_key, expires_at)
               VALUES (repeat('g',101), $1, 1000, 1000, 'k', now() + interval '15 minutes')`,
              [acc],
            ),
          )
        ).code,
      ).toBe('22001');
      // [OCPP-J] UniqueId 36 — bảng partition ocpp_message_log: kiểu lan xuống partition
      const cp = await id(
        `INSERT INTO charge_points (serial_number) VALUES ('C1-LOG') RETURNING id`,
      );
      const log = (uid: string) =>
        q(
          `INSERT INTO ocpp_message_log (charge_point_id, epoch, direction, message_type, unique_id, action, raw)
           VALUES ($1, 1, 'in', 2, $2, 'Heartbeat', '[]')`,
          [cp, uid],
        );
      expect((await rejection(log('u'.repeat(37)))).code).toBe('22001');
      await log('u'.repeat(36));
    });

    it('C1: meter_values (partition) — measurand ≤ 40, partition con cũng đổi kiểu', async () => {
      const rows = await q(
        `SELECT table_name t, character_maximum_length l FROM information_schema.columns
         WHERE table_schema='public' AND table_name LIKE 'meter_values%' AND column_name='measurand'`,
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(new Set(rows.map((r) => Number(r['l'])))).toEqual(new Set([40]));
    });

    it.each(AUDIT_ADDED)(
      'C2: %s — cột kiểm toán thêm ở 0013 (created=%s, updated=%s)',
      async (t, c, u) => {
        const rows = await q(
          `SELECT column_name c, data_type d, is_nullable n, column_default df FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name IN ('created_at','updated_at')`,
          [t],
        );
        const by = new Map(rows.map((r) => [String(r['c']), r]));
        for (const [name, expected] of [
          ['created_at', c],
          ['updated_at', u],
        ] as const) {
          if (expected) {
            const r = by.get(name);
            expect(r?.['d']).toBe('timestamp with time zone');
            expect(r?.['n']).toBe('NO');
            expect(String(r?.['df'])).toMatch(/now\(\)/);
          }
        }
        // Quy tắc của Ân: bảng nào cũng có thời điểm tạo (created_at hoặc cột sự kiện) — ở đây ít nhất một
        // trong hai cột kiểm toán có mặt.
        expect(by.size).toBeGreaterThan(0);
      },
    );

    it('C2: Drizzle $onUpdate đặt updated_at khi db.update() (connectors)', async () => {
      const cp = await id(
        `INSERT INTO charge_points (serial_number) VALUES ('C2-ON') RETURNING id`,
      );
      const cn = await id(
        `INSERT INTO connectors (charge_point_id, connector_no, status_changed_at, created_at, updated_at)
         VALUES ($1, 1, NULL, now() - interval '1 day', now() - interval '1 day') RETURNING id`,
        [cp],
      );
      const before = (await one('SELECT updated_at FROM connectors WHERE id=$1', [cn]))[
        'updated_at'
      ] as Date;
      await db.update(connectors).set({ status: 'Available' }).where(eq(connectors.id, cn));
      const after = (await one('SELECT updated_at FROM connectors WHERE id=$1', [cn]))[
        'updated_at'
      ] as Date;
      expect(after.getTime()).toBeGreaterThan(before.getTime() + 3_600_000);
    });

    it('C2: mọi UPDATE thô trong src/ lên bảng có cột updated_at đều đặt updated_at', async () => {
      const withUpdatedAt = new Set(
        (
          await q(
            `SELECT table_name t FROM information_schema.columns
             WHERE table_schema='public' AND column_name='updated_at'`,
          )
        ).map((r) => String(r['t'])),
      );
      const srcDir = path.join(__dirname, '..', 'src');
      const missing: string[] = [];
      let checked = 0;
      for (const file of sourceFiles(srcDir)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?<!ON CONFLICT DO )\bUPDATE\s+([a-z_]+)\s+SET\b/gi)) {
          const table = String(m[1]).toLowerCase();
          if (!withUpdatedAt.has(table)) continue;
          // Phạm vi câu lệnh: tới ký tự đóng chuỗi (backtick hoặc nháy) đã mở ngay trước UPDATE.
          // Không cắt ở WHERE vì WHERE có thể nằm trong subselect của mệnh đề SET.
          const before = text.slice(0, m.index ?? 0).trimEnd();
          const quote = before.charAt(before.length - 1);
          const rest = text.slice((m.index ?? 0) + m[0].length);
          const end = '`"\''.includes(quote) ? rest.indexOf(quote) : -1;
          const stmt = rest.slice(0, end < 0 ? 700 : end);
          checked++;
          if (!/updated_at/i.test(stmt)) {
            missing.push(
              `${path.relative(srcDir, file)}: UPDATE ${table} SET … (thiếu updated_at)`,
            );
          }
        }
      }
      expect(checked).toBeGreaterThan(5);
      expect(missing).toEqual([]);
    });
  });
});
