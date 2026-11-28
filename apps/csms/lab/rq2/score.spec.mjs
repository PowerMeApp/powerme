/**
 * Unit test chấm điểm và tổng hợp RQ2 (T142). Chạy cùng `npm test -w @powerme/csms`.
 */
import { stats, summarize, verdicts } from './analyze.mjs';
import {
  chargeMin,
  haversineKm,
  nearestUsable,
  outcome,
  scoreRequest,
  straightDriveMin,
  verdict,
} from './score.mjs';

// Ba trạm trên một đường kinh tuyến, cách nhau ~1,11 km.
const stations = [
  { latitude: 10.86, longitude: 106.78, power_kw: 120 },
  { latitude: 10.87, longitude: 106.78, power_kw: 60 },
  { latitude: 10.88, longitude: 106.78, power_kw: 120 },
];
const origin = { latitude: 10.86, longitude: 106.78 };
const free = { state: 'available', true_wait_min: 0 };

describe('công thức', () => {
  it('lái xe đường thẳng BR-P41: km × 1,3 ở 30 km/h', () => {
    const km = haversineKm(stations[0], stations[1]);
    expect(km).toBeCloseTo(1.112, 2);
    expect(straightDriveMin(stations[0], stations[1])).toBeCloseTo(km * 1.3 * 2, 6);
  });

  it('sạc tới 80 % bị giới hạn bởi công suất xe 100 kW', () => {
    expect(chargeMin(20, 60)).toBeCloseTo(((60 * 0.6) / 60) * 60, 6); // 36 phút
    expect(chargeMin(20, 120)).toBeCloseTo(((60 * 0.6) / 100) * 60, 6); // 21,6 phút
  });
});

describe('outcome', () => {
  it('trạm đang sạc: lái + chờ thật + sạc', () => {
    const load = [{ state: 'in_use', true_wait_min: 25 }, free, free];
    const r = outcome({ stations, load, index: 0, socPercent: 20, driveMin: 0 });
    expect(r).toMatchObject({ start_min: 25, detour: false, final_index: 0 });
    expect(r.target_min).toBeCloseTo(25 + 21.6, 2);
  });

  it('trạm cũ mà hỏng: đi vòng một lần sang trạm dùng được gần nhất, cộng chờ ở đó (Q12)', () => {
    const load = [
      { state: 'stale_broken', true_wait_min: null },
      { state: 'in_use', true_wait_min: 10 },
      free,
    ];
    const r = outcome({ stations, load, index: 0, socPercent: 20, driveMin: 3 });
    expect(r.detour).toBe(true);
    expect(r.final_index).toBe(1);
    expect(r.start_min).toBeCloseTo(3 + straightDriveMin(stations[0], stations[1]) + 10, 2);
    expect(r.target_min).toBeCloseTo(r.start_min + 36, 1); // trạm 1 chỉ 60 kW
  });

  it('nearestUsable bỏ qua trạm sự cố và chính trạm xuất phát', () => {
    const load = [free, { state: 'faulted', true_wait_min: null }, free];
    expect(nearestUsable(stations, load, 0)).toBe(2);
  });
});

describe('scoreRequest', () => {
  it('delta = baseline − smart; chỉ số phụ chỉ có khi cả hai trạm có road_estimate (Q10)', () => {
    const load = [{ state: 'in_use', true_wait_min: 40 }, free, free];
    const base = { stations, load, origin, socPercent: 20, smartIndex: 2, baselineIndex: 0 };
    const r = scoreRequest({ ...base, roadMin: new Map([[2, 5]]) });
    expect(r.baseline.start_min).toBe(40);
    expect(r.smart.start_min).toBeCloseTo(straightDriveMin(origin, stations[2]), 1);
    expect(r.delta_start_min).toBeCloseTo(40 - r.smart.start_min, 1);
    expect(r.road).toBeUndefined();
    const withRoad = scoreRequest({
      ...base,
      roadMin: new Map([
        [2, 5],
        [0, 1],
      ]),
    });
    expect(withRoad.road.delta_start_min).toBeCloseTo(41 - 5, 2);
  });

  it('thắng / hoà / thua theo ±1 phút (Q11)', () => {
    expect([verdict(1.5), verdict(1), verdict(-0.5), verdict(-2), verdict(null)]).toEqual([
      'win',
      'tie',
      'tie',
      'loss',
      null,
    ]);
  });
});

describe('analyze', () => {
  it('stats: trung bình, trung vị, p90 (nearest-rank)', () => {
    expect(stats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null])).toEqual({
      n: 10,
      mean: 5.5,
      median: 5.5,
      p90: 9,
    });
    expect(stats([])).toEqual({ n: 0, mean: null, median: null, p90: null });
  });

  it('verdicts kèm Wilson 95 %', () => {
    const v = verdicts([5, 5, 0, -5]);
    expect(v).toMatchObject({ n: 4, win: 2, tie: 1, loss: 1, win_rate: 0.5 });
    expect(v.win_lo).toBeLessThan(0.5);
    expect(v.win_hi).toBeGreaterThan(0.5);
  });

  it('summarize: tách tỉ lệ brief, cảnh báo khi > 20 % (Q13)', () => {
    const row = (k, source, delta) => ({
      phase: 'request',
      scenario: 'quiet',
      k,
      ranking_source: source,
      route_calls: source === 'brief' ? 0 : 6,
      smart: { site_id: '1', start_min: 10, target_min: 30, detour: false },
      baseline: { site_id: '2', start_min: 10 + delta, target_min: 30 + delta, detour: false },
      delta_start_min: delta,
      delta_target_min: delta,
    });
    const s = summarize([
      row(0, 'vietmap_route', 5),
      row(1, 'brief', 0),
      row(2, 'vietmap_route', -3),
    ]).quiet;
    expect(s).toMatchObject({ requests: 3, route_calls: 12, brief: 1, brief_warning: true });
    expect(s.all.target_min.verdicts).toMatchObject({ win: 1, tie: 1, loss: 1 });
    expect(s.vietmap_route_only.target_min.verdicts.n).toBe(2);
  });
});
