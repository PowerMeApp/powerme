/** Định dạng hiển thị tiếng Việt (giống apps/mobile/lib/core/formatters.dart). */

const vnd = new Intl.NumberFormat('vi-VN');

export function formatVnd(amount: number): string {
  return `${vnd.format(Math.round(amount))} ₫`;
}

export function formatKwh(wh: number | null): string {
  if (wh === null) return '—';
  return `${(wh / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} kWh`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'chưa có';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
}

export function secondsLeft(iso: string | null, now: number = Date.now()): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
}
