/**
 * Unit test hàm thuần `evaluateSeries` — luật đối soát với chuỗi MeterValues thật của EXP-01.
 */
import type { CsmsConfig } from '../config.js';
import type { Db } from '../db/db.module.js';
import {
  closedRecordNo,
  EnergySample,
  evaluateSeries,
  gapStillOpen,
  ReconciliationInput,
  ReconciliationService,
} from './reconciliation.service.js';

const t = (iso: string) => new Date(iso);
const s = (iso: string, wh: number): EnergySample => ({ cpTimestamp: t(iso), wh });
const base = { sampleIntervalS: 10, gapFactor: 3, energyToleranceWh: 1 };

/** tx3 EXP-01: 3 mẫu trước ngắt + 4 mẫu live sau nối lại (lúc StopTransaction phát lại tới). */
const TX3_AT_STOP: EnergySample[] = [
  s('2026-09-16T14:18:27.788Z', 64.56),
  s('2026-09-16T14:18:37.798Z', 142.33),
  s('2026-09-16T14:18:47.811Z', 242.04),
  s('2026-09-16T14:20:27.901Z', 796.84),
  s('2026-09-16T14:20:37.908Z', 873.41),
  s('2026-09-16T14:20:47.920Z', 922.42),
  s('2026-09-16T14:20:57.928Z', 1042.64),
];

/** 6 mẫu phát lại đến sau StopTransaction (giai đoạn F). */
const TX3_LATE: EnergySample[] = [
  s('2026-09-16T14:18:57.815Z', 303.03),
  s('2026-09-16T14:19:07.827Z', 354.41),
  s('2026-09-16T14:19:17.837Z', 367.34),
  s('2026-09-16T14:19:27.843Z', 385.85),
  s('2026-09-16T14:19:37.852Z', 513.29),
  s('2026-09-16T14:19:47.867Z', 537.94),
];

