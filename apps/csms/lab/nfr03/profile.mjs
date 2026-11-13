/**
 * Hồ sơ tải CÓ SEED của từng trụ trong phép đo NFR-03 (hàm thuần, không I/O).
 *
 * Vì sao tồn tại: 50 trụ không được làm đúng một việc cùng một lúc (mọi trụ gửi MeterValues trong
 * cùng mili giây là tải giả), nhưng lần chạy lại phải lặp được. Mỗi trụ rút từ mulberry32 (bộ sinh
 * của harness RQ1, `../rq1/prng.mjs`) một chuỗi phiên sạc: nghỉ bao lâu, súng nào, công suất, mấy
 * nhịp MeterValues. Cùng (seed, số thứ tự trụ) → cùng chuỗi, trên mọi máy. Thời điểm THẬT của từng
 * bản tin vẫn phụ thuộc đồng hồ và độ trễ của CSMS, nên hai lần chạy cùng seed cho cùng kế hoạch
 * chứ không cho cùng số bản tin.
 */
import { createRandom, hash32 } from '../rq1/prng.mjs';

/** Mặc định của hồ sơ. Mọi giá trị được ghi vào meta.json. */
export const DEFAULT_PROFILE = {
  /** Nghỉ giữa hai phiên (giây): cắm súng, quẹt thẻ, rút súng. */
  idleMinS: 5,
  idleMaxS: 20,
  /** Trụ vừa nối xong chờ ngẫu nhiên trong khoảng này rồi mới bắt đầu phiên đầu (lệch pha). */
  firstIdleMaxS: 15,
  /** Số nhịp MeterValues của một phiên. Với nhịp 10 s: phiên dài 60–180 s. */
  ticksMin: 6,
  ticksMax: 18,
  /** Công suất phiên (kW) và dao động mỗi nhịp, như harness RQ1. */
  powerMinKw: 30,
  powerMaxKw: 120,
  powerJitter: 0.1,
};

/** Định danh của trụ tải thứ `index` (1..N). Serial là thứ nhận diện mọi dữ liệu do tải sinh ra. */
export function loadIdentity(index) {
  const nnnn = String(index).padStart(4, '0');
  return {
    index,
    serial: `LOAD-${nnnn}`,
    displayCode: `PM-LOAD-${nnnn}`,
    idTag: `LOADCARD${nnnn}`,
    email: `load-${nnnn}@load.powerme.test`,
  };
}

/**
 * Bộ sinh phiên của một trụ: `nextSession()` trả phiên kế tiếp
 * `{ idleS, connector, powerKw, whs[] }`, `whs[i]` là số Wh xe nhận trong nhịp thứ i.
 */
export function createStationProfile({ seed, index, meterIntervalS, profile = DEFAULT_PROFILE }) {
  const rng = createRandom(hash32(`${seed}|nfr03|${index}`));
  let first = true;
  const initialMeterWh = rng.int(0, 500_000);
  return {
    /** Số chỉ bộ đếm luỹ kế lúc trụ bắt đầu (Wh). */
    initialMeterWh,
    nextSession() {
      const idleS = first
        ? rng.float(0, profile.firstIdleMaxS)
        : rng.float(profile.idleMinS, profile.idleMaxS);
      first = false;
      const connector = rng.int(1, 2);
      const powerKw = rng.int(profile.powerMinKw, profile.powerMaxKw);
      const ticks = rng.int(profile.ticksMin, profile.ticksMax);
      const perTickWh = (powerKw * 1000 * meterIntervalS) / 3600;
      const whs = Array.from({ length: ticks }, () =>
        Math.max(
          1,
          Math.round(perTickWh * (1 + rng.float(-profile.powerJitter, profile.powerJitter))),
        ),
      );
      return { idleS, connector, powerKw, whs };
    },
  };
}
