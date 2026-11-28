/**
 * Kịch bản tải của harness RQ2 (T142) — hàm thuần, có seed, không đụng DB hay mạng.
 *
 * Mỗi request k nhận:
 *   - điểm đi + SoC: rút theo CẶP (k = 2p, 2p+1 dùng chung), KHÔNG phụ thuộc kịch bản (Q3, Q17)
 *     → quiet / peak / faulty nhận cùng 200 tình huống, chỉ tải khác;
 *   - trạng thái từng trạm + "sự thật nền" (thời gian chờ thật, trạm cũ có hỏng thật không):
 *     rút lại cho từng request (Q2), độc lập với hằng 30 / 5 phút mà CSMS dùng để ước lượng (Q4).
 *
 * Tham số trong SCENARIOS là ĐỀ XUẤT, chờ Ân duyệt (Q7); được ghi vào meta.json mỗi lượt chạy.
 */
import { createRandom, hash32 } from '../rq1/prng.mjs';

/** Vùng của `../nfr-res-01/road-points.json` (Thủ Đức, Q20). */
export const BBOX = Object.freeze({
  latMin: 10.855,
  latMax: 10.887,
  lngMin: 106.767,
  lngMax: 106.81,
});

export const SOC_RANGE = Object.freeze([15, 45]);
export const TARGET_SOC = 80;

/**
 * share.* là tỉ lệ trên các trạm còn lại sau khi đã tách trạm sự cố / trạm cũ-hỏng.
 * wait.* là khoảng thời gian chờ thật [min, max] phút, rút đều.
 */
export const SCENARIOS = Object.freeze({
  quiet: Object.freeze({
    share: { available: 0.8, in_use: 0.2, freeing_soon: 0 },
    wait: { in_use: [5, 40], freeing_soon: [0, 10] },
    faulted: 0,
    stale_broken: 0,
  }),
  peak: Object.freeze({
    share: { available: 0.25, in_use: 0.55, freeing_soon: 0.2 },
    wait: { in_use: [10, 60], freeing_soon: [0, 10] },
    faulted: 0,
    stale_broken: 0,
  }),
  faulty: Object.freeze({
    share: { available: 0.8, in_use: 0.2, freeing_soon: 0 },
    wait: { in_use: [5, 40], freeing_soon: [0, 10] },
    /** Tỉ lệ trạm có sự cố mở (CSMS ẩn khỏi cả hai cách xếp). */
    faulted: 0.15,
    /** Tỉ lệ trạm báo Available nhưng Status Quality = stale và thực tế hỏng. */
    stale_broken: 0.1,
  }),
});

export function scenarioOf(name) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`Kịch bản không hợp lệ: ${name} (quiet | peak | faulty)`);
  return s;
}

/** Điểm đi + SoC của cặp p — chỉ phụ thuộc seed gốc và p. */
export function drawOrigin(seed, pair) {
  const r = createRandom(hash32(`${seed}|rq2-origin|${pair}`));
  return {
    latitude: round6(r.float(BBOX.latMin, BBOX.latMax)),
    longitude: round6(r.float(BBOX.lngMin, BBOX.lngMax)),
    soc_percent: r.int(SOC_RANGE[0], SOC_RANGE[1]),
  };
}

/**
 * Trạng thái và sự thật nền của `stationCount` trạm cho request k.
 * Trả mảng theo chỉ số trạm: { state, true_wait_min }.
 *   state ∈ available | in_use | freeing_soon | faulted | stale_broken
 */
export function drawLoad(scenario, seed, k, stationCount) {
  const s = scenarioOf(scenario);
  const r = createRandom(hash32(`${seed}|rq2-load|${scenario}|${k}`));
  const order = shuffle(
    Array.from({ length: stationCount }, (_, i) => i),
    r,
  );
  const nFaulted = Math.round(s.faulted * stationCount);
  const nStale = Math.round(s.stale_broken * stationCount);
  const load = new Array(stationCount);
  order.forEach((index, pos) => {
    if (pos < nFaulted) load[index] = { state: 'faulted', true_wait_min: null };
    else if (pos < nFaulted + nStale) load[index] = { state: 'stale_broken', true_wait_min: null };
  });
  for (let i = 0; i < stationCount; i++) {
    if (load[i]) continue;
    const x = r.next();
    const state =
      x < s.share.available
        ? 'available'
        : x < s.share.available + s.share.in_use
          ? 'in_use'
          : 'freeing_soon';
    const range = s.wait[state];
    load[i] = {
      state,
      true_wait_min: state === 'available' ? 0 : round1(r.float(range[0], range[1])),
    };
  }
  return load;
}

/** Một request đầy đủ: cặp, điểm đi, SoC, tải. */
export function drawRequest(scenario, seed, k, stationCount) {
  const pair = Math.floor(k / 2);
  return { k, pair, ...drawOrigin(seed, pair), load: drawLoad(scenario, seed, k, stationCount) };
}

function shuffle(items, r) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const round1 = (x) => Math.round(x * 10) / 10;
