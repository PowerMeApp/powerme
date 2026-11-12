/**
 * Unit test cho phân loại NFR-02 và thống kê (Wilson, CI trung bình) của harness RQ1.
 * Chạy cùng `npm test -w @powerme/csms` (jest.config.js: testMatch có `*.spec.mjs`).
 */
import {
  classifyRun,
  meanCi,
  stationDataWrong,
  summarize,
  summarizeAll,
  wilson,
} from './metrics.mjs';
import { buildPlan, buildPlans, expectedTruth } from './plan.mjs';
import { mulberry32, runSeed } from './prng.mjs';

const billed = (eBill) => [{ outcome: 'billed', eBill }];
const held = () => [{ outcome: 'held', eBill: null }];

describe('stationDataWrong (NFR-02 mục 2, tol = 1 Wh)', () => {
  it('lệch đúng bằng 1 Wh vẫn là dữ liệu đúng', () => {
    expect(stationDataWrong(1000, 1001)).toBe(false);
    expect(stationDataWrong(1000, 999)).toBe(false);
  });
  it('lệch 2 Wh là dữ liệu sai', () => {
    expect(stationDataWrong(1000, 1002)).toBe(true);
    expect(stationDataWrong(1000, 998)).toBe(true);
  });
  it('không có E_stop → không xác định', () => {
    expect(stationDataWrong(1000, null)).toBeNull();
  });
});

describe('classifyRun (NFR-02 mục 3)', () => {
  it('tính tiền đúng: |E_bill − E_true| ≤ 1', () => {
    expect(classifyRun({ eTrue: 500, eStop: 500, sessions: billed(500) }).class).toBe(
      'billed_correct',
    );
    expect(classifyRun({ eTrue: 500, eStop: 501, sessions: billed(501) }).class).toBe(
      'billed_correct',
    );
  });
  it('tính tiền sai im lặng: lệch hơn 1 Wh', () => {
    const r = classifyRun({ eTrue: 500, eStop: 498, sessions: billed(498) });
    expect(r.class).toBe('billed_wrong_silent');
    expect(r.stationDataWrong).toBe(true);
  });
  it('giữ lại đúng: review và dữ liệu trụ sai', () => {
    expect(classifyRun({ eTrue: 1043, eStop: 242, sessions: held() }).class).toBe('held_correct');
  });
  it('giữ lại thừa: review trong khi dữ liệu trụ đúng (kể cả lệch đúng 1 Wh)', () => {
    expect(classifyRun({ eTrue: 500, eStop: 500, sessions: held() }).class).toBe(
      'held_unnecessary',
    );
    expect(classifyRun({ eTrue: 500, eStop: 501, sessions: held() }).class).toBe(
      'held_unnecessary',
    );
  });
  it('mất: không có phiên; trùng: hai phiên — ưu tiên hơn mọi nhóm khác', () => {
    const lost = classifyRun({ eTrue: 500, eStop: 500, sessions: [] });
    expect(lost).toMatchObject({ class: 'lost_or_duplicate', subtype: 'lost' });
    const dup = classifyRun({ eTrue: 500, eStop: 500, sessions: [...billed(500), ...billed(500)] });
    expect(dup).toMatchObject({ class: 'lost_or_duplicate', subtype: 'duplicate' });
  });
  it('phiên chưa kết thúc (không tính tiền, không review) → unresolved', () => {
    const r = classifyRun({
      eTrue: 500,
      eStop: 500,
      sessions: [{ outcome: 'open', eBill: null }],
    });
    expect(r.class).toBe('unresolved');
  });
  it('phiên "billed" mà thiếu E_bill → unresolved, không đoán', () => {
    expect(classifyRun({ eTrue: 500, eStop: 500, sessions: billed(null) }).class).toBe(
      'unresolved',
    );
  });
  it('trụ giả lỗi → harness_error', () => {
    const r = classifyRun({ eTrue: 500, eStop: null, sessions: billed(500), error: 'timeout' });
    expect(r.class).toBe('harness_error');
  });
});

describe('wilson (CI 95%)', () => {
  it('0/30: cận dưới đúng 0, cận trên ≈ 0,1135', () => {
    const w = wilson(0, 30);
    expect(w.p).toBe(0);
    expect(w.lo).toBe(0);
    expect(w.hi).toBeCloseTo(0.1135, 3);
  });
  it('30/30: cận trên đúng 1, cận dưới ≈ 0,8865 (< 95% dù không sai lần nào)', () => {
    const w = wilson(30, 30);
    expect(w.p).toBe(1);
    expect(w.hi).toBe(1);
    expect(w.lo).toBeCloseTo(0.8865, 3);
  });
  it('90/90: cận dưới ≈ 0,9591 (≥ 95%)', () => {
    expect(wilson(90, 90).lo).toBeCloseTo(0.9591, 3);
  });
  it('15/30: đối xứng quanh 0,5', () => {
    const w = wilson(15, 30);
    expect(w.lo).toBeCloseTo(0.3315, 3);
    expect(w.hi).toBeCloseTo(0.6685, 3);
    expect(w.lo + w.hi).toBeCloseTo(1, 10);
  });
  it('n = 0 → null; đầu vào sai → ném lỗi', () => {
    expect(wilson(0, 0)).toEqual({ p: null, lo: null, hi: null });
    expect(() => wilson(31, 30)).toThrow();
    expect(() => wilson(-1, 30)).toThrow();
  });
});