describe('evaluateSeries', () => {
  it('EXP-01 tx3 lúc StopTransaction phát lại: conflict, diff 801 Wh, lỗ hổng 100 s', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 242,
      cpStartedAt: t('2026-09-16T14:18:17.784Z'),
      cpStoppedAt: t('2026-09-16T14:18:52.934Z'),
      samples: TX3_AT_STOP,
    });
    expect(v.outcome).toBe('conflict');
    expect(v.energyWh).toBe(242);
    expect(v.seriesLastWh).toBe(1043); // round(1042.64) — SAP làm tròn khi phát meterStop (601 ← 600.78)
    expect(v.energyDifferenceWh).toBe(801);
    expect(v.monotonic).toBe(true);
    expect(v.gaps).toEqual([
      { start: t('2026-09-16T14:18:47.811Z'), end: t('2026-09-16T14:20:27.901Z') },
    ]);
    expect(v.sampleCount).toBe(7);
  });

  it('EXP-01 tx3 sau 6 mẫu muộn: vẫn conflict, lỗ hổng thu còn 40 s (14:19:47 → 14:20:27)', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 242,
      cpStartedAt: t('2026-09-16T14:18:17.784Z'),
      cpStoppedAt: t('2026-09-16T14:18:52.934Z'),
      samples: [...TX3_AT_STOP, ...TX3_LATE],
    });
    expect(v.outcome).toBe('conflict');
    expect(v.energyDifferenceWh).toBe(801);
    expect(v.gaps).toEqual([
      { start: t('2026-09-16T14:19:47.867Z'), end: t('2026-09-16T14:20:27.901Z') },
    ]);
    expect(v.sampleCount).toBe(13);
  });

  it('EXP-01 tx2: meterStop 997 vs mẫu cuối 996,78 → consistent, không lỗ hổng', () => {
    const samples: EnergySample[] = [
      s('2026-09-16T14:16:18.741Z', 48.46),
      s('2026-09-16T14:16:28.751Z', 148.44),
      s('2026-09-16T14:16:38.765Z', 153.55),
      s('2026-09-16T14:16:48.769Z', 250.12),
      s('2026-09-16T14:16:58.773Z', 337.44),
      s('2026-09-16T14:17:08.785Z', 474.93),
      s('2026-09-16T14:17:18.798Z', 580.7),
      s('2026-09-16T14:17:28.800Z', 649.61),
      s('2026-09-16T14:17:38.803Z', 740.04),
      s('2026-09-16T14:17:48.811Z', 823.63),
      s('2026-09-16T14:17:58.820Z', 851.47),
      s('2026-09-16T14:18:08.834Z', 922.17),
      s('2026-09-16T14:18:18.837Z', 928.45),
      s('2026-09-16T14:18:28.848Z', 996.78),
    ];
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 997,
      cpStartedAt: t('2026-09-16T14:16:08.735Z'),
      cpStoppedAt: t('2026-09-16T14:18:32.754Z'),
      samples,
    });
    expect(v.outcome).toBe('consistent');
    expect(v.energyWh).toBe(997);
    expect(v.energyDifferenceWh).toBe(0);
    expect(v.gaps).toEqual([]);
  });

  it('gap_detected: meterStop khớp mẫu cuối nhưng thiếu mẫu > 3 × 10 s ở giữa', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 100,
      meterStopWh: 400,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:01:10Z'),
      samples: [
        s('2026-09-16T10:00:10Z', 150),
        s('2026-09-16T10:00:20Z', 200),
        s('2026-09-16T10:01:00Z', 390),
      ],
    });
    expect(v.outcome).toBe('gap_detected');
    expect(v.gaps).toEqual([{ start: t('2026-09-16T10:00:20Z'), end: t('2026-09-16T10:01:00Z') }]);
    expect(v.energyDifferenceWh).toBe(-10); // meterStop đi trước mẫu cuối một chu kỳ là bình thường
  });

  it('lỗ hổng đúng bằng 30 s không bị coi là gap (luật là lớn hơn)', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 50,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:00:40Z'),
      samples: [s('2026-09-16T10:00:10Z', 10), s('2026-09-16T10:00:40Z', 50)],
    });
    expect(v.outcome).toBe('consistent');
  });

  it('lỗ hổng giữa cp_started_at và mẫu đầu, và giữa mẫu cuối và cp_stopped_at, đều được tính', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 100,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:02:00Z'),
      samples: [s('2026-09-16T10:01:00Z', 50)],
    });
    expect(v.outcome).toBe('gap_detected');
    expect(v.gaps).toHaveLength(2);
  });

  it('chuỗi không đơn điệu → conflict dù meterStop khớp', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 300,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:00:40Z'),
      samples: [
        s('2026-09-16T10:00:10Z', 100),
        s('2026-09-16T10:00:20Z', 90),
        s('2026-09-16T10:00:30Z', 300),
      ],
    });
    expect(v.outcome).toBe('conflict');
    expect(v.monotonic).toBe(false);
  });

  it('không có meterStop dùng được → conflict', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 500,
      meterStopWh: null,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:00:20Z'),
      samples: [s('2026-09-16T10:00:10Z', 520)],
    });
    expect(v.outcome).toBe('conflict');
    expect(v.energyWh).toBeNull();
    expect(v.energyDifferenceWh).toBeNull();
  });

  it('dung sai 1 Wh: meterStop 241 với mẫu cuối 242,04 (→ 242) là consistent; 240 là conflict', () => {
    const input: ReconciliationInput = {
      ...base,
      meterStartWh: 0,
      meterStopWh: 241,
      cpStartedAt: t('2026-09-16T14:18:17.784Z'),
      cpStoppedAt: t('2026-09-16T14:18:52.934Z'),
      samples: TX3_AT_STOP.slice(0, 3),
    };
    expect(evaluateSeries(input).outcome).toBe('consistent');
    expect(evaluateSeries({ ...input, meterStopWh: 240 }).outcome).toBe('conflict');
  });

  it('không có mẫu nào: không có gì mâu thuẫn, nhưng phiên dài hơn 30 s thì là gap từ start tới stop', () => {
    const v = evaluateSeries({
      ...base,
      meterStartWh: 0,
      meterStopWh: 10,
      cpStartedAt: t('2026-09-16T10:00:00Z'),
      cpStoppedAt: t('2026-09-16T10:05:00Z'),
      samples: [],
    });
    expect(v.outcome).toBe('gap_detected');
    expect(v.gaps).toEqual([{ start: t('2026-09-16T10:00:00Z'), end: t('2026-09-16T10:05:00Z') }]);
    expect(v.seriesLastWh).toBeNull();
    expect(v.sampleCount).toBe(0);
  });
});

