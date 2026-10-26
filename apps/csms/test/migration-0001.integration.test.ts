/**
 * Test tích hợp migration 0001 (BE-11): đường nâng cấp DB đã có 0000 và các ràng buộc mới.
 *
 * Vì sao tồn tại: 0001 đổi tên cột, thêm giá trị enum, thêm cột lên bảng partition và hai bảng
 * mới. Mỗi thứ có thể hỏng âm thầm (migration chạy được trên DB sạch nhưng vỡ trên DB demo đã có
 * dữ liệu; trigger append-only không chặn; CHECK/UNIQUE thiếu). Test này chạy trên Postgres thật.
 *
 * Phần 1 dựng DB "như demo cũ": chỉ 0000 (không có bảng `_migrations`) + vài dòng dữ liệu, rồi
 * gọi helper `migrate` và kiểm dữ liệu còn nguyên. Phần 2 kiểm ràng buộc trên chính DB đã nâng cấp.
 *
 * Cần DATABASE_URL (DB test riêng — test DROP SCHEMA public); thiếu thì cả describe bị skip.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, Db } from '../src/db/db.module.js';
import { listMigrations, MIGRATIONS_DIR, migrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

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

describeDb('migration 0001 — nâng cấp DB đã có 0000 và ràng buộc mới', () => {
  let db: Db;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  let cpId: number;
  let connectorId: number;
  let sessionId: number;

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await db.$client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  it('thứ tự migration: 0000, 0001, 0002 (T61), 0003 (WP3/T31)', () => {
    expect(listMigrations()).toEqual([
      '0000_init',
      '0001_quyet-dinh-be-11',
      '0002_tach-ket-noi-khoi-lifecycle',
      '0003_wp3_t31_charging',
    ]);
  });

  describe('đường nâng cấp (DB demo cũ: có 0000, KHÔNG có bảng _migrations, có dữ liệu)', () => {
    beforeAll(async () => {
      await db.$client.query(readFileSync(path.join(MIGRATIONS_DIR, '0000_init.sql'), 'utf8'));
      // Dữ liệu theo schema 0000: cột pillar_timestamp, payment_mode station_wallet, meter_gap…
      cpId = Number(
        (await q(`INSERT INTO charge_points (serial_number) VALUES ('UP-0001') RETURNING id`))[0]?.[
          'id'
        ],
      );
      connectorId = Number(
        (
          await q(
            `INSERT INTO connectors (charge_point_id, connector_no) VALUES ($1, 1) RETURNING id`,
            [cpId],
          )
        )[0]?.['id'],
      );
      sessionId = Number(
        (
          await q(
            `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
                                   status, cp_started_at, meter_start_wh)
             VALUES ($1, $2, 1, 'OLD-TAG', 'rfid', 'station_wallet', 'orphaned', '2026-10-20T10:00:00Z', 0)
             RETURNING id`,
            [connectorId, cpId],
          )
        )[0]?.['id'],
      );
      await q(
        `INSERT INTO connector_status_events (charge_point_id, connector_no, connector_id, status, pillar_timestamp)
         VALUES ($1, 1, $2, 'Available', '2026-10-20T09:59:00Z')`,
        [cpId, connectorId],
      );
      await q(
        `INSERT INTO meter_values (session_id, cp_timestamp, received_at, measurand, value)
         VALUES ($1, '2026-10-20T10:00:10Z', '2026-10-20T10:00:10Z', 'Energy.Active.Import.Register', 10)`,
        [sessionId],
      );
      await q(
        `INSERT INTO ocpp_message_log (charge_point_id, epoch, direction, message_type, unique_id, action, received_at, raw)
         VALUES ($1, 1, 'in', 2, 'm1', 'Heartbeat', '2026-10-20T10:00:11Z', '[2,"m1","Heartbeat",{}]')`,
        [cpId],
      );
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type, resolution)
         VALUES ($1, 1, 'meter_gap', 'conflict: diff=5')`,
        [sessionId],
      );
    });

    it('migrate() giữ 0000 đã áp và nâng cấp tuần tự đến 0003 (WP3/T31)', async () => {
      const applied = await migrate(db.$client);
      expect(applied).toEqual([
        '0001_quyet-dinh-be-11',
        '0002_tach-ket-noi-khoi-lifecycle',
        '0003_wp3_t31_charging',
      ]);
      const names = (await q('SELECT name FROM _migrations ORDER BY name')).map((r) => r['name']);
      expect(names).toEqual([
        '0000_init',
        '0001_quyet-dinh-be-11',
        '0002_tach-ket-noi-khoi-lifecycle',
        '0003_wp3_t31_charging',
      ]);
    });

    it('chạy lại migrate() không áp gì nữa', async () => {
      expect(await migrate(db.$client)).toEqual([]);
    });

    it('dữ liệu cũ còn nguyên: cột đổi tên giữ giá trị, bản ghi cũ không bị sửa', async () => {
      const ev = (await q('SELECT cp_timestamp FROM connector_status_events'))[0];
      expect((ev?.['cp_timestamp'] as Date).toISOString()).toBe('2026-10-20T09:59:00.000Z');
      expect(await q(`SELECT 1 FROM sessions WHERE payment_mode = 'station_wallet'`)).toHaveLength(
        1,
      );
      const rec = (await q('SELECT record_type, resolution FROM reconciliation_records'))[0];
      expect(rec).toEqual({ record_type: 'meter_gap', resolution: 'conflict: diff=5' });
      const s = (await q('SELECT orphaned_at FROM sessions'))[0];
      expect(s?.['orphaned_at']).toBeNull();
    });

    it('dòng cũ nhận giá trị mặc định đúng nghĩa: meter_values.replayed=false/epoch null, log.replayed null', async () => {
      const mv = (await q('SELECT replayed, epoch FROM meter_values'))[0];
      expect(mv).toEqual({ replayed: false, epoch: null });
      const log = (await q('SELECT replayed FROM ocpp_message_log'))[0];
      expect(log).toEqual({ replayed: null });
    });

    it('không còn cột pillar_timestamp ở bảng nào, cp_timestamp có ở 3 bảng nhận dữ liệu từ trụ', async () => {
      expect(
        await q(`SELECT 1 FROM information_schema.columns WHERE column_name = 'pillar_timestamp'`),
      ).toHaveLength(0);
      const tables = (
        await q(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'cp_timestamp'
             AND table_name IN ('connector_status_events', 'meter_values', 'ocpp_message_log')
           ORDER BY table_name`,
        )
      ).map((r) => r['table_name']);
      expect(tables).toEqual(['connector_status_events', 'meter_values', 'ocpp_message_log']);
    });

    it('ADD COLUMN trên bảng cha partition lan xuống MỌI partition con', async () => {
      const rows = await q(
        `SELECT c.relname AS tbl, count(*) FILTER (WHERE a.attname = 'replayed') AS n
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE p.relname IN ('meter_values', 'ocpp_message_log')
         GROUP BY p.relname, c.relname ORDER BY 1`,
      );
      // 2 bảng cha × 5 partition (4 tháng + default) — mỗi partition con có cột replayed
      expect(rows).toHaveLength(10);
      for (const r of rows) expect(Number(r['n'])).toBe(1);
      // meter_values.epoch (cột mới) cũng xuống đủ 5 partition của meter_values
      const epochCols = await q(
        `SELECT c.relname FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'meter_values' AND a.attname = 'epoch' AND NOT a.attisdropped`,
      );
      expect(epochCols).toHaveLength(5);
    });

    it('ba giá trị enum mới nằm CUỐI danh sách (ADD VALUE), 11 enum tự đặt của 0000 không đổi', async () => {
      const vals = async (t: string) =>
        (
          await q(
            `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = $1 ORDER BY e.enumsortorder`,
            [t],
          )
        ).map((r) => r['enumlabel']);
      expect(await vals('payment_mode')).toEqual([
        'csms_billed',
        'station_wallet',
        'free',
        'unattributed',
      ]);
      expect(await vals('reconciliation_record_type')).toEqual([
        'replay',
        'duplicate',
        'meter_gap',
        'orphan_stop',
        'unknown_id_tag',
        'conflict',
        'late_sample',
      ]);
      expect(await vals('remote_command_status')).toEqual([
        'pending',
        'sent',
        'accepted',
        'rejected',
        'timeout',
        'failed',
      ]);
      expect(await vals('tariff_band')).toEqual(['off_peak', 'normal', 'peak']);
      expect(await vals('maintenance_ticket_status')).toEqual(['open', 'in_progress', 'closed']);
    });
  });

  describe('giá trị enum mới dùng được sau COMMIT', () => {
    it("payment_mode = 'unattributed'", async () => {
      const r = await q(
        `INSERT INTO sessions (connector_id, charge_point_id, connector_no, id_tag, origin, payment_mode,
                               cp_started_at, meter_start_wh)
         VALUES ($1, $2, 1, 'NEW-TAG', 'rfid', 'unattributed', '2026-10-21T10:00:00Z', 0)
         RETURNING payment_mode`,
        [connectorId, cpId],
      );
      expect(r[0]?.['payment_mode']).toBe('unattributed');
    });

    it("reconciliation_record_type = 'conflict' và 'late_sample'", async () => {
      await q(
        `INSERT INTO reconciliation_records (session_id, record_no, record_type) VALUES ($1, 2, 'conflict'), ($1, 3, 'late_sample')`,
        [sessionId],
      );
      const types = (
        await q(
          `SELECT record_type FROM reconciliation_records WHERE session_id = $1 ORDER BY record_no`,
          [sessionId],
        )
      ).map((r) => r['record_type']);
      expect(types).toEqual(['meter_gap', 'conflict', 'late_sample']);
    });
  });

  describe('remote_commands', () => {
    const insert = (cols: string, vals: string, params: unknown[] = []) =>
      q(
        `INSERT INTO remote_commands (charge_point_id, action, ${cols}) VALUES ($1, 'Reset', ${vals}) RETURNING *`,
        [cpId, ...params],
      );

    it('dòng tối thiểu: status mặc định pending, requested_at = now(), các mốc còn lại null', async () => {
      const r = (
        await q(
          `INSERT INTO remote_commands (charge_point_id, action) VALUES ($1, 'Reset') RETURNING *`,
          [cpId],
        )
      )[0];
      expect(r?.['status']).toBe('pending');
      expect(r?.['requested_at']).toBeInstanceOf(Date);
      expect([
        r?.['sent_at'],
        r?.['responded_at'],
        r?.['connector_no'],
        r?.['idempotency_key'],
      ]).toEqual([null, null, null, null]);
    });

    it('vòng đời đủ: pending → sent → accepted với payload/response jsonb', async () => {
      const r = (
        await q(
          `INSERT INTO remote_commands (charge_point_id, connector_no, action, payload, status, requested_at, sent_at, responded_at, response)
         VALUES ($1, 1, 'RemoteStartTransaction', '{"idTag":"X"}', 'accepted',
                 '2026-10-25T10:00:00Z', '2026-10-25T10:00:01Z', '2026-10-25T10:00:02Z', '{"status":"Accepted"}')
         RETURNING payload, response, status`,
          [cpId],
        )
      )[0];
      expect(r).toEqual({
        payload: { idTag: 'X' },
        response: { status: 'Accepted' },
        status: 'accepted',
      });
    });

    it('connector_no ngoài {null,0,1,2} bị CHECK chặn; 0/1/2/null cho qua', async () => {
      const err = await rejection(insert('connector_no', '$2', [3]));
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('remote_commands_connector_no_check');
      for (const n of [0, 1, 2]) await insert('connector_no', '$2', [n]);
    });

    it('trình tự thời gian: sent_at < requested_at và responded_at < sent_at bị chặn; responded_at khi chưa gửi bị chặn', async () => {
      const early = await rejection(
        insert('requested_at, sent_at', `'2026-10-25T10:00:05Z', '2026-10-25T10:00:00Z'`),
      );
      expect(early.constraint).toBe('remote_commands_sent_check');
      const back = await rejection(
        insert(
          'requested_at, sent_at, responded_at',
          `'2026-10-25T10:00:00Z', '2026-10-25T10:00:05Z', '2026-10-25T10:00:01Z'`,
        ),
      );
      expect(back.constraint).toBe('remote_commands_responded_check');
      const unsent = await rejection(insert('responded_at', `'2026-10-25T10:00:09Z'`));
      expect(unsent.constraint).toBe('remote_commands_responded_check');
    });

    it('idempotency_key UNIQUE (partial): trùng bị chặn, nhiều dòng NULL vẫn được', async () => {
      await insert('idempotency_key', '$2', ['key-1']);
      const dup = await rejection(insert('idempotency_key', '$2', ['key-1']));
      expect(dup.code).toBe('23505');
      expect(dup.constraint).toBe('remote_commands_idempotency_key_key');
      const [{ n }] = (await q(
        `SELECT count(*) AS n FROM remote_commands WHERE idempotency_key IS NULL`,
      )) as [{ n: string }];
      expect(Number(n)).toBeGreaterThanOrEqual(2);
    });

    it('status ngoài enum bị từ chối; FK charge_point_id bắt buộc', async () => {
      expect((await rejection(insert('status', `'cancelled'`))).code).toBe('22P02');
      const fk = await rejection(
        q(`INSERT INTO remote_commands (charge_point_id, action) VALUES (999999, 'Reset')`),
      );
      expect(fk.code).toBe('23503');
    });

    it('index đúng như thiết kế: (charge_point_id, requested_at DESC) và partial (status) cho pending/sent', async () => {
      const defs = Object.fromEntries(
        (
          await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'remote_commands'`)
        ).map((r) => [r['indexname'], String(r['indexdef'])]),
      );
      expect(defs['remote_commands_cp_requested_at_idx']).toContain(
        '(charge_point_id, requested_at DESC)',
      );
      expect(defs['remote_commands_in_flight_idx']).toMatch(/WHERE .*pending.*sent/);
      expect(defs['remote_commands_idempotency_key_key']).toContain(
        'WHERE (idempotency_key IS NOT NULL)',
      );
    });
  });

  describe('session_status_history (append-only)', () => {
    let historyId: number;

    beforeAll(async () => {
      const r = await q(
        `INSERT INTO session_status_history (session_id, from_status, to_status, event)
         VALUES ($1, NULL, 'active', 'START_TRANSACTION') RETURNING id, actor, occurred_at`,
        [sessionId],
      );
      historyId = Number(r[0]?.['id']);
      expect(r[0]?.['actor']).toBe('system'); // mặc định
      expect(r[0]?.['occurred_at']).toBeInstanceOf(Date);
    });

    it('from_status NULL hợp lệ (chuyển từ INITIAL); to_status NOT NULL; status ngoài enum bị chặn', async () => {
      expect(
        (
          await rejection(
            q(
              `INSERT INTO session_status_history (session_id, to_status, event) VALUES ($1, NULL, 'X')`,
              [sessionId],
            ),
          )
        ).code,
      ).toBe('23502');
      expect(
        (
          await rejection(
            q(
              `INSERT INTO session_status_history (session_id, to_status, event) VALUES ($1, 'bogus', 'X')`,
              [sessionId],
            ),
          )
        ).code,
      ).toBe('22P02');
    });

    it('UPDATE bị trigger chặn', async () => {
      const err = await rejection(
        q(`UPDATE session_status_history SET note = 'sửa' WHERE id = $1`, [historyId]),
      );
      expect(err.message).toContain('append-only');
      expect(err.message).toContain('UPDATE');
    });

    it('DELETE bị trigger chặn', async () => {
      const err = await rejection(
        q(`DELETE FROM session_status_history WHERE id = $1`, [historyId]),
      );
      expect(err.message).toContain('append-only');
      expect(err.message).toContain('DELETE');
    });

    it('xoá phiên còn lịch sử bị FK ON DELETE RESTRICT chặn (không âm thầm xoá lịch sử)', async () => {
      const err = await rejection(q(`DELETE FROM sessions WHERE id = $1`, [sessionId]));
      expect(err.code).toBe('23503');
      const fk = (
        await q(
          `SELECT confdeltype FROM pg_constraint
           WHERE conrelid = 'session_status_history'::regclass AND contype = 'f'`,
        )
      )[0];
      expect(fk?.['confdeltype']).toBe('r'); // r = RESTRICT
    });

    it('truy vấn lịch sử theo phiên dùng index (session_id, occurred_at)', async () => {
      const idx = (
        await q(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'session_status_history_session_id_occurred_at_idx'`,
        )
      )[0];
      expect(String(idx?.['indexdef'])).toContain('(session_id, occurred_at)');
    });
  });

  describe('ocpp_message_log.replayed trên bảng append-only', () => {
    it('INSERT kèm replayed=true được; UPDATE replayed bị trigger chặn (vì thế phải truyền lúc INSERT)', async () => {
      const r = await q(
        `INSERT INTO ocpp_message_log (charge_point_id, epoch, direction, message_type, unique_id, action, cp_timestamp, received_at, raw, replayed)
         VALUES ($1, 2, 'in', 2, 'm2', 'MeterValues', '2026-10-20T09:00:00Z', '2026-10-20T10:02:00Z', '[2,"m2","MeterValues",{}]', true)
         RETURNING id, replayed`,
        [cpId],
      );
      expect(r[0]?.['replayed']).toBe(true);
      const err = await rejection(
        q(`UPDATE ocpp_message_log SET replayed = false WHERE id = $1`, [r[0]?.['id']]),
      );
      expect(err.message).toContain('append-only');
      const del = await rejection(q(`DELETE FROM ocpp_message_log WHERE id = $1`, [r[0]?.['id']]));
      expect(del.message).toContain('append-only');
    });
  });
});
