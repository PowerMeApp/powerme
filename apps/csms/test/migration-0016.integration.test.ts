/**
 * Test tích hợp migration 0016 (BE-23 / T110): bỏ thẻ RFID ví (`rfid_card_kind.wallet`) và
 * `payment_mode.station_wallet` theo quyết định T109.
 *
 * Vì sao tồn tại: 0016 đổi dữ liệu cũ (phiên station_wallet → unattributed, thẻ wallet → online)
 * rồi tạo lại hai kiểu enum. Hỏng âm thầm có thể là: mất dòng phiên / meter / đối soát, đổi nhầm
 * phiên không phải station_wallet, làm mất driver_id / status / origin, kiểu cũ còn sót lại, hoặc
 * schema TS (enums.ts) lệch với DB — và nhất là TRỪ TIỀN HAI LẦN: phiên station_wallet đã trả tại
 * trụ, sau 0016 là `unattributed` với thẻ `online`, nên console BE-24 (gán phiên unattributed cho
 * tài xế) sẽ cho gán nếu 0016 không ghi sẵn quyết định `UNATTRIBUTED_CLOSED`.
 *
 * Phần 1 dựng DB ở trạng thái ngay trước 0016 (mọi file `drizzle/` có tên nhỏ hơn `0016`) với
 * phiên ở cả ba payment_mode cũ và thẻ ở cả ba card_kind cũ, gọi helper `migrate` (cùng logic
 * scripts/migrate.mjs) qua một pg.Client để bắt NOTICE đếm dòng, rồi kiểm từng dòng. Phần 2 kiểm
 * DB sạch (0000 → mới nhất) và đối chiếu enums.ts với pg_enum.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createDb, Db } from '../src/db/db.module.js';
import { paymentModeEnum, rfidCardKindEnum } from '../src/db/schema/enums.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import {
  UnattributedSessionError,
  UnattributedSessionService,
} from '../src/sessions/unattributed-session.service.js';
import {
  listMigrations,
  MIGRATIONS_DIR,
  migrate,
  resetAndMigrate,
} from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const M0016 = '0016_bo-the-wallet-station-wallet';
const BEFORE_0016 = listMigrations().filter((n) => n < '0016');

/** DROP SCHEMA rồi dựng DB ở trạng thái ngay trước 0016 (có `_migrations` ghi các file đó). */
async function buildBefore0016(query: (sql: string) => Promise<unknown>): Promise<void> {
  await query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  for (const name of BEFORE_0016) {
    await query(readFileSync(path.join(MIGRATIONS_DIR, `${name}.sql`), 'utf8'));
  }
  await query(
    `CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
     INSERT INTO _migrations (name) VALUES ${BEFORE_0016.map((n) => `('${n}')`).join(', ')};`,
  );
}

