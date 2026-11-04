/**
 * Test tích hợp migration 0010–0012 (BE-16): đồng bộ CSDL với Physical ERD v1.0.
 *
 * Vì sao tồn tại: ba migration này đổi FK target, quy tắc xoá, thêm bảng/cột/ràng buộc và index.
 * Mỗi thứ có thể hỏng âm thầm — migration chạy được trên DB sạch nhưng vỡ trên DB đã có dữ liệu,
 * hay RESTRICT/CASCADE gắn nhầm. Test chạy trên Postgres thật:
 *
 *   1. Đường nâng cấp: DB ở 0009 có dữ liệu → 0010 (enum, commit riêng) → 0011 → 0012;
 *      backfill `admins`, dữ liệu còn nguyên, B2 dừng rõ ràng khi reviewed_by không phải operator_staff.
 *   2. Ràng buộc mới trên DB sạch: A2 (admins), A3 (sessions.reservation_id), A4 (credit_transactions
 *      .reservation_id + CHECK), A6 (bỏ FK dư), C3 (CASCADE / RESTRICT, từng cái), B2 (reviewed_by).
 *   3. A5: mọi FK có index (truy vấn của Ân) — ngoại lệ nêu tường minh, kèm lý do.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, Db } from '../src/db/db.module.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const ENUM = '0010_erd-alignment-enum-reservation-fee';
const ADDITIVE = '0011_erd-alignment-additive';
const DELETE_RULES = '0012_erd-alignment-delete-rules-reviewer';

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Chờ promise bị Postgres từ chối; trả lỗi để kiểm code/constraint/message. */
async function rejection(p: Promise<unknown>): Promise<PgError> {
  try {
    await p;
  } catch (err) {
    return err as PgError;
  }
  throw new Error('kỳ vọng Postgres từ chối nhưng câu lệnh đã chạy được');
}

