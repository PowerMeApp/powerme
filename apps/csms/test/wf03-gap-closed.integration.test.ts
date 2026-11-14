/**
 * Test tích hợp T132: mẫu phát bù lấp kín khe hở đã ghi → bản ghi `gap_closed` (append-only).
 *
 * Vì sao tồn tại: RQ1 13/11 (kịch bản S2) cho 12/30 phiên có bản ghi `meter_gap` báo nhầm.
 * StopTransaction phát lại tới TRƯỚC các MeterValues phát bù, nên lúc dừng chuỗi mẫu có khoảng trống
 * tạm thời > ngưỡng; các mẫu tới sau lấp kín nhưng bản ghi ở lại như khe hở thật. Hỏng âm thầm có
 * thể là: khe hở thật (mẫu mất hẳn) bị đóng nhầm, khe hở mới lấp một phần bị đóng, bản ghi cũ bị sửa,
 * ghi hai bản ghi đóng cho một khe hở, hoặc bản ghi đóng làm hỏng việc khử trùng kết luận mẫu muộn.
 *
 * Gọi thẳng `ReconciliationService` trên DB thật với phiên dựng tay (đường OCPP đầy đủ đã có ở
 * wf03-exp01 và harness lab/rq1). Cần DATABASE_URL; thiếu thì cả describe bị skip.
 */
import type { CsmsConfig } from '../src/config.js';
import { createDb, Db } from '../src/db/db.module.js';
import {
  closedRecordNo,
  EnergySample,
  ReconciliationService,
} from '../src/reconciliation/reconciliation.service.js';
import { resetAndMigrate } from './helpers/apply-migrations.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const T0 = Date.parse('2026-11-14T03:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000);
const sample = (s: number, wh: number): EnergySample => ({ cpTimestamp: at(s), wh });

