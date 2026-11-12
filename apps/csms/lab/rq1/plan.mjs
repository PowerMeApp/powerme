/**
 * Kế hoạch một lần chạy RQ1 — HÀM THUẦN: (seed, kịch bản, số lần chạy, tham số thời gian) → mọi
 * con số trụ sẽ dùng (công suất, số mẫu, thời điểm và độ dài đứt, lỗi được gây ra).
 *
 * Vì sao tồn tại: sự thật nền `E_true` phải KHÔNG phụ thuộc đồng hồ máy hay CSMS đang đo. Năng
 * lượng chỉ tăng theo "nhịp" (tick) với lượng Wh đã rút sẵn ở đây, nên cùng seed → cùng `E_true`,
 * cùng `E_stop`, trên cả ba cấu hình (PowerMe, PowerMe tắt đối soát, SteVe).
 *
 * Ba kịch bản bám tiêu đề đã chốt trong phiếu đăng ký v1.3 §RQ1 ("disconnects during meter
 * reporting, just before StopTransaction, and during an offline-started session"). Phần tham số
 * hoá chi tiết bên dưới là ĐỀ XUẤT của harness, chờ Ân duyệt (xem README mục "Ba kịch bản").
 */
import { createRandom, runSeed } from './prng.mjs';

export const SCENARIOS = ['s1', 's2', 's3'];

export const SCENARIO_TITLES = {
  s1: 'Đứt giữa chuỗi MeterValues, nối lại, dừng bình thường (dữ liệu trụ đúng)',
  s2: 'Đứt ngay trước StopTransaction, trụ phát lại meterStop cũ (dữ liệu trụ sai)',
  s3: 'Phiên bắt đầu khi offline, trụ gửi lại StartTransaction/StopTransaction y nguyên (rủi ro trùng)',
};

/** Tham số thời gian mặc định của THÍ NGHIỆM (đã rút ngắn so với sản phẩm, xem README). */
export const DEFAULT_TIMING = {
  /** Nhịp MeterValues của trụ (s). Sản phẩm: 10 s. CSMS phải chạy cùng METER_VALUE_SAMPLE_INTERVAL_S. */
  intervalS: 2,
  /** OFFLINE_GRACE_S của CSMS (s). Sản phẩm: 120 s. Kịch bản rút độ dài đứt LỚN HƠN giá trị này. */
  graceS: 5,
  /** Phần cộng thêm tối đa (s) trên ân hạn khi rút độ dài đứt. */
  offlineExtraMaxS: 9,
  /** Nghỉ giữa hai lần nối khi mô phỏng "mất phản hồi" ở S3 (s) — ngắn hơn ân hạn. */
  retransmitGapS: 1,
};

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Lập kế hoạch cho một lần chạy.
 * @returns đối tượng thuần JSON; `ticksWh` là lượng Wh cộng vào bộ đếm ở từng nhịp, theo thứ tự.
 */