describeDb('migration 0010–0012 — ERD alignment (Physical ERD v1.0)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};
  const id = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))['id']);

  /** DROP SCHEMA rồi áp các migration có tên trong danh sách (theo thứ tự tên), ghi `_migrations`. */
  async function buildUpTo(lastName: string): Promise<void> {
    await q('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await q(
      'CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of listMigrations().filter((n) => n <= lastName)) {
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
      await q('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  // ---------------------------------------------------------------------------------------------
  // Dữ liệu dùng chung: dựng toàn bộ chuỗi cha–con tối thiểu để thử CASCADE/RESTRICT.
  // ---------------------------------------------------------------------------------------------
  interface World {
    adminId: number;
    staffId: number;
    driverId: number;
    operatorId: number;
    chargePointId: number;
    connectorId: number;
    sessionId: number;
    accountId: number;
  }
  let seq = 0;
  async function world(): Promise<World> {
    const n = ++seq;
    const adminId = await id(
      `INSERT INTO users (email, full_name, role) VALUES ('a${n}@erd.test','Admin','admin') RETURNING id`,
    );
    await q('INSERT INTO admins (user_id) VALUES ($1)', [adminId]);
    const driverId = await id(
      `INSERT INTO users (email, full_name, role) VALUES ('d${n}@erd.test','Driver','driver') RETURNING id`,
    );
    await q(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1,'v1',now())`,
      [driverId],
    );
    const operatorId = await id(
      `INSERT INTO operators (tax_code, legal_name) VALUES ('T${n}','Op ${n}') RETURNING id`,
    );
    const staffId = await id(
      `INSERT INTO users (email, full_name, role) VALUES ('s${n}@erd.test','Staff','operator_staff') RETURNING id`,
    );
    await q(
      `INSERT INTO operator_staff (user_id, operator_id, staff_role) VALUES ($1,$2,'manager')`,
      [staffId, operatorId],
    );
    const chargePointId = await id(
      `INSERT INTO charge_points (serial_number) VALUES ('SN-ERD-${n}') RETURNING id`,
    );
    const connectorId = await id(
      'INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1,1) RETURNING id',
      [chargePointId],
    );
    const sessionId = await newSession(connectorId, chargePointId, 1000 + n);
    const accountId = await id('INSERT INTO credit_accounts (driver_id) VALUES ($1) RETURNING id', [
      driverId,
    ]);
    return {
      adminId,
      staffId,
      driverId,
      operatorId,
      chargePointId,
      connectorId,
      sessionId,
      accountId,
    };
  }
  async function newSession(
    connectorId: number,
    chargePointId: number,
    meterStart: number,
    reservationId: number | null | 'no-column' = null,
  ): Promise<number> {
    // 'no-column': DB còn ở 0009, chưa có sessions.reservation_id.
    if (reservationId === 'no-column')
      return id(
        `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
                               cp_started_at, meter_start_wh)
         VALUES ($1,$2,1,'TAG','rfid','csms_billed', now(), $3) RETURNING id`,
        [connectorId, chargePointId, meterStart],
      );
    return id(
      `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
                             cp_started_at, meter_start_wh, reservation_id)
       VALUES ($1,$2,1,'TAG','rfid','csms_billed', now(), $3, $4) RETURNING id`,
      [connectorId, chargePointId, meterStart, reservationId],
    );
  }
  async function newReservation(w: World, status = 'fulfilled'): Promise<number> {
    return id(
      `INSERT INTO reservations (driver_id, connector_id, status, hold_mode, expires_at)
       VALUES ($1,$2,$3,'csms_only', now() + interval '1 hour') RETURNING id`,
      [w.driverId, w.connectorId, status],
    );
  }
  async function fkRule(table: string, constraint: string): Promise<string> {
    return String(
      (
        await one(
          `SELECT confdeltype AS t FROM pg_constraint
           WHERE conrelid = $1::regclass AND conname = $2 AND contype = 'f'`,
          [table, constraint],
        )
      )['t'],
    );
  }

  // ---------------------------------------------------------------------------------------------
  describe('đường nâng cấp (DB ở 0009 có dữ liệu → 0010, 0011, 0012)', () => {
    let adminA: number;
    let adminB: number;
    let staff: number;
    let sessionId: number;

    beforeAll(async () => {
      await buildUpTo('0009_bo-payment-mode-free');
      adminA = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('up.a@t','A','admin') RETURNING id`,
      );
      adminB = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('up.b@t','B','admin') RETURNING id`,
      );
      const driver = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('up.d@t','D','driver') RETURNING id`,
      );
      await q(
        `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1,'v1',now())`,
        [driver],
      );
      const op = await id(
        `INSERT INTO operators (tax_code, legal_name) VALUES ('UP1','Op') RETURNING id`,
      );
      staff = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('up.s@t','S','operator_staff') RETURNING id`,
      );
      await q(
        `INSERT INTO operator_staff (user_id, operator_id, staff_role) VALUES ($1,$2,'manager')`,
        [staff, op],
      );
      const cp = await id(`INSERT INTO charge_points (serial_number) VALUES ('UP-1') RETURNING id`);
      const cn = await id(
        'INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1,1) RETURNING id',
        [cp],
      );
      sessionId = await newSession(cn, cp, 5, 'no-column');
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type, reviewed_by, reviewed_at, resolution)
         VALUES ($1,1,'meter_gap',$2,now(),'ok')`,
        [sessionId, staff],
      );
      // Một bản ghi KHÔNG phải operator_staff duyệt sẽ được thêm riêng ở ca B2 bên dưới.
    });

    it('B2 dừng rõ ràng (và không áp 0012) khi reviewed_by không thuộc operator_staff', async () => {
      // Áp 0010 + 0011 thủ công; 0012 chạy riêng sau khi cố tình tạo dòng vi phạm.
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${ENUM}.sql`), 'utf8'));
      await q(readFileSync(path.join(MIGRATIONS_DIR, `${ADDITIVE}.sql`), 'utf8'));
      await q('INSERT INTO _migrations (name) VALUES ($1), ($2)', [ENUM, ADDITIVE]);
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type, reviewed_by, reviewed_at)
         VALUES ($1,2,'meter_gap',$2,now())`,
        [sessionId, adminA],
      );
      const client = await db.$client.connect();
      try {
        const err = await rejection(
          client.query(readFileSync(path.join(MIGRATIONS_DIR, `${DELETE_RULES}.sql`), 'utf8')),
        );
        expect(err.message).toMatch(/0012\/B2: 1 reconciliation_records/);
        await client.query('ROLLBACK'); // BEGIN tường minh trong file → phải ROLLBACK trên connection này
      } finally {
        client.release();
      }
      // Trạng thái cũ còn nguyên: FK vẫn trỏ users, quy tắc xoá chưa đổi.
      expect(
        (
          await one(
            `SELECT confrelid::regclass::text AS t FROM pg_constraint
             WHERE conname = 'reconciliation_records_reviewed_by_fkey'`,
          )
        )['t'],
      ).toBe('users');
      expect(await fkRule('session_pauses', 'session_pauses_session_id_fkey')).toBe('a');
    });

    it('sau khi xử lý tay dòng vi phạm, migrate áp 0012; admins backfill đúng; dữ liệu còn nguyên', async () => {
      await q(
        `UPDATE reconciliation_records SET reviewed_by = $1 WHERE record_no = 2 AND session_id = $2`,
        [staff, sessionId],
      );
      const applied = await migrate(db.$client);
      // Chỉ chốt phần của BE-16: migration thêm sau 0012 không được làm test này đỏ.
      expect(applied.slice(0, 1)).toEqual([DELETE_RULES]);
      const admins = (await q('SELECT user_id FROM admins ORDER BY user_id')).map((r) =>
        Number(r['user_id']),
      );
      expect(admins).toEqual([adminA, adminB].sort((a, b) => a - b));
      expect(Number((await one('SELECT count(*) AS n FROM users'))['n'])).toBe(4);
      expect(Number((await one('SELECT count(*) AS n FROM reconciliation_records'))['n'])).toBe(2);
      expect((await one('SELECT reservation_id FROM sessions'))['reservation_id']).toBeNull();
      // Chạy lại không áp gì.
      expect(await migrate(db.$client)).toEqual([]);
    });

    it('đường nâng cấp liền một mạch 0009 → 0012 (backfill admins ngay khi chưa có 0011 trước đó)', async () => {
      await buildUpTo('0009_bo-payment-mode-free');
      const a = await id(
        `INSERT INTO users (email, full_name, role) VALUES ('one.a@t','A','admin') RETURNING id`,
      );
      await q(`INSERT INTO users (email, full_name, role) VALUES ('one.d@t','D','driver')`);
      expect((await migrate(db.$client)).slice(0, 3)).toEqual([ENUM, ADDITIVE, DELETE_RULES]);
      expect((await q('SELECT user_id FROM admins')).map((r) => Number(r['user_id']))).toEqual([a]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ràng buộc trên DB sạch (0000 → 0012)', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    describe('A1 — enum credit_transaction_type', () => {
      it('có reservation_fee, ở cuối danh sách', async () => {
        const rows = await q(
          `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'credit_transaction_type'::regtype
           ORDER BY enumsortorder`,
        );
        expect(rows.map((r) => r['enumlabel'])).toEqual([
          'top_up',
          'session_debit',
          'refund',
          'adjustment',
          'reservation_fee',
        ]);
      });
    });

    describe('A2 — admins', () => {
      it('xoá user thì dòng admins bị xoá theo (ON DELETE CASCADE)', async () => {
        const w = await world();
        expect(
          Number((await one('SELECT count(*) n FROM admins WHERE user_id=$1', [w.adminId]))['n']),
        ).toBe(1);
        await q('DELETE FROM users WHERE id = $1', [w.adminId]);
        expect(
          Number((await one('SELECT count(*) n FROM admins WHERE user_id=$1', [w.adminId]))['n']),
        ).toBe(0);
      });

      it('từ chối user_id không tồn tại và trùng PK', async () => {
        const w = await world();
        const bad = await rejection(q('INSERT INTO admins (user_id) VALUES (999999999)'));
        expect(bad.code).toBe('23503');
        const dup = await rejection(q('INSERT INTO admins (user_id) VALUES ($1)', [w.adminId]));
        expect(dup.code).toBe('23505');
      });
    });

    describe('A3 — sessions.reservation_id UNIQUE (BR-P29)', () => {
      it('một reservation chỉ được một phiên; nhiều phiên không reservation vẫn được', async () => {
        const w = await world();
        const r = await newReservation(w);
        await newSession(w.connectorId, w.chargePointId, 2001, r);
        const dup = await rejection(newSession(w.connectorId, w.chargePointId, 2002, r));
        expect(dup.code).toBe('23505');
        expect(dup.constraint).toBe('sessions_reservation_id_key');
        await newSession(w.connectorId, w.chargePointId, 2003);
        await newSession(w.connectorId, w.chargePointId, 2004);
        const ghost = await rejection(newSession(w.connectorId, w.chargePointId, 2005, 999999999));
        expect(ghost.code).toBe('23503');
      });
    });

    describe('A4 — credit_transactions.reservation_id (BR-P27)', () => {
      const ins = (accountId: number, entry: number, type: string, reservationId: number | null) =>
        q(
          `INSERT INTO credit_transactions
             (credit_account_id, entry_no, transaction_type, amount_vnd, balance_after_vnd, reservation_id)
           VALUES ($1,$2,$3,-1000,0,$4)`,
          [accountId, entry, type, reservationId],
        );

      it('reservation_fee + reservation_id hợp lệ', async () => {
        const w = await world();
        await ins(w.accountId, 1, 'reservation_fee', await newReservation(w));
      });

      it('CHECK: reservation_fee thiếu reservation_id bị từ chối', async () => {
        const w = await world();
        const err = await rejection(ins(w.accountId, 1, 'reservation_fee', null));
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('credit_transactions_reservation_fee_check');
      });

      it('CHECK: loại khác mà có reservation_id bị từ chối', async () => {
        const w = await world();
        const r = await newReservation(w);
        const err = await rejection(ins(w.accountId, 1, 'adjustment', r));
        expect(err.code).toBe('23514');
        expect(err.constraint).toBe('credit_transactions_reservation_fee_check');
      });

      it('loại khác không có reservation_id vẫn hợp lệ (nhánh còn lại của CHECK)', async () => {
        const w = await world();
        await ins(w.accountId, 1, 'adjustment', null);
      });

      it('UNIQUE: mỗi reservation tối đa một khoản phí', async () => {
        const w = await world();
        const r = await newReservation(w);
        await ins(w.accountId, 1, 'reservation_fee', r);
        const err = await rejection(ins(w.accountId, 2, 'reservation_fee', r));
        expect(err.code).toBe('23505');
        expect(err.constraint).toBe('credit_transactions_reservation_id_key');
      });

      it('FK: reservation_id không tồn tại bị từ chối', async () => {
        const w = await world();
        const err = await rejection(ins(w.accountId, 1, 'reservation_fee', 999999999));
        expect(err.code).toBe('23503');
      });
    });

    describe('A6 — bỏ FK dư sessions_charge_point_id_fkey', () => {
      it('FK trực tiếp đã bỏ, FK tổng hợp còn và phủ charge_point_id; cột và JOIN vẫn chạy', async () => {
        expect(
          Number(
            (
              await one(
                `SELECT count(*) n FROM pg_constraint WHERE conname = 'sessions_charge_point_id_fkey'`,
              )
            )['n'],
          ),
        ).toBe(0);
        const cols = await q(
          `SELECT a.attname FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
           WHERE c.conname = 'sessions_connector_fk' ORDER BY a.attname`,
        );
        expect(cols.map((r) => r['attname'])).toEqual([
          'charge_point_id',
          'connector_id',
          'connector_no',
        ]);
        const w = await world();
        const joined = await one(
          `SELECT cp.serial_number AS s FROM sessions s JOIN charge_points cp ON cp.id = s.charge_point_id
           WHERE s.id = $1`,
          [w.sessionId],
        );
        expect(joined['s']).toMatch(/^SN-ERD-/);
      });

      it('toàn vẹn vẫn giữ: bộ ba súng lệch bị từ chối bởi FK tổng hợp', async () => {
        const w = await world();
        const other = await id(
          `INSERT INTO charge_points (serial_number) VALUES ('SN-OTHER') RETURNING id`,
        );
        const err = await rejection(newSession(w.connectorId, other, 7777));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('sessions_connector_fk');
      });
    });

    describe('C3 — quy tắc xoá: bảng đối chiếu pg_constraint', () => {
      const cascade: [string, string][] = [
        ['connectors', 'connectors_charge_point_id_fkey'],
        ['connector_status_events', 'connector_status_events_charge_point_id_fkey'],
        ['tariff_periods', 'tariff_periods_operator_id_fkey'],
        ['session_pauses', 'session_pauses_session_id_fkey'],
      ];
      const restrict: [string, string][] = [
        ['credit_transactions', 'credit_transactions_credit_account_id_fkey'],
        ['loyalty_transactions', 'loyalty_transactions_loyalty_account_id_fkey'],
        ['invoice_adjustments', 'invoice_adjustments_e_invoice_id_fkey'],
        ['meter_values', 'meter_values_session_id_fkey'],
        ['reconciliation_records', 'reconciliation_records_session_id_fkey'],
        ['session_tariff_segments', 'session_tariff_segments_session_id_fkey'],
        ['session_status_history', 'session_status_history_session_id_fkey'], // từ 0001, không đổi
      ];
      it.each(cascade)('%s (%s) = CASCADE', async (t, c) => {
        expect(await fkRule(t, c)).toBe('c');
      });
      it.each(restrict)('%s (%s) = RESTRICT', async (t, c) => {
        expect(await fkRule(t, c)).toBe('r');
      });

      it('meter_values: FK trên bảng cha lan xuống mọi partition với cùng quy tắc RESTRICT', async () => {
        const rows = await q(
          `SELECT conrelid::regclass::text AS t, confdeltype AS d FROM pg_constraint
           WHERE contype = 'f' AND conname = 'meter_values_session_id_fkey'`,
        );
        expect(rows.length).toBeGreaterThan(1); // cha + các partition
        expect(new Set(rows.map((r) => r['d']))).toEqual(new Set(['r']));
      });

      it('mọi FK khác trong schema public KHÔNG bị đổi sang CASCADE/RESTRICT ngoài danh sách trên', async () => {
        const listed = new Set([...cascade, ...restrict].map(([, c]) => c));
        const rows = await q(
          `SELECT conname, confdeltype AS d FROM pg_constraint c
           WHERE contype = 'f' AND confdeltype <> 'a' AND conparentid = 0`,
        );
        const unexpected = rows
          .filter((r) => !listed.has(String(r['conname'])))
          .map((r) => `${String(r['conname'])}=${String(r['d'])}`);
        // ON DELETE CASCADE có sẵn từ trước: drivers/operator_staff/admins → users.
        expect(unexpected.sort()).toEqual([
          'admins_user_id_fkey=c',
          'drivers_user_id_fkey=c',
          'operator_staff_user_id_fkey=c',
        ]);
      });
    });

    describe('C3 — hành vi CASCADE', () => {
      it('xoá charge point xoá connectors và connector_status_events của nó', async () => {
        const cp = await id(
          `INSERT INTO charge_points (serial_number) VALUES ('SN-CASC') RETURNING id`,
        );
        await q('INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1,1),($1,2)', [
          cp,
        ]);
        await q(
          `INSERT INTO connector_status_events (charge_point_id, connector_no, status) VALUES ($1,0,'Available')`,
          [cp],
        );
        await q('DELETE FROM charge_points WHERE id = $1', [cp]);
        expect(
          Number(
            (await one('SELECT count(*) n FROM connectors WHERE charge_point_id=$1', [cp]))['n'],
          ),
        ).toBe(0);
        expect(
          Number(
            (
              await one('SELECT count(*) n FROM connector_status_events WHERE charge_point_id=$1', [
                cp,
              ])
            )['n'],
          ),
        ).toBe(0);
      });

      it('xoá operator xoá tariff_periods của nó', async () => {
        const w = await world();
        await q(
          `INSERT INTO tariff_periods (operator_id, band, time_start, time_end, price_per_kwh_vnd, effective_from)
           VALUES ($1,'normal','00:00','12:00',3000,'2026-01-01')`,
          [w.operatorId],
        );
        // operator_staff giữ FK thường tới operators → phải dọn trước (không phải thành phần cấu thành).
        await q('DELETE FROM operator_staff WHERE operator_id = $1', [w.operatorId]);
        await q('DELETE FROM operators WHERE id = $1', [w.operatorId]);
        expect(
          Number(
            (
              await one('SELECT count(*) n FROM tariff_periods WHERE operator_id=$1', [
                w.operatorId,
              ])
            )['n'],
          ),
        ).toBe(0);
      });

      it('xoá session xoá session_pauses của nó (khi phiên chưa có dòng tiền/kiểm toán)', async () => {
        const w = await world();
        await q(
          `INSERT INTO session_pauses (session_id, paused_at, pause_cause) VALUES ($1, now(), 'ev')`,
          [w.sessionId],
        );
        await q('DELETE FROM sessions WHERE id = $1', [w.sessionId]);
        expect(
          Number(
            (await one('SELECT count(*) n FROM session_pauses WHERE session_id=$1', [w.sessionId]))[
              'n'
            ],
          ),
        ).toBe(0);
      });

      it('FK thường vẫn chặn: xoá charge point còn phiên (sessions → connectors) bị từ chối', async () => {
        const w = await world();
        const err = await rejection(
          q('DELETE FROM charge_points WHERE id = $1', [w.chargePointId]),
        );
        expect(err.code).toBe('23503'); // connectors cascade, rồi sessions_connector_fk (NO ACTION) chặn
      });
    });

    describe('C3 — hành vi RESTRICT (cha đóng bằng trạng thái, không xoá)', () => {
      it('credit_accounts có credit_transactions: không xoá được', async () => {
        const w = await world();
        await q(
          `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd, balance_after_vnd)
           VALUES ($1,1,'adjustment',1000,1000)`,
          [w.accountId],
        );
        const err = await rejection(q('DELETE FROM credit_accounts WHERE id = $1', [w.accountId]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('credit_transactions_credit_account_id_fkey');
      });

      it('loyalty_accounts có loyalty_transactions: không xoá được', async () => {
        const w = await world();
        const acc = await id('INSERT INTO loyalty_accounts (driver_id) VALUES ($1) RETURNING id', [
          w.driverId,
        ]);
        await q(
          `INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points)
           VALUES ($1,1,'earn',10)`,
          [acc],
        );
        const err = await rejection(q('DELETE FROM loyalty_accounts WHERE id = $1', [acc]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('loyalty_transactions_loyalty_account_id_fkey');
      });

      it('e_invoices có invoice_adjustments: không xoá được', async () => {
        const w = await world();
        const topUp = await id(
          `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, amount_paid_vnd, idempotency_key, expires_at)
           VALUES ('GW-${w.accountId}', $1, 1000, 1000, 'idem-${w.accountId}', now() + interval '15 minutes') RETURNING id`,
          [w.accountId],
        );
        const inv = await id(
          'INSERT INTO e_invoices (top_up_id, amount_vnd, vat_amount_vnd) VALUES ($1,1000,100) RETURNING id',
          [topUp],
        );
        await q(
          `INSERT INTO invoice_adjustments (e_invoice_id, adjustment_no, reason, amount_vnd) VALUES ($1,1,'sai MST',-100)`,
          [inv],
        );
        const err = await rejection(q('DELETE FROM e_invoices WHERE id = $1', [inv]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('invoice_adjustments_e_invoice_id_fkey');
      });

      it('sessions có meter_values (bảng partition): không xoá được', async () => {
        const w = await world();
        await q(
          `INSERT INTO meter_values (session_id, cp_timestamp, measurand, value, received_at)
           VALUES ($1, now(), 'Energy.Active.Import.Register', 1.5, now())`,
          [w.sessionId],
        );
        const err = await rejection(q('DELETE FROM sessions WHERE id = $1', [w.sessionId]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('meter_values_session_id_fkey');
      });

      it('sessions có reconciliation_records: không xoá được', async () => {
        const w = await world();
        await q(
          `INSERT INTO reconciliation_records (session_id, record_no, record_type) VALUES ($1,1,'duplicate')`,
          [w.sessionId],
        );
        const err = await rejection(q('DELETE FROM sessions WHERE id = $1', [w.sessionId]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('reconciliation_records_session_id_fkey');
      });

      it('sessions có session_tariff_segments: không xoá được', async () => {
        const w = await world();
        const period = await id(
          `INSERT INTO tariff_periods (operator_id, band, time_start, time_end, price_per_kwh_vnd, effective_from)
           VALUES ($1,'peak','00:00','12:00',4000,'2026-01-01') RETURNING id`,
          [w.operatorId],
        );
        await q(
          `INSERT INTO session_tariff_segments (session_id, tariff_period_id, segment_start, segment_end, energy_wh, amount_vnd)
           VALUES ($1,$2, now(), now(), 100, 400)`,
          [w.sessionId, period],
        );
        const err = await rejection(q('DELETE FROM sessions WHERE id = $1', [w.sessionId]));
        expect(err.code).toBe('23503');
        expect(err.constraint).toBe('session_tariff_segments_session_id_fkey');
      });

      it('xoá con trước rồi xoá cha thì được (hướng dẫn dọn dẹp cho test/seed)', async () => {
        const w = await world();
        await q(
          `INSERT INTO reconciliation_records (session_id, record_no, record_type) VALUES ($1,1,'duplicate')`,
          [w.sessionId],
        );
        await q('DELETE FROM reconciliation_records WHERE session_id = $1', [w.sessionId]);
        await q('DELETE FROM sessions WHERE id = $1', [w.sessionId]);
      });
    });

    describe('B2 — reconciliation_records.reviewed_by → operator_staff (D14)', () => {
      const insertRecord = (sessionId: number, reviewer: number | null) =>
        q(
          `INSERT INTO reconciliation_records (session_id, record_no, record_type, reviewed_by, reviewed_at)
           VALUES ($1, 1, 'meter_gap', $2, CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END)`,
          [sessionId, reviewer],
        );

      it('FK trỏ operator_staff.user_id', async () => {
        expect(
          (
            await one(
              `SELECT confrelid::regclass::text AS t FROM pg_constraint
               WHERE conname = 'reconciliation_records_reviewed_by_fkey'`,
            )
          )['t'],
        ).toBe('operator_staff');
      });

      it('nhân viên vận hành duyệt được; chưa duyệt (NULL) vẫn được', async () => {
        const w = await world();
        await insertRecord(w.sessionId, w.staffId);
        const w2 = await world();
        await insertRecord(w2.sessionId, null);
      });

      it('admin hay tài xế (có trong users nhưng không phải operator_staff) bị từ chối', async () => {
        const w = await world();
        for (const who of [w.adminId, w.driverId]) {
          const err = await rejection(insertRecord(w.sessionId, who));
          expect(err.code).toBe('23503');
          expect(err.constraint).toBe('reconciliation_records_reviewed_by_fkey');
        }
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('A5 — mọi FK đều có index', () => {
    const FK_WITHOUT_INDEX = `
      SELECT c.conrelid::regclass::text AS tbl, c.conname FROM pg_constraint c
      WHERE c.contype = 'f' AND NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
          AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey
          AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] <@ c.conkey)
      ORDER BY 1, 2`;

    /**
     * Ngoại lệ tường minh — mỗi dòng có lý do; thêm dòng mới phải được người duyệt chấp nhận.
     * Truy vấn của Ân đòi index có CHÍNH bộ cột FK ở đầu; ba FK dưới đây không đạt mà có lý do.
     */
    const EXCEPTIONS: Record<string, string> = {
      // FK tổng hợp 3 cột; index sessions(connector_id, received_started_at) bắt đầu bằng connector_id
      // nên xoá/cập nhật connectors vẫn tra phiên con bằng index (Ân ghi nhận trong 0009 của bà).
      'sessions.sessions_connector_fk':
        'phủ bởi sessions_connector_id_received_started_at_idx (cột đầu connector_id)',
      // Bảng dẫn xuất, đề xuất thay bằng view (chưa duyệt) — không thêm index cho bảng có thể bị bỏ.
      'charging_statements.charging_statements_driver_id_fkey':
        'charging_statements có thể bị thay bằng view (đề xuất C của Ân, chưa duyệt)',
      // Cột refunded_by sẽ bị bỏ ở B5 (Khang, cùng bảng refunds) — không đánh index cho cột sắp bỏ.
      'top_ups.top_ups_refunded_by_fkey': 'cột refunded_by sẽ bị bỏ ở B5 (Khang)',
    };

    it('không FK nào thiếu index, ngoài ngoại lệ có lý do', async () => {
      await resetAndMigrate(db.$client);
      const missing = (await q(FK_WITHOUT_INDEX)).map(
        (r) => `${String(r['tbl'])}.${String(r['conname'])}`,
      );
      expect(missing.filter((m) => !(m in EXCEPTIONS))).toEqual([]);
    });

    it('ngoại lệ không bị lỗi thời: mỗi ngoại lệ vẫn thật sự thiếu index (bỏ khỏi danh sách khi đã có)', async () => {
      const missing = (await q(FK_WITHOUT_INDEX)).map(
        (r) => `${String(r['tbl'])}.${String(r['conname'])}`,
      );
      expect(Object.keys(EXCEPTIONS).filter((e) => !missing.includes(e))).toEqual([]);
    });

    it('20 index của 0011 có mặt (tên theo file của Ân)', async () => {
      const names = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map(
        (r) => String(r['indexname']),
      );
      const expected = [
        'fault_events_connector_id_idx',
        'fault_events_acknowledged_by_idx',
        'fault_events_reset_command_id_idx',
        'fault_reports_driver_id_idx',
        'fault_reports_cleared_by_idx',
        'maintenance_tickets_assigned_to_idx',
        'policy_templates_created_by_idx',
        'reconciliation_records_reviewed_by_idx',
        'remote_commands_requested_by_idx',
        'session_tariff_segments_tariff_period_id_idx',
        'sessions_vehicle_id_idx',
        'sessions_promotion_id_idx',
        'sessions_rfid_card_id_idx',
        'vehicles_vehicle_model_id_idx',
        'charge_tariff_boundary_evidence_recorded_by_idx',
        'driver_charge_intent_events_intent_id_idx',
        'driver_charge_intent_events_actor_id_idx',
        'driver_charge_intents_vehicle_id_idx',
        'driver_start_recoveries_operator_user_id_idx',
        'driver_stop_attempts_operator_user_id_idx',
      ];
      expect(expected).toHaveLength(20);
      expect(expected.filter((n) => !names.includes(n))).toEqual([]);
    });

    it('FK từ bảng partition: meter_values và ocpp_message_log được phủ (không cần ngoại lệ)', async () => {
      const rows = await q(
        `SELECT tbl FROM (${FK_WITHOUT_INDEX.replace('ORDER BY 1, 2', '')}) x
         WHERE tbl LIKE 'meter_values%' OR tbl LIKE 'ocpp_message_log%'`,
      );
      expect(rows).toEqual([]);
    });
  });
});
