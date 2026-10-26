/**
 * Unit test ReplayDetector với số thật của EXP-01 (epoch 2 mở 14:20:22.978Z, ngưỡng 5 s).
 */
import { ReplayDetector } from './replay-detector.js';

const EPOCH2 = new Date('2026-09-16T14:20:22.978Z');
const detector = new ReplayDetector(5);

describe('ReplayDetector', () => {
  it('live: cp_timestamp sau epoch, skew ≈ 0 → không phát lại (EXP-01 MeterValues 796 Wh)', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:27.901Z'),
      receivedAt: new Date('2026-09-16T14:20:27.903Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v).toEqual({ replayed: false, reason: null, skewS: 0.002 });
  });

  it('trước epoch: StopTransaction tx3 cp_timestamp 14:18:52.934 nhận lúc 14:20:58.209 → before_epoch, skew 125,3 s', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:18:52.934Z'),
      receivedAt: new Date('2026-09-16T14:20:58.209Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v.replayed).toBe(true);
    expect(v.reason).toBe('before_epoch');
    expect(v.skewS).toBeCloseTo(125.275, 3);
  });

  it('skew lớn nhưng cùng epoch (đồng hồ trụ chậm) → phát lại theo luật phụ "skew"', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:30.000Z'),
      receivedAt: new Date('2026-09-16T14:21:00.000Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v).toEqual({ replayed: true, reason: 'skew', skewS: 30 });
  });

  it('biên: skew đúng bằng ngưỡng 5 s → KHÔNG phát lại (luật là lớn hơn)', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:30.000Z'),
      receivedAt: new Date('2026-09-16T14:20:35.000Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v).toEqual({ replayed: false, reason: null, skewS: 5 });
  });

  it('biên: skew vượt ngưỡng 1 ms → phát lại', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:30.000Z'),
      receivedAt: new Date('2026-09-16T14:20:35.001Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v.replayed).toBe(true);
    expect(v.reason).toBe('skew');
  });

  it('G9: tin sinh 0,2 s TRƯỚC khi socket mở rồi gửi ngay (StatusNotification lúc trụ vừa nối) → live, không phải phát lại', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:22.778Z'),
      receivedAt: new Date('2026-09-16T14:20:23.010Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v.replayed).toBe(false);
    expect(v.reason).toBeNull();
  });

  it('G9 biên: sớm hơn epoch đúng bằng dung sai 5 s → KHÔNG phát lại (luật là lớn hơn)', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:17.978Z'),
      receivedAt: EPOCH2, // tin chỉ tới được SAU khi socket mở → skew = lead = 5 s đúng ngưỡng
      epochOpenedAt: EPOCH2,
    });
    expect(v.replayed).toBe(false);
  });

  it('G9 biên: sớm hơn epoch 5,001 s → before_epoch', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:17.977Z'),
      receivedAt: new Date('2026-09-16T14:20:23.010Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v.replayed).toBe(true);
    expect(v.reason).toBe('before_epoch');
  });

  it('dung sai theo cấu hình: ngưỡng 0 → hành vi cũ, sớm hơn epoch 1 ms cũng là phát lại', () => {
    const strict = new ReplayDetector(0);
    const v = strict.classify({
      cpTimestamp: new Date('2026-09-16T14:20:22.977Z'),
      receivedAt: new Date('2026-09-16T14:20:22.980Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v.reason).toBe('before_epoch');
  });

  it('biên: cp_timestamp đúng bằng epoch_opened_at → không phải before_epoch', () => {
    const v = detector.classify({ cpTimestamp: EPOCH2, receivedAt: EPOCH2, epochOpenedAt: EPOCH2 });
    expect(v).toEqual({ replayed: false, reason: null, skewS: 0 });
  });

  it('đồng hồ trụ chạy trước CSMS (skew âm) trong cùng epoch → live', () => {
    const v = detector.classify({
      cpTimestamp: new Date('2026-09-16T14:20:40.000Z'),
      receivedAt: new Date('2026-09-16T14:20:30.000Z'),
      epochOpenedAt: EPOCH2,
    });
    expect(v).toEqual({ replayed: false, reason: null, skewS: -10 });
  });

  it('không có cp_timestamp (Heartbeat, StatusNotification của SAP) → không phân loại được, coi là live', () => {
    const v = detector.classify({
      cpTimestamp: null,
      receivedAt: new Date(),
      epochOpenedAt: EPOCH2,
    });
    expect(v).toEqual({ replayed: false, reason: null, skewS: null });
  });

  it('ngưỡng âm bị từ chối lúc khởi tạo', () => {
    expect(() => new ReplayDetector(-1)).toThrow();
  });
});