export function buildPlan({ seed, scenario, runIndex, timing = DEFAULT_TIMING, s2QueueLostP = 0 }) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`kịch bản lạ: ${scenario}`);
  const t = { ...DEFAULT_TIMING, ...timing };
  const sub = runSeed(seed, scenario, runIndex);
  const rnd = createRandom(sub);

  // Công suất 30–120 kW (trụ D1-120), mỗi nhịp dao động ±10%. Bộ đếm là số nguyên Wh.
  const powerW = rnd.int(30, 120) * 1000;
  const baseTickWh = (powerW * t.intervalS) / 3600;
  const tick = () => Math.max(2, Math.round(baseTickWh * rnd.float(0.9, 1.1)));
  // meterStart khác 0: bộ đếm luỹ kế của trụ, để lộ lỗi quên trừ meterStart.
  const meterStartWh = rnd.int(0, 500_000);

  const plan = {
    scenario,
    runIndex,
    seed,
    runSeed: sub,
    intervalS: t.intervalS,
    graceS: t.graceS,
    powerW,
    meterStartWh,
  };

  if (scenario === 's1') {
    const preTicks = rnd.int(2, 5);
    const offlineS = round1(t.graceS + 1 + rnd.float(0, t.offlineExtraMaxS));
    const offlineTicks = Math.floor(offlineS / t.intervalS);
    const postTicks = rnd.int(2, 4);
    // Nửa số lần chạy trụ phát bù hàng đợi MeterValues, nửa còn lại làm mất hàng đợi (EXP-01 hiện
    // tượng 4: mất mẫu im lặng) → có khe hở thật để đo precision/recall của bản ghi meter_gap.
    const queueDelivered = rnd.chance(0.5);
    return {
      ...plan,
      preTicks,
      offlineTicks,
      postTicks,
      offlineS,
      queueDelivered,
      preWh: Array.from({ length: preTicks }, tick),
      offlineWh: Array.from({ length: offlineTicks }, tick),
      postWh: Array.from({ length: postTicks }, tick),
      tailWh: rnd.int(0, Math.round(baseTickWh)),
    };
  }

  if (scenario === 's2') {
    const preTicks = rnd.int(2, 5);
    // Sau khi đứt, xe còn sạc thêm 1–4 nhịp rồi tài xế dừng (trụ vẫn offline).
    const offlineTicks = rnd.int(1, 4);
    const offlineS = round1(
      Math.max(t.graceS + 1 + rnd.float(0, t.offlineExtraMaxS), offlineTicks * t.intervalS + 0.5),
    );
    const preWh = Array.from({ length: preTicks }, tick);
    const offlineWh = Array.from({ length: offlineTicks }, tick);
    const tailWh = rnd.int(0, Math.round(baseTickWh));
    // Chính thức: hàng đợi MeterValues LUÔN được phát bù (như EXP-01). `s2QueueLostP` > 0 chỉ dùng
    // cho lần chạy THĂM DÒ ngoài 3 kịch bản (README mục "Phát hiện"); số ngẫu nhiên rút sau cùng
    // nên không làm đổi các tham số khác của kế hoạch.
    const queueDelivered = !rnd.chance(s2QueueLostP);
    return {
      ...plan,
      preTicks,
      offlineTicks,
      postTicks: 0,
      offlineS,
      staleMeterStop: true,
      queueDelivered,
      preWh,
      offlineWh,
      postWh: [],
      tailWh,
    };
  }

  // s3: phiên bắt đầu ngay sau khi đứt và sạc suốt lúc offline (đo đều mỗi nhịp).
  const offlineS = round1(t.graceS + 1 + rnd.float(0, t.offlineExtraMaxS));
  const offlineTicks = Math.floor(offlineS / t.intervalS);
  const postTicks = rnd.int(2, 4);
  return {
    ...plan,
    preTicks: 0,
    offlineTicks,
    postTicks,
    offlineS,
    resendStart: true,
    resendStop: rnd.chance(0.5),
    retransmitGapS: t.retransmitGapS,
    preWh: [],
    offlineWh: Array.from({ length: offlineTicks }, tick),
    postWh: Array.from({ length: postTicks }, tick),
    tailWh: rnd.int(0, Math.round(baseTickWh)),
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Sự thật nền SUY RA TỪ KẾ HOẠCH (không cần chạy): dùng để test và để đối chiếu với số trụ ghi
 * lại lúc chạy thật — hai số phải bằng nhau, lệch nghĩa là trụ giả có lỗi.
 */
export function expectedTruth(plan) {
  const eTrue = sum(plan.preWh) + sum(plan.offlineWh) + sum(plan.postWh) + plan.tailWh;
  // S2: meterStop đóng băng ở giá trị lúc đứt (EXP-01 hiện tượng 3).
  const eStop = plan.scenario === 's2' ? sum(plan.preWh) : eTrue;
  return { eTrueWh: eTrue, eStopWh: eStop };
}

/** Danh sách kế hoạch cho `runs` lần chạy của các kịch bản đã chọn (số thứ tự bắt đầu từ 1). */
export function buildPlans({ seed, scenarios, runs, timing, s2QueueLostP = 0 }) {
  const plans = [];
  for (const scenario of scenarios) {
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      plans.push(buildPlan({ seed, scenario, runIndex, timing, s2QueueLostP }));
    }
  }
  return plans;
}