describe('ReconciliationService — công tắc RECONCILIATION_ENABLED (G6)', () => {
  /** Executor giả: mọi truy cập DB đều là lỗi, để chứng minh chế độ tắt không chạm DB. */
  const explosive = new Proxy(
    {},
    {
      get() {
        throw new Error('chế độ ablation không được truy cập DB');
      },
    },
  ) as never;
  const frame = {
    action: 'StopTransaction',
    cpTimestamp: t('2026-09-16T14:18:52.934Z'),
    receivedAt: t('2026-09-16T14:20:58.209Z'),
    messageLogId: 1,
  };
  const conflict = evaluateSeries({
    ...base,
    meterStartWh: 0,
    meterStopWh: 242,
    cpStartedAt: t('2026-09-16T14:18:17.784Z'),
    cpStoppedAt: t('2026-09-16T14:18:52.934Z'),
    samples: TX3_AT_STOP,
  });
  const make = (reconciliationEnabled?: boolean) =>
    new ReconciliationService(
      {} as Db,
      {
        meterValueSampleIntervalS: 10,
        reconcileGapFactor: 3,
        reconcileEnergyToleranceWh: 1,
        ...(reconciliationEnabled === undefined ? {} : { reconciliationEnabled }),
      } as CsmsConfig,
    );

  it('mặc định (không khai báo) và true là bật; false là tắt', () => {
    expect(make().enabled).toBe(true);
    expect(make(true).enabled).toBe(true);
    expect(make(false).enabled).toBe(false);
  });

  it('tắt: mọi record* trả null và không truy cập DB, kể cả khi verdict là conflict', async () => {
    const svc = make(false);
    expect(conflict.outcome).toBe('conflict');
    expect(await svc.recordVerdict(explosive, 1, conflict, { kind: 'stop', replayed: true })).toBe(
      null,
    );
    expect(
      await svc.recordReplay(explosive, 1, frame, {
        replayed: true,
        reason: 'x',
        skewS: 200,
      } as never),
    ).toBe(null);
    expect(await svc.recordDuplicate(explosive, 1, frame)).toBe(null);
    expect(await svc.recordOrphanStop(explosive, 1, frame)).toBe(null);
    expect(await svc.recordUnknownIdTag(explosive, 1, 'X')).toBe(null);
  });

  it('bật: recordVerdict conflict chạm DB (ở đây executor giả nên ném lỗi)', async () => {
    await expect(
      make(true).recordVerdict(explosive, 1, conflict, { kind: 'stop', replayed: true }),
    ).rejects.toThrow('ablation');
  });
});

describe('T132 — khe hở đã ghi còn mở hay đã được lấp kín', () => {
  const gap = (a: string, b: string) => ({ start: t(a), end: t(b) });
  const recorded = gap('2026-11-14T03:00:20.000Z', '2026-11-14T03:01:00.000Z');

  it('không còn khe hở nào → đã đóng', () => {
    expect(gapStillOpen(recorded, [])).toBe(false);
  });

  it('khe hở mới nằm trong khoảng đã ghi (mẫu muộn chỉ lấp một phần) → còn mở', () => {
    expect(
      gapStillOpen(recorded, [gap('2026-11-14T03:00:29.000Z', '2026-11-14T03:01:00.000Z')]),
    ).toBe(true);
  });

  it('khe hở ở chỗ khác của phiên, chỉ chạm mép → không tính là còn mở', () => {
    expect(
      gapStillOpen(recorded, [gap('2026-11-14T03:01:00.000Z', '2026-11-14T03:02:00.000Z')]),
    ).toBe(false);
    expect(
      gapStillOpen(recorded, [gap('2026-11-14T02:59:00.000Z', '2026-11-14T03:00:20.000Z')]),
    ).toBe(false);
  });

  it('khe hở rộng hơn trùm lên khoảng đã ghi → còn mở', () => {
    expect(
      gapStillOpen(recorded, [gap('2026-11-14T03:00:00.000Z', '2026-11-14T03:02:00.000Z')]),
    ).toBe(true);
  });

  it('closedRecordNo đọc số bản ghi được đóng; chuỗi lạ → null', () => {
    expect(closedRecordNo('gap_closed (late_sample): closes_record_no=12 samples=7 gaps=0')).toBe(
      12,
    );
    expect(closedRecordNo('gap_closed (late_sample): xcloses_record_no=12')).toBeNull();
    expect(closedRecordNo('conflict (late_sample): diff=3')).toBeNull();
    expect(closedRecordNo(null)).toBeNull();
  });
});