describeDb('migration 0016 — bỏ thẻ wallet và payment_mode station_wallet (T110)', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};

  /** Nhãn enum theo thứ tự khai báo. */
  const enumValues = async (typname: string) =>
    (
      await q(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = $1 ORDER BY e.enumsortorder`,
        [typname],
      )
    ).map((r) => r['enumlabel']);

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  it('0016 là migration kế tiếp sau 0015 và chỉ có một file mang số 0016', () => {
    const names = listMigrations();
    expect(names).toContain(M0016);
    expect(names.filter((n) => n.startsWith('0016'))).toEqual([M0016]);
    expect(BEFORE_0016[BEFORE_0016.length - 1]).toBe('0015_billing-refunds-wf02');
  });

  describe('đường nâng cấp (DB ngay trước 0016, có phiên station_wallet và thẻ wallet)', () => {
    const OLD = new Date('2026-10-20T10:00:00Z');
    const ids: Record<string, number> = {};
    const notices: string[] = [];
    let applied: string[] = [];
    let before: Record<string, Record<string, unknown>> = {};

    beforeAll(async () => {
      await buildBefore0016((sql) => db.$client.query(sql));
      const driverId = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m16.driver@test', 'Tai Xe', 'driver')
             RETURNING id`,
          )
        )['id'],
      );
      await q(
        `INSERT INTO drivers (user_id, consent_version, consent_given_at) VALUES ($1, 'v1', now())`,
        [driverId],
      );
      ids['driver'] = driverId;
      await q(
        `INSERT INTO credit_accounts (driver_id, status, balance_vnd) VALUES ($1, 'active', 200000)`,
        [driverId],
      );
      // Operator, site và nhân viên vận hành để gọi UnattributedSessionService (quyền theo operator).
      const op = (
        await one(
          `INSERT INTO operators (tax_code, legal_name) VALUES ('M16OP', 'Op') RETURNING id`,
        )
      )['id'];
      const site = (
        await one(
          `INSERT INTO sites (site_code, operator_id, site_name) VALUES ('M16', $1, 'M16') RETURNING id`,
          [op],
        )
      )['id'];
      const staff = Number(
        (
          await one(
            `INSERT INTO users (email, full_name, role) VALUES ('m16.staff@test', 'Van Hanh', 'operator_staff')
             RETURNING id`,
          )
        )['id'],
      );
      await q(
        `INSERT INTO operator_staff (user_id, operator_id, staff_role) VALUES ($1, $2, 'manager')`,
        [staff, op],
      );
      ids['staff'] = staff;
      const cpId = Number(
        (
          await one(
            `INSERT INTO charge_points (serial_number, site_id) VALUES ('M16-CP', $1) RETURNING id`,
            [site],
          )
        )['id'],
      );
      const connectorId = Number(
        (
          await one(
            `INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1, 1) RETURNING id`,
            [cpId],
          )
        )['id'],
      );
      const card = async (key: string, kind: string, status: string, driver: number | null) => {
        ids[key] = Number(
          (
            await one(
              `INSERT INTO rfid_cards (card_identifier, card_kind, status, driver_id, updated_at)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [key, kind, status, driver, OLD],
            )
          )['id'],
        );
      };
      // Thẻ ví như seed cũ (không tài xế, active) và một thẻ ví đã gắn tài xế, bị khoá.
      await card('W-NODRIVER', 'wallet', 'active', null);
      await card('W-DRIVER-BLOCKED', 'wallet', 'blocked', driverId);
      await card('O-CARD', 'online', 'active', driverId);
      await card('F-CARD', 'free_vend', 'active', null);

      const session = async (
        key: string,
        mode: string,
        origin: string,
        status: string,
        cardKey: string | null,
        driver: number | null,
      ) => {
        // reconciled / review = đã có StopTransaction (2.000 Wh); orphaned = chưa dừng.
        const stopped = status !== 'orphaned';
        const meterStart = 10000 * (Object.keys(ids).length + 1);
        ids[key] = Number(
          (
            await one(
              `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin,
                 payment_mode, status, cp_started_at, meter_start_wh, rfid_card_id, driver_id,
                 orphaned_at, updated_at, meter_stop_wh, cp_stopped_at, received_stopped_at,
                 energy_wh)
               VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $11, $8, $9, $10, $7,
                 $12, $13, $13, $14) RETURNING id`,
              [
                connectorId,
                cpId,
                cardKey ?? key,
                origin,
                mode,
                status,
                OLD,
                cardKey ? ids[cardKey] : null,
                driver,
                status === 'orphaned' ? OLD : null,
                // meter_start khác nhau: khoá tự nhiên (trụ, súng, idTag, giờ, meterStart) của ADR-0010.
                meterStart,
                stopped ? meterStart + 2000 : null,
                stopped ? new Date(OLD.getTime() + 600000) : null,
                stopped ? 2000 : null,
              ],
            )
          )['id'],
        );
      };
      await session('S-WALLET-DONE', 'station_wallet', 'rfid', 'reconciled', 'W-NODRIVER', null);
      await session('S-WALLET-ORPHAN', 'station_wallet', 'rfid', 'orphaned', 'W-NODRIVER', null);
      await session(
        'S-WALLET-DRIVER',
        'station_wallet',
        'rfid',
        'review',
        'W-DRIVER-BLOCKED',
        driverId,
      );
      await session('S-BILLED', 'csms_billed', 'rfid', 'reconciled', 'O-CARD', driverId);
      await session('S-FREE', 'unattributed', 'free_vend', 'reconciled', 'F-CARD', null);
      await session('S-UNKNOWN', 'unattributed', 'rfid', 'review', null, null);

      await q(
        `INSERT INTO meter_values (session_id, cp_timestamp, received_at, measurand, value)
         VALUES ($1, $2, $2, 'Energy.Active.Import.Register', 1500)`,
        [ids['S-WALLET-DONE'], OLD],
      );
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type, resolution)
         VALUES ($1, 1, 'meter_gap', 'conflict: diff=5')`,
        [ids['S-WALLET-DRIVER']],
      );
      await q(
        `INSERT INTO session_status_history (session_id, from_status, to_status, event)
         VALUES ($1, 'active', 'orphaned', 'STATION_OFFLINE')`,
        [ids['S-WALLET-ORPHAN']],
      );

      before = Object.fromEntries(
        (await q('SELECT * FROM sessions ORDER BY id')).map((r) => [String(r['id']), r]),
      );

      // Client riêng để bắt RAISE NOTICE của 0016.
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      client.on('notice', (n) => notices.push(n.message ?? ''));
      try {
        applied = await migrate(client);
      } finally {
        await client.end();
      }
    });

    it('migrate() áp 0016 (rồi các migration sau) và in số dòng sẽ đổi (3 phiên, 2 thẻ; 2 phiên đã dừng được đóng sẵn)', () => {
      // 0017 (BE-30) trở đi áp tiếp sau 0016.
      expect(applied[0]).toBe(M0016);
      expect(applied).toEqual(listMigrations().slice(BEFORE_0016.length));
      expect(notices).toContain(
        '0016: 3 phiên station_wallet → unattributed, 2 thẻ wallet → online',
      );
      expect(notices).toContain(
        '0016: ghi UNATTRIBUTED_CLOSED cho 2 phiên đã dừng; 1 phiên chưa dừng không được ghi (đóng tay sau khi dừng)',
      );
    });

    it('phiên station_wallet → unattributed; origin, id_tag, thẻ, tài xế, trạng thái, orphaned_at giữ nguyên; updated_at được ghi', async () => {
      for (const key of ['S-WALLET-DONE', 'S-WALLET-ORPHAN', 'S-WALLET-DRIVER']) {
        const old = before[String(ids[key])]!;
        const now = await one('SELECT * FROM sessions WHERE id = $1', [ids[key]]);
        expect(now['payment_mode']).toBe('unattributed');
        for (const col of [
          'origin',
          'id_tag',
          'rfid_card_id',
          'driver_id',
          'status',
          'orphaned_at',
          'meter_start_wh',
          'cp_started_at',
          'transaction_no',
        ]) {
          expect([key, col, now[col]]).toEqual([key, col, old[col]]);
        }
        expect((now['updated_at'] as Date).getTime()).toBeGreaterThan(OLD.getTime());
      }
      // Phiên đã gắn tài xế vẫn giữ driver_id (không mất dữ liệu; gán / đóng là việc của console).
      expect(
        (await one('SELECT driver_id FROM sessions WHERE id = $1', [ids['S-WALLET-DRIVER']]))[
          'driver_id'
        ],
      ).toBe(String(ids['driver']));
    });

    it('phiên không phải station_wallet không bị đụng (kể cả updated_at)', async () => {
      for (const key of ['S-BILLED', 'S-FREE', 'S-UNKNOWN']) {
        const now = await one('SELECT * FROM sessions WHERE id = $1', [ids[key]]);
        expect(now).toEqual({
          ...before[String(ids[key])],
          priced_clock: null,
          priced_ended_at: null,
        });
      }
    });

    it('meter, đối soát và lịch sử trạng thái của phiên cũ còn nguyên; tổng số phiên không đổi', async () => {
      expect(await q('SELECT 1 FROM sessions')).toHaveLength(6);
      expect(
        await q('SELECT value FROM meter_values WHERE session_id = $1', [ids['S-WALLET-DONE']]),
      ).toEqual([{ value: '1500.000' }]);
      expect(
        await q(
          'SELECT record_type, resolution FROM reconciliation_records WHERE session_id = $1',
          [ids['S-WALLET-DRIVER']],
        ),
      ).toEqual([{ record_type: 'meter_gap', resolution: 'conflict: diff=5' }]);
      // Phiên chưa dừng: 0016 không ghi gì (giữ mốc hard cap của phiên orphaned).
      expect(
        await q('SELECT event FROM session_status_history WHERE session_id = $1', [
          ids['S-WALLET-ORPHAN'],
        ]),
      ).toEqual([{ event: 'STATION_OFFLINE' }]);
    });

    it('phiên station_wallet đã dừng có đúng một dòng UNATTRIBUTED_CLOSED như BE-24 ghi (from = to, actor system); phiên khác không có', async () => {
      const rows = await q(
        `SELECT session_id, from_status, to_status, event, actor, note FROM session_status_history
         WHERE event IN ('UNATTRIBUTED_CLOSED', 'UNATTRIBUTED_ASSIGNED') ORDER BY session_id`,
      );
      const note =
        'legacy_station_wallet: đã trả tại trụ bằng thẻ ví (T110, migration 0016), không được tính tiền lại';
      expect(rows).toEqual([
        {
          session_id: String(ids['S-WALLET-DONE']),
          from_status: 'reconciled',
          to_status: 'reconciled',
          event: 'UNATTRIBUTED_CLOSED',
          actor: 'system',
          note,
        },
        {
          session_id: String(ids['S-WALLET-DRIVER']),
          from_status: 'review',
          to_status: 'review',
          event: 'UNATTRIBUTED_CLOSED',
          actor: 'system',
          note,
        },
      ]);
    });

    describe('chặn trừ tiền hai lần qua console BE-24 (UnattributedSessionService)', () => {
      let service: UnattributedSessionService;
      const code = async (p: Promise<unknown>) => {
        try {
          await p;
        } catch (e) {
          expect(e).toBeInstanceOf(UnattributedSessionError);
          return (e as UnattributedSessionError).code;
        }
        throw new Error('kỳ vọng bị từ chối');
      };
      const money = async () => ({
        tx: await q('SELECT 1 FROM credit_transactions'),
        balance: (
          await one('SELECT balance_vnd FROM credit_accounts WHERE driver_id = $1', [ids['driver']])
        )['balance_vnd'],
      });

      beforeAll(() => {
        service = new UnattributedSessionService(db, new ChargeSettlementService(db));
      });

      it('gán tài xế cho phiên station_wallet cũ đã dừng → already_resolved; không giao dịch credit, payment_mode giữ unattributed', async () => {
        for (const key of ['S-WALLET-DONE', 'S-WALLET-DRIVER']) {
          expect(
            await code(service.assign(ids[key]!, ids['staff']!, ids['driver']!, 'gan thu')),
          ).toBe('already_resolved');
          expect(await one('SELECT payment_mode FROM sessions WHERE id = $1', [ids[key]])).toEqual({
            payment_mode: 'unattributed',
          });
        }
        expect(await money()).toEqual({ tx: [], balance: '200000' });
        expect(
          await q(`SELECT 1 FROM session_status_history WHERE event = 'UNATTRIBUTED_ASSIGNED'`),
        ).toEqual([]);
      });

      it('đóng lại cùng quyết định → already_resolved = true (idempotent), không thêm dòng lịch sử', async () => {
        const r = await service.close(
          ids['S-WALLET-DONE']!,
          ids['staff']!,
          'owner_unknown',
          'dong lai',
        );
        expect(r).toMatchObject({
          decision: 'closed',
          alreadyResolved: true,
          reason: 'legacy_station_wallet',
          paymentMode: 'unattributed',
        });
        expect(
          await q(`SELECT 1 FROM session_status_history WHERE event = 'UNATTRIBUTED_CLOSED'`),
        ).toHaveLength(2);
        expect(await money()).toEqual({ tx: [], balance: '200000' });
      });

      it('hàng đợi unattributed không có phiên ví cũ đã dừng; phiên thẻ lạ và free vend vẫn còn', async () => {
        const pending = (await service.listPending(50)).map((i) => i.session_id);
        expect(pending.sort((a, b) => a - b)).toEqual(
          [ids['S-FREE']!, ids['S-UNKNOWN']!].sort((a, b) => a - b),
        );
      });

      it('giới hạn đã ghi: phiên station_wallet cũ CHƯA dừng chưa có quyết định — hiện bị từ chối vì chưa dừng', async () => {
        expect(
          await code(
            service.assign(ids['S-WALLET-ORPHAN']!, ids['staff']!, ids['driver']!, 'gan thu'),
          ),
        ).toBe('session_not_stopped');
        expect(await money()).toEqual({ tx: [], balance: '200000' });
      });
    });

    it('thẻ wallet → online, giữ driver_id và status; thẻ online / free_vend không bị đụng', async () => {
      const cards = await q(
        'SELECT card_identifier, card_kind, status, driver_id, updated_at FROM rfid_cards ORDER BY id',
      );
      expect(cards.map((c) => [c['card_identifier'], c['card_kind'], c['status']])).toEqual([
        ['W-NODRIVER', 'online', 'active'],
        ['W-DRIVER-BLOCKED', 'online', 'blocked'],
        ['O-CARD', 'online', 'active'],
        ['F-CARD', 'free_vend', 'active'],
      ]);
      expect(cards[0]?.['driver_id']).toBeNull();
      expect(cards[1]?.['driver_id']).toBe(String(ids['driver']));
      expect((cards[0]?.['updated_at'] as Date).getTime()).toBeGreaterThan(OLD.getTime());
      expect((cards[2]?.['updated_at'] as Date).getTime()).toBe(OLD.getTime());
      expect((cards[3]?.['updated_at'] as Date).getTime()).toBe(OLD.getTime());
    });

    it('enum mới không còn giá trị cũ, kiểu tạm *_truoc_0016 đã bỏ, session_origin không đổi', async () => {
      expect(await enumValues('payment_mode')).toEqual(['csms_billed', 'unattributed']);
      expect(await enumValues('rfid_card_kind')).toEqual(['online', 'free_vend']);
      expect(await enumValues('session_origin')).toEqual([
        'app_qr',
        'rfid',
        'hmi_password',
        'free_vend',
      ]);
      expect(await q(`SELECT typname FROM pg_type WHERE typname LIKE '%truoc_0016%'`)).toEqual([]);
      await expect(q(`SELECT 'station_wallet'::payment_mode`)).rejects.toThrow(
        /invalid input value for enum payment_mode/,
      );
      await expect(q(`SELECT 'wallet'::rfid_card_kind`)).rejects.toThrow(
        /invalid input value for enum rfid_card_kind/,
      );
    });

    it('COMMENT cột / bảng nói đúng hai giá trị còn lại', async () => {
      const c = await one(
        `SELECT col_description('sessions'::regclass,
                  (SELECT attnum FROM pg_attribute WHERE attrelid = 'sessions'::regclass
                     AND attname = 'payment_mode')) AS pm,
                obj_description('rfid_cards'::regclass, 'pg_class') AS rc`,
      );
      expect(c['pm']).toMatch(/^Ai thu tiền \(ADR-0012\): csms_billed .* · unattributed /);
      expect(c['pm']).toMatch(/station_wallet bỏ ở 0016/);
      expect(c['rc']).toMatch(/^Thẻ RFID đã phát hành: online .* \/ free_vend\. wallet bỏ ở 0016/);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });
  });

  describe('DB sạch (0000 → mới nhất) và đối chiếu schema TS', () => {
    beforeAll(async () => {
      await resetAndMigrate(db.$client);
    });

    it('enums.ts khớp pg_enum cho payment_mode và rfid_card_kind', async () => {
      expect(await enumValues('payment_mode')).toEqual([...paymentModeEnum.enumValues]);
      expect(await enumValues('rfid_card_kind')).toEqual([...rfidCardKindEnum.enumValues]);
      expect(paymentModeEnum.enumValues).toEqual(['csms_billed', 'unattributed']);
      expect(rfidCardKindEnum.enumValues).toEqual(['online', 'free_vend']);
    });

    it('chỉ một cột dùng mỗi kiểu, không DEFAULT / CHECK / index nào nhắc giá trị cũ', async () => {
      const cols = await q(
        `SELECT table_name, column_name, column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND udt_name IN ('payment_mode', 'rfid_card_kind')
         ORDER BY table_name`,
      );
      expect(cols).toEqual([
        { table_name: 'rfid_cards', column_name: 'card_kind', column_default: null },
        { table_name: 'sessions', column_name: 'payment_mode', column_default: null },
      ]);
      expect(
        await q(
          `SELECT conname FROM pg_constraint WHERE pg_get_constraintdef(oid) ~ '(station_wallet|''wallet'')'`,
        ),
      ).toEqual([]);
      expect(
        await q(`SELECT indexname FROM pg_indexes WHERE indexdef ~ '(station_wallet|''wallet'')'`),
      ).toEqual([]);
    });
  });
});
