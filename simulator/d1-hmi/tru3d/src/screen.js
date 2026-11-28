// screen.js — vẽ màn hình trụ (kWh / kW / SoC từng súng) lên canvas 2D, dùng làm texture phát sáng.
//
// Chỉ vẽ lại khi nội dung đổi (khoá chuỗi), không vẽ mỗi khung.
import { VI } from './motion.js';

export const SCREEN_W = 1024; // kích thước LOGIC để vẽ
export const SCREEN_H = 640;
// Canvas thật = logic × 2 (2048 × 1280) để chữ trên màn hình vẫn sắc ở dpr 2 khi phóng gần;
// Scene đặt ctx.setTransform(SCREEN_SCALE, …) một lần, drawScreen vẫn vẽ theo toạ độ logic.
export const SCREEN_SCALE = 2;
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const MONO = '"Cascadia Mono", Consolas, ui-monospace, monospace';
const INK = '#e9eef5';
const MUTED = '#7f8ea3';

const pad = (n) => String(n).padStart(2, '0');
const dur = (s) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

function half(c, lt) {
  const col = lt[c.status] ?? lt.Unavailable;
  const soc = c.soc == null ? null : c.soc;
  const base = { col, status: VI[c.status] ?? c.status, soc };
  switch (c.status) {
    case 'Charging':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
      return {
        ...base,
        big: c.kw.toFixed(1),
        unit: 'kW',
        lines: [`${c.kwh.toFixed(2)} kWh`, dur(c.elapsed)],
      };
    case 'Preparing':
      return {
        ...base,
        title: c.plugged ? 'Đã cắm súng' : 'Cắm súng vào xe',
        lines: [
          c.remoteWaitSec != null
            ? `Lệnh từ app · chờ ${c.remoteWaitSec} s`
            : c.plugged
              ? 'chờ lệnh / thẻ'
              : '',
        ],
      };
    case 'Available':
      return { ...base, title: 'Sẵn sàng', lines: ['quẹt thẻ hoặc quét QR'] };
    case 'Finishing':
      return { ...base, title: 'Rút súng', lines: [`${c.kwh.toFixed(2)} kWh`] };
    case 'Faulted':
      return { ...base, title: 'LỖI', lines: [String(c.errorCode ?? '').slice(0, 20)] };
    case 'Reserved':
      return { ...base, title: 'Đã đặt trước', lines: [] };
    default:
      return { ...base, title: 'Ngừng phục vụ', lines: [] };
  }
}

// Nền nhạt của viên trạng thái (màu đèn ~15 % độ đậm); màu không phải hex 6 số thì dùng trắng mờ.
const tint = (col) => (/^#[0-9a-f]{6}$/i.test(col) ? col + '26' : 'rgba(255,255,255,0.1)');

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Trả về true nếu đã vẽ lại (cần texture.needsUpdate). */
export function drawScreen(ctx, s, lt, prevKey) {
  const n = s.net;
  const strip =
    n.state === 'online' && !n.halfOpen
      ? ['● TRỰC TUYẾN', lt.Available]
      : n.state === 'offline'
        ? [
            n.nextRetrySec != null
              ? `● MẤT KẾT NỐI · thử lại ${n.nextRetrySec} s`
              : '● MẤT KẾT NỐI',
            lt.Faulted,
          ]
        : ['● ĐANG NỐI LẠI', lt.SuspendedEV];
  const halves = s.connectors.slice(0, 2).map((c) => half(c, lt));
  const clock = `${s.simTime.slice(11, 16)} UTC`;
  const key = JSON.stringify([strip, clock, s.speed, halves]);
  if (key === prevKey) return prevKey;

  const W = SCREEN_W;
  const H = SCREEN_H;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#08121c');
  g.addColorStop(1, '#03070b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Thanh trên: mạng + giờ mô phỏng
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, 0, W, 88);
  ctx.textBaseline = 'middle';
  ctx.font = `700 36px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = strip[1];
  ctx.fillText(strip[0], 30, 46);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = `600 34px ${MONO}`;
  ctx.fillText(s.speed > 1 ? `×${s.speed}  ${clock}` : clock, W - 30, 46);
  // Vạch chia (QA-11: trụ một súng dùng cả màn hình, không có vạch)
  const one = halves.length === 1;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  if (!one) ctx.fillRect(W / 2 - 1, 116, 2, H - 140);

  halves.forEach((h, i) => {
    const x0 = i === 0 ? 30 : W / 2 + 30;
    const w = one ? W - 60 : W / 2 - 60;
    ctx.textAlign = 'left';
    ctx.font = `800 34px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(i === 0 ? 'A' : 'B', x0, 146);
    // nhãn trạng thái dạng viên thuốc
    ctx.font = `700 30px ${FONT}`;
    const label = h.status.split(' · ')[0];
    const tw = ctx.measureText(label).width;
    const px = x0 + w - tw - 32;
    roundRect(ctx, px, 124, tw + 32, 46, 23);
    ctx.fillStyle = tint(h.col);
    ctx.fill();
    ctx.fillStyle = h.col;
    ctx.fillText(label, px + 16, 148);

    if (h.big != null) {
      ctx.fillStyle = INK;
      ctx.font = `300 176px ${FONT}`;
      ctx.fillText(h.big, x0 - 6, 286);
      const bw = ctx.measureText(h.big).width;
      ctx.font = `600 50px ${FONT}`;
      ctx.fillStyle = h.col;
      ctx.fillText(h.unit, x0 + bw + 8, 318);
      ctx.font = `600 62px ${MONO}`;
      ctx.fillStyle = INK;
      ctx.fillText(h.lines[0], x0, 410);
      ctx.font = `500 38px ${MONO}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(h.lines[1], x0, 470);
    } else {
      ctx.fillStyle = h.col;
      ctx.font = `700 72px ${FONT}`;
      ctx.fillText(h.title, x0, 280);
      ctx.font = `500 40px ${FONT}`;
      ctx.fillStyle = MUTED;
      h.lines.forEach((t, k) => ctx.fillText(t, x0, 360 + k * 52));
    }
    // SoC
    if (h.soc != null) {
      ctx.font = `700 34px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText('SoC', x0, 538);
      ctx.textAlign = 'right';
      ctx.font = `600 40px ${MONO}`;
      ctx.fillStyle = INK;
      ctx.fillText(`${h.soc.toFixed(1)} %`, x0 + w, 538);
      ctx.textAlign = 'left';
      roundRect(ctx, x0, 572, w, 22, 11);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fill();
      roundRect(ctx, x0, 572, Math.max(22, (w * Math.min(100, h.soc)) / 100), 22, 11);
      ctx.fillStyle = h.col;
      ctx.fill();
    }
  });
  return key;
}