describeDb('T132 — đóng khe hở khi mẫu phát bù tới sau StopTransaction', () => {
  let db: Db;
  let svc: ReconciliationService;
  let cp: number;
  let connector: number;
  let txNo = 0;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows as Record<string, unknown>[];

  /** Phiên đã dừng: bắt đầu ở 0 s, dừng ở `stopS`, meterStart 1000. */
  async function newSession(stopS: number, meterStopWh: number): Promise<number> {
    txNo++;
    const rows = await q(
      `INSERT INTO sessions(transaction_no,charge_point_id,connector_id,connector_no,id_tag,origin,payment_mode,
         status,meter_start_wh,meter_stop_wh,cp_started_at,received_started_at,cp_stopped_at,received_stopped_at,stop_reason)
       VALUES($1,$2,$3,1,$7,'rfid','unattributed','reconciled',1000,$4,$5,$5,$6,$6,'Local') RETURNING id`,
      [txNo, cp, connector, meterStopWh, at(0), at(stopS), `T132-${txNo}`],
    );
    return Number(rows[0]!['id']);
  }
  const verdictOf = (stopS: number, meterStopWh: number, samples: EnergySample[]) =>
    svc.evaluate({
      meterStartWh: 1000,
      meterStopWh,
      cpStartedAt: at(0),
      cpStoppedAt: at(stopS),
      samples,
    });
  const records = (sessionId: number) =>
    q(
      `SELECT record_no, record_type::text AS type, gap_start, gap_end, resolution
       FROM reconciliation_records WHERE session_id = $1 ORDER BY record_no`,
      [sessionId],
    );

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string);
    await resetAndMigrate(db.$client);
    const [op] = await q(
      "INSERT INTO operators(tax_code,legal_name) VALUES('0100000132','T132 Operator') RETURNING id",
    );
    const [site] = await q(
      `INSERT INTO sites(operator_id,site_code,site_name,latitude,longitude)
       VALUES($1,'T132','Trạm T132',10.776,106.700) RETURNING id`,
      [op!['id']],
    );
    cp = Number(
      (
        await q(
          `INSERT INTO charge_points(serial_number,display_code,site_id,rated_power_kw,lifecycle)
           VALUES('T132-CP','T132-CP',$1,120,'in_service') RETURNING id`,
          [site!['id']],
        )
      )[0]!['id'],
    );
    connector = Number(
      (
        await q(
          `INSERT INTO connectors(charge_point_id,connector_no,max_power_kw,status,status_changed_at)
           VALUES($1,1,120,'Available',now()) RETURNING id`,
          [cp],
        )
      )[0]!['id'],
    );
    const config = {
      meterValueSampleIntervalS: 10,
      reconcileGapFactor: 3,
      reconcileEnergyToleranceWh: 1,
      reconciliationEnabled: true,
    } as unknown as CsmsConfig;
    svc = new ReconciliationService(db, config);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it('S2: khe hở tạm lúc dừng (mẫu cuối 20 s, dừng 60 s) được đóng khi đủ mẫu phát bù; bản ghi gốc giữ nguyên', async () => {
    // meterStop đúng (không conflict) để cô lập hành vi khe hở.
    const id = await newSession(60, 1600);
    const live = [sample(10, 1100), sample(20, 1200)];
    const atStop = verdictOf(60, 1600, live);
    expect(atStop.outcome).toBe('gap_detected');
    await svc.recordVerdict(db, id, atStop, { kind: 'stop', replayed: true });
    const original = (await records(id))[0]!;
    expect(original['type']).toBe('meter_gap');

    // Mẫu phát bù đầu tiên ở 29 s: phần còn lại 29 → 60 s = 31 s vẫn vượt ngưỡng 30 s, nên khe hở
    // mới chỉ thu hẹp, chưa đóng.
    const v1 = verdictOf(60, 1600, [...live, sample(29, 1290)]);
    expect(v1.gaps).toHaveLength(1);
    await svc.recordVerdict(db, id, v1, { kind: 'late_sample', replayed: true });
    expect(await svc.recordClosedGaps(db, id, v1)).toBe(0);
    expect(
      (await records(id)).filter((r) => String(r['resolution']).startsWith('gap_closed')),
    ).toEqual([]);

    // Đủ mẫu: không còn khoảng trống nào vượt ngưỡng.
    const v2 = verdictOf(60, 1600, [...live, sample(29, 1290), sample(40, 1400), sample(50, 1500)]);
    expect(v2.outcome).toBe('consistent');
    await svc.recordVerdict(db, id, v2, { kind: 'late_sample', replayed: true });
    // Hai bản ghi gap_detected đang mở (lúc dừng + lần thu hẹp do mẫu muộn) đều được đóng.
    expect(await svc.recordClosedGaps(db, id, v2)).toBe(2);

    const all = await records(id);
    expect(all[0]).toEqual(original); // append-only: bản ghi gốc không đổi
    const closing = all.filter((r) => String(r['resolution']).startsWith('gap_closed'));
    expect(closing).toHaveLength(2);
    expect(closing.every((r) => r['type'] === 'late_sample')).toBe(true);
    expect(closing.map((r) => closedRecordNo(String(r['resolution']))).sort()).toEqual([1, 2]);
    expect(closing[0]!['gap_start']).toEqual(original['gap_start']);
    expect(closing[0]!['gap_end']).toEqual(original['gap_end']);

    // Chạy lại (mẫu muộn nữa tới): không ghi bản ghi đóng lần hai.
    expect(await svc.recordClosedGaps(db, id, v2)).toBe(0);
    expect(await records(id)).toHaveLength(all.length);
  });

  it('S1: khe hở thật (mẫu mất hẳn) KHÔNG bị đóng khi mẫu muộn tới ở chỗ khác', async () => {
    const id = await newSession(200, 2900);
    const series = [sample(10, 1100), sample(20, 1200), sample(180, 2700), sample(190, 2800)];
    const atStop = verdictOf(200, 2900, series);
    expect(atStop.gaps).toHaveLength(1); // 20 s → 180 s
    await svc.recordVerdict(db, id, atStop, { kind: 'stop', replayed: false });
    // Một mẫu muộn trùng vùng đã có mẫu: khe hở 20 → 180 s vẫn nguyên.
    const later = verdictOf(200, 2900, [...series, sample(195, 2850)]);
    await svc.recordVerdict(db, id, later, { kind: 'late_sample', replayed: true });
    expect(await svc.recordClosedGaps(db, id, later)).toBe(0);
    const all = await records(id);
    // Mẫu muộn đổi số chênh nên engine ghi lại kết luận gap_detected (hành vi có từ trước); không
    // có bản ghi đóng nào và cả hai bản ghi vẫn là khe hở 20 → 180 s.
    expect(all.map((r) => String(r['resolution']).split(':')[0])).toEqual([
      'gap_detected',
      'gap_detected (late_sample)',
    ]);
    expect(all.every((r) => (r['gap_start'] as Date).getTime() === at(20).getTime())).toBe(true);
  });

  it('bản ghi đóng không làm hỏng khử trùng kết luận: mẫu muộn kế tiếp cùng kết luận conflict không ghi thêm', async () => {
    // meterStop cũ (1200) + khe hở tạm lúc dừng: lúc dừng chuỗi chỉ tới 1200 nên là gap_detected.
    const id = await newSession(60, 1200);
    const live = [sample(10, 1100), sample(20, 1200)];
    await svc.recordVerdict(db, id, verdictOf(60, 1200, live), { kind: 'stop', replayed: true });
    const full = [...live, sample(30, 1300), sample(40, 1400), sample(50, 1500)];
    const v = verdictOf(60, 1200, full);
    expect(v.outcome).toBe('conflict');
    expect(v.gaps).toHaveLength(0);
    await svc.recordVerdict(db, id, v, { kind: 'late_sample', replayed: true });
    expect(await svc.recordClosedGaps(db, id, v)).toBe(1);
    const before = await records(id);
    expect(before.map((r) => String(r['resolution']).split(' ')[0])).toEqual([
      'gap_detected:',
      'conflict',
      'gap_closed',
    ]);
    // Cùng kết luận lần nữa: bản ghi gần nhất là gap_closed nhưng phép so phải bỏ qua nó.
    await svc.recordVerdict(db, id, v, { kind: 'late_sample', replayed: true });
    expect(await svc.recordClosedGaps(db, id, v)).toBe(0);
    expect(await records(id)).toHaveLength(before.length);
  });

  it('đối soát tắt (ablation): không ghi gì', async () => {
    const off = new ReconciliationService(db, {
      meterValueSampleIntervalS: 10,
      reconcileGapFactor: 3,
      reconcileEnergyToleranceWh: 1,
      reconciliationEnabled: false,
    } as unknown as CsmsConfig);
    const id = await newSession(60, 1600);
    const v = verdictOf(60, 1600, [sample(10, 1100), sample(20, 1200)]);
    await off.recordVerdict(db, id, v, { kind: 'stop', replayed: true });
    expect(await off.recordClosedGaps(db, id, verdictOf(60, 1600, []))).toBe(0);
    expect(await records(id)).toEqual([]);
  });
});
