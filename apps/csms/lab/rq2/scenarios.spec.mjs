/**
 * Unit test kịch bản RQ2 (T142). Chạy cùng `npm test -w @powerme/csms` (jest.config.js).
 */
import { BBOX, drawLoad, drawOrigin, drawRequest, SCENARIOS, SOC_RANGE } from './scenarios.mjs';

const N = 50;
const count = (load, state) => load.filter((x) => x.state === state).length;

describe('drawOrigin', () => {
  it('lặp lại được theo seed, nằm trong vùng Thủ Đức và khoảng SoC', () => {
    for (let p = 0; p < 100; p++) {
      const o = drawOrigin(20261120, p);
      expect(drawOrigin(20261120, p)).toEqual(o);
      expect(o.latitude).toBeGreaterThanOrEqual(BBOX.latMin);
      expect(o.latitude).toBeLessThanOrEqual(BBOX.latMax);
      expect(o.longitude).toBeGreaterThanOrEqual(BBOX.lngMin);
      expect(o.longitude).toBeLessThanOrEqual(BBOX.lngMax);
      expect(o.soc_percent).toBeGreaterThanOrEqual(SOC_RANGE[0]);
      expect(o.soc_percent).toBeLessThanOrEqual(SOC_RANGE[1]);
    }
    expect(drawOrigin(20261120, 0)).not.toEqual(drawOrigin(20261121, 0));
  });
});

describe('drawRequest', () => {
  it('hai request liền nhau dùng chung điểm đi nhưng tải khác (Q3, Q2)', () => {
    const a = drawRequest('peak', 1, 6, N);
    const b = drawRequest('peak', 1, 7, N);
    const c = drawRequest('peak', 1, 8, N);
    expect(a.pair).toBe(3);
    expect(b.pair).toBe(3);
    expect([b.latitude, b.longitude, b.soc_percent]).toEqual([
      a.latitude,
      a.longitude,
      a.soc_percent,
    ]);
    expect(b.load).not.toEqual(a.load);
    expect([c.latitude, c.longitude]).not.toEqual([a.latitude, a.longitude]);
  });

  it('ba kịch bản nhận cùng điểm đi và SoC, tải khác (Q17)', () => {
    const [q, p, f] = ['quiet', 'peak', 'faulty'].map((s) => drawRequest(s, 9, 41, N));
    expect([p.latitude, p.soc_percent]).toEqual([q.latitude, q.soc_percent]);
    expect([f.longitude, f.soc_percent]).toEqual([q.longitude, q.soc_percent]);
    expect(p.load).not.toEqual(q.load);
  });

  it('cùng (seed, kịch bản, k) cho cùng tải', () => {
    expect(drawRequest('faulty', 5, 12, N)).toEqual(drawRequest('faulty', 5, 12, N));
  });
});

describe('drawLoad', () => {
  it('quiet: không có trạm sự cố / cũ-hỏng, khoảng 80 % rảnh, chờ thật 5–40 phút', () => {
    let available = 0;
    for (let k = 0; k < 200; k++) {
      const load = drawLoad('quiet', 1, k, N);
      expect(
        count(load, 'faulted') + count(load, 'stale_broken') + count(load, 'freeing_soon'),
      ).toBe(0);
      available += count(load, 'available');
      for (const x of load) {
        if (x.state === 'available') expect(x.true_wait_min).toBe(0);
        else {
          expect(x.true_wait_min).toBeGreaterThanOrEqual(5);
          expect(x.true_wait_min).toBeLessThanOrEqual(40);
        }
      }
    }
    expect(available / (200 * N)).toBeCloseTo(SCENARIOS.quiet.share.available, 1);
  });

  it('peak: tỉ lệ rảnh / đang sạc / sắp xong xấp xỉ 25 / 55 / 20 %', () => {
    const totals = { available: 0, in_use: 0, freeing_soon: 0 };
    for (let k = 0; k < 200; k++) {
      const load = drawLoad('peak', 1, k, N);
      for (const s of Object.keys(totals)) totals[s] += count(load, s);
    }
    for (const [s, n] of Object.entries(totals))
      expect(n / (200 * N)).toBeCloseTo(SCENARIOS.peak.share[s], 1);
  });

  it('faulty: đúng 8 trạm có sự cố mở và 5 trạm báo rảnh nhưng hỏng mỗi request (Q5)', () => {
    for (let k = 0; k < 20; k++) {
      const load = drawLoad('faulty', 1, k, N);
      expect(count(load, 'faulted')).toBe(8);
      expect(count(load, 'stale_broken')).toBe(5);
    }
  });

  it('kịch bản lạ bị từ chối', () => {
    expect(() => drawLoad('busy', 1, 0, N)).toThrow(/quiet \| peak \| faulty/);
  });
});