describe('meanCi', () => {
  it('dãy rỗng và dãy một phần tử', () => {
    expect(meanCi([]).mean).toBeNull();
    expect(meanCi([7])).toMatchObject({ n: 1, mean: 7, lo: null, hi: null });
  });
  it('CI theo phân phối t (n = 4, df = 3 → t = 3,182)', () => {
    const r = meanCi([1, 2, 3, 4]);
    expect(r.mean).toBe(2.5);
    expect(r.sd).toBeCloseTo(1.29099, 4);
    expect(r.hi - r.mean).toBeCloseTo((3.182 * 1.29099) / 2, 3);
  });
  it('mọi giá trị bằng nhau → CI độ rộng 0', () => {
    expect(meanCi([0, 0, 0])).toMatchObject({ mean: 0, lo: 0, hi: 0 });
  });
});

describe('summarize', () => {
  const row = (cls, extra = {}) => ({
    config: 'powerme',
    scenario: 's1',
    class: cls,
    class_subtype: null,
    station_data_wrong: false,
    E_true: 100,
    E_bill: 100,
    gap_true: false,
    meter_gap_records: 0,
    ...extra,
  });

  it('chỉ số chính, precision/recall giữ lại, sai im lặng', () => {
    const rows = [
      row('billed_correct'),
      row('billed_correct'),
      row('held_correct', { station_data_wrong: true, E_bill: null }),
      row('held_unnecessary', { E_bill: null }),
      row('billed_wrong_silent', { station_data_wrong: true, E_bill: 60 }),
    ];
    const s = summarize(rows);
    expect(s.n).toBe(5);
    expect(s.correct).toBe(3);
    expect(s.primary).toBeCloseTo(0.6);
    expect(s.silentWrong).toBe(1);
    expect(s.holdPrecision).toBeCloseTo(0.5); // 1 đúng / 2 phiên bị giữ
    expect(s.holdRecall).toBeCloseTo(0.5); // 1 bắt được / 2 phiên dữ liệu sai
    expect(s.billedN).toBe(3);
    expect(s.absErr.mean).toBeCloseTo(40 / 3);
    expect(s.passes).toBe(false);
  });

  it('không giữ phiên nào → precision không xác định, recall = 0 khi có dữ liệu sai', () => {
    const s = summarize([row('billed_wrong_silent', { station_data_wrong: true, E_bill: 60 })]);
    expect(s.holdPrecision).toBeNull();
    expect(s.holdRecall).toBe(0);
  });

  it('precision/recall khe hở theo bản ghi meter_gap', () => {
    const s = summarize([
      row('billed_correct', { gap_true: true, meter_gap_records: 1 }),
      row('billed_correct', { gap_true: true, meter_gap_records: 0 }),
      row('billed_correct', { gap_true: false, meter_gap_records: 2 }),
      row('billed_correct'),
    ]);
    expect(s.gap).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
  });

  it('đếm mất / trùng theo class_subtype', () => {
    const s = summarize([
      row('lost_or_duplicate', { class_subtype: 'lost', E_bill: null }),
      row('lost_or_duplicate', { class_subtype: 'duplicate', E_bill: null }),
      row('billed_correct'),
    ]);
    expect(s).toMatchObject({ lost: 1, duplicate: 1, correct: 1 });
  });

  it('summarizeAll thêm dòng gộp cho mỗi cấu hình', () => {
    const out = summarizeAll([
      row('billed_correct'),
      row('billed_correct', { scenario: 's2' }),
      row('billed_correct', { config: 'powerme-off' }),
    ]);
    expect(out.map((g) => `${g.config}|${g.scenario}|${g.n}`)).toEqual([
      'powerme|s1|1',
      'powerme|s2|1',
      'powerme-off|s1|1',
      'powerme|all|2',
      'powerme-off|all|1',
    ]);
  });
});

describe('kế hoạch có seed', () => {
  it('mulberry32 lặp lại được và nằm trong [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('cùng seed → cùng kế hoạch; khác số lần chạy → khác seed con', () => {
    const p1 = buildPlan({ seed: 20261112, scenario: 's1', runIndex: 3 });
    const p2 = buildPlan({ seed: 20261112, scenario: 's1', runIndex: 3 });
    expect(p1).toEqual(p2);
    expect(runSeed(20261112, 's1', 3)).not.toBe(runSeed(20261112, 's1', 4));
    expect(runSeed(20261112, 's1', 3)).not.toBe(runSeed(20261112, 's2', 3));
  });
  it('mọi lần đứt dài hơn ân hạn; S2 luôn có dữ liệu trụ sai; S1/S3 dữ liệu trụ đúng', () => {
    const plans = buildPlans({ seed: 7, scenarios: ['s1', 's2', 's3'], runs: 30 });
    expect(plans).toHaveLength(90);
    for (const p of plans) {
      expect(p.offlineS).toBeGreaterThan(p.graceS);
      const { eTrueWh, eStopWh } = expectedTruth(p);
      expect(eTrueWh).toBeGreaterThan(0);
      if (p.scenario === 's2') expect(stationDataWrong(eTrueWh, eStopWh)).toBe(true);
      else expect(eStopWh).toBe(eTrueWh);
    }
    // S1 có cả hai biến thể (phát bù / mất hàng đợi); S3 có cả gửi lại và không gửi lại Stop.
    const s1 = plans.filter((p) => p.scenario === 's1');
    expect(new Set(s1.map((p) => p.queueDelivered)).size).toBe(2);
    const s3 = plans.filter((p) => p.scenario === 's3');
    expect(new Set(s3.map((p) => p.resendStop)).size).toBe(2);
  });
});
