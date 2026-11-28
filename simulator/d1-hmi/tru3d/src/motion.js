// motion.js — bảng màu, kiểu nháy đèn và các hàm chuyển động (spring/damping) cho hình 3D.
//
// Màu đèn đọc từ biến CSS --lt-* (tru-sac.css) để 3D, SVG 2D và overlay dùng CÙNG một bảng; kiểu
// nháy bám bảng "Hình trụ sạc minh hoạ" trong README (QA-02).

export const STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Faulted',
  'Unavailable',
  'Reserved',
];

// Mặc định = bảng màu trong public/bevel-tokens.css (QA-10: bộ màu PowerMe, bản tối)
const FALLBACK = {
  Available: '#00e0c2',
  Preparing: '#7db7ff',
  Charging: '#00e0c2',
  SuspendedEV: '#ffc857',
  SuspendedEVSE: '#ffc857',
  Finishing: '#d4af37',
  Faulted: '#ff6b6b',
  Unavailable: '#7e8481',
  Reserved: '#b39dff',
};

export const VI = {
  Available: 'Sẵn sàng',
  Preparing: 'Chuẩn bị',
  Charging: 'Đang sạc',
  SuspendedEV: 'Tạm dừng · xe tạm dừng',
  SuspendedEVSE: 'Tạm dừng · trụ tạm dừng',
  Finishing: 'Kết thúc',
  Faulted: 'Lỗi',
  Unavailable: 'Ngừng',
  Reserved: 'Đặt trước',
};

/**
 * Cảnh sáng (Hero Sky, QA-06) hay tối (cảnh OLED cũ)? Đọc --t3-scene trên :root (bevel-tokens.css:
 * "light" mặc định, "dark" khi trang ở giao diện tối). Đọc một lần lúc gắn bundle.
 */
export function readSceneTheme() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--t3-scene').trim();
  return v === 'dark' ? 'dark' : 'light';
}

/** Đọc --lt-* từ :root; thiếu biến thì dùng giá trị mặc định của bevel-tokens.css. */
export function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const out = {};
  for (const st of STATUSES) out[st] = css.getPropertyValue(`--lt-${st}`).trim() || FALLBACK[st];
  return out;
}

export const knownStatus = (st) => (STATUSES.includes(st) ? st : 'Unavailable');

/** Cường độ đèn 0..1 theo thời gian (giây), đúng kiểu nháy trong README. */
export function lightLevel(st, t) {
  switch (st) {
    case 'Preparing':
      return 0.55 + 0.45 * Math.cos((t * Math.PI * 2) / 2); // nhấp nháy chậm 2 s
    case 'Charging':
      return 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3); // "thở" 3 s
    case 'SuspendedEV':
      return t % 1.6 < 0.8 ? 1 : 0.15; // nháy đều 1,6 s
    case 'SuspendedEVSE': {
      const u = t % 2; // xung đôi rồi nghỉ, chu kỳ 2 s
      return u < 0.2 || (u > 0.4 && u < 0.6) ? 1 : 0.15;
    }
    case 'Faulted':
      return t % 0.5 < 0.25 ? 1 : 0.1; // nháy nhanh 0,5 s
    default:
      return 1; // Available, Finishing, Unavailable, Reserved: tĩnh
  }
}

/**
 * "Tâm trạng" chung của trụ → màu quầng sáng sau trụ: đỏ khi có súng Faulted, emerald khi có súng
 * Charging, hổ phách khi Preparing/SuspendedEV/SuspendedEVSE, còn lại xám lạnh rất mờ.
 */
export function moodOf(connectors) {
  const sts = (connectors ?? []).map((c) => c.status);
  if (sts.includes('Faulted')) return 'fault';
  if (sts.includes('Charging')) return 'charge';
  if (sts.some((s) => s === 'Preparing' || s === 'SuspendedEV' || s === 'SuspendedEVSE'))
    return 'wait';
  return 'idle';
}
export function moodColor(mood, lt) {
  return {
    fault: lt.Faulted,
    charge: lt.Charging,
    wait: lt.SuspendedEV,
    idle: '#7d8da3',
  }[mood];
}
export const MOOD_GAIN = { fault: 1, charge: 1, wait: 0.8, idle: 0.32 };

/** Nội suy mũ, độc lập tốc độ khung hình. lambda lớn = bám nhanh. */
export const damp = (cur, target, lambda, dt) =>
  cur + (target - cur) * (1 - Math.exp(-lambda * dt));

/**
 * Lò xo có giảm chấn (s = { x, v }), bước nhỏ cố định cho ổn định khi dt lớn.
 * zeta < 1 → hơi vượt rồi về (cảm giác vật lý), zeta = 1 → giảm chấn tới hạn.
 */
export function spring(s, target, dt, k = 38, zeta = 0.78) {
  const c = 2 * Math.sqrt(k) * zeta;
  let left = Math.min(dt, 0.1);
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 120);
    const a = k * (target - s.x) - c * s.v;
    s.v += a * h;
    s.x += s.v * h;
    left -= h;
  }
  if (Math.abs(target - s.x) < 1e-4 && Math.abs(s.v) < 1e-3) {
    s.x = target;
    s.v = 0;
  }
  return s.x;
}

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const smooth = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Hệ số tốc độ hạt năng lượng theo bộ chọn mô phỏng (×1 / ×10 / ×20). */
export const speedFactor = (speed) => (speed >= 20 ? 2.6 : speed >= 10 ? 2 : 1);
