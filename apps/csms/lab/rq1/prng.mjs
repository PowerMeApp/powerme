/**
 * Bộ sinh số ngẫu nhiên CÓ SEED cho harness RQ1 — để 30 lần chạy khác nhau nhưng lặp lại được.
 *
 * Vì sao tồn tại: SRS NFR-REC-01 yêu cầu "30 runs per scenario with fixed seeds". `Math.random()`
 * không đặt seed được, nên dùng mulberry32 (32 bit, đủ cho việc rút tham số kịch bản; KHÔNG dùng
 * cho mật mã). Cùng (seed, kịch bản, số thứ tự lần chạy) → cùng kế hoạch, trên mọi máy.
 */

/** FNV-1a 32 bit của một chuỗi: trộn seed gốc + kịch bản + số lần chạy thành seed con. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seed con của một lần chạy. Không phụ thuộc cấu hình: ba cấu hình nhận CÙNG kế hoạch. */
export function runSeed(seed, scenario, runIndex) {
  return hash32(`${seed}|${scenario}|${runIndex}`);
}

/** mulberry32: trả hàm sinh số thực trong [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tiện ích rút số trên một bộ sinh. */
export function createRandom(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /** Số nguyên trong [min, max] (hai đầu đều tính). */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    /** Số thực trong [min, max). */
    float: (min, max) => min + next() * (max - min),
    /** true với xác suất p. */
    chance: (p) => next() < p,
  };
}
