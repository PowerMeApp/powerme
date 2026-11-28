/**
 * Chấm điểm RQ2 (T142) — hàm thuần. Tính "Time until charging starts" và "Time until charged"
 * (GLOSSARY.md) của trạm mà một cách xếp đã chọn, theo sự thật nền của scenarios.mjs.
 *
 * Quy ước đã chốt (buổi hỏi 19/11/2026):
 *   - Q10: chỉ số CHÍNH chấm lái xe của cả hai bên bằng cùng công thức đường thẳng BR-P41
 *     (khoảng cách × 1,3 ở 30 km/h); chỉ số PHỤ dùng road_estimate Vietmap khi CẢ HAI trạm có.
 *   - Q12: chọn trúng trạm hỏng → đi vòng MỘT lần sang trạm còn dùng được gần nhất tính từ trạm
 *     hỏng (đường thẳng), cộng chờ thật ở đó.
 *   - Q6: sạc tới 80 %, kWh cần ÷ min(kW súng, kW xe); không mô hình hoá giảm công suất khi gần đầy.
 */

/** Xe seed của `../nfr-res-01/local.mjs`: 60 kWh, 320 km, tối đa 100 kW DC, CCS2. */
export const VEHICLE = Object.freeze({ battery_kwh: 60, max_dc_kw: 100 });
/** BR-P41 / DEFAULT_SMART_SEARCH: road_factor 1,3; avg_speed_kmh 30. */
export const ROAD_FACTOR = 1.3;
export const AVG_SPEED_KMH = 30;
/** Q11: chênh trong ±1 phút là hoà. */
export const TIE_MIN = 1;

const USABLE = new Set(['available', 'in_use', 'freeing_soon']);

export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Phút lái theo đường thẳng BR-P41. */
export function straightDriveMin(from, to) {
  return ((haversineKm(from, to) * ROAD_FACTOR) / AVG_SPEED_KMH) * 60;
}

export function chargeMin(socPercent, powerKw, targetSoc = 80) {
  const kw = Math.min(powerKw, VEHICLE.max_dc_kw);
  return ((VEHICLE.battery_kwh * (targetSoc - socPercent)) / 100 / kw) * 60;
}

/** Trạm còn dùng được gần nhất tính từ trạm `from` (không tính chính nó). */
export function nearestUsable(stations, load, fromIndex) {
  let best = null;
  for (let i = 0; i < stations.length; i++) {
    if (i === fromIndex || !USABLE.has(load[i].state)) continue;
    const km = haversineKm(stations[fromIndex], stations[i]);
    if (best === null || km < best.km) best = { index: i, km };
  }
  return best?.index ?? null;
}

/**
 * Kết quả khi tài xế đi tới trạm `index`.
 * `driveMin`: phút lái từ điểm đi tới trạm đó (đường thẳng cho chỉ số chính, Vietmap cho chỉ số phụ).
 */
export function outcome({ stations, load, index, socPercent, driveMin, targetSoc = 80 }) {
  let final = index;
  let drive = driveMin;
  let detour = false;
  if (!USABLE.has(load[index].state)) {
    const next = nearestUsable(stations, load, index);
    if (next === null)
      return { start_min: null, target_min: null, detour: true, final_index: null };
    drive += straightDriveMin(stations[index], stations[next]);
    final = next;
    detour = true;
  }
  const start = drive + load[final].true_wait_min;
  return {
    start_min: round2(start),
    target_min: round2(start + chargeMin(socPercent, stations[final].power_kw, targetSoc)),
    detour,
    final_index: final,
  };
}

/**
 * Chấm một request: smart và baseline (nearest compatible station, Q1).
 * `roadMin`: Map chỉ số trạm → phút Vietmap (từ road_estimate của phản hồi smart).
 */
export function scoreRequest({
  stations,
  load,
  origin,
  socPercent,
  smartIndex,
  baselineIndex,
  roadMin,
}) {
  const side = (index) => {
    const main = outcome({
      stations,
      load,
      index,
      socPercent,
      driveMin: straightDriveMin(origin, stations[index]),
    });
    return { index, state: load[index].state, ...main };
  };
  const smart = side(smartIndex);
  const baseline = side(baselineIndex);
  const result = {
    smart,
    baseline,
    delta_start_min: diff(baseline.start_min, smart.start_min),
    delta_target_min: diff(baseline.target_min, smart.target_min),
  };
  // Chỉ số phụ (Q10): chỉ khi cả hai trạm đều có road_estimate.
  if (roadMin?.has(smartIndex) && roadMin?.has(baselineIndex)) {
    const roadSide = (index) =>
      outcome({ stations, load, index, socPercent, driveMin: roadMin.get(index) });
    const s = roadSide(smartIndex);
    const b = roadSide(baselineIndex);
    result.road = {
      smart_target_min: s.target_min,
      baseline_target_min: b.target_min,
      delta_start_min: diff(b.start_min, s.start_min),
      delta_target_min: diff(b.target_min, s.target_min),
    };
  }
  return result;
}

/** Dương = smart nhanh hơn. */
export function verdict(delta) {
  if (delta === null) return null;
  return delta > TIE_MIN ? 'win' : delta < -TIE_MIN ? 'loss' : 'tie';
}

const diff = (b, s) => (b === null || s === null ? null : round2(b - s));
const round2 = (x) => Math.round(x * 100) / 100;
