/**
 * Kiểm tra biểu giá bốn khung giờ (M4: "cấu hình được từ dashboard"). Mỗi phút trong ngày phải
 * thuộc ĐÚNG một khung (không chồng, không hở), giá > 0, và đủ cả bốn tên khung.
 */
import type { TariffBandName, TariffPeriod } from '../../types/domain';

export const BAND_NAMES: readonly TariffBandName[] = ['Sharp', 'Peak', 'Shoulder', 'Off-peak'];

export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function validateBands(periods: TariffPeriod[]): string[] {
  const errors: string[] = [];
  const cover = new Array<number>(24 * 60).fill(0);
  periods.forEach((p, i) => {
    const s = toMinutes(p.start);
    const e = toMinutes(p.end);
    if (s === null || e === null) {
      errors.push(`Dòng ${i + 1}: giờ phải có dạng HH:MM`);
      return;
    }
    if (e <= s) {
      errors.push(`Dòng ${i + 1}: giờ kết thúc phải sau giờ bắt đầu`);
      return;
    }
    if (!(p.pricePerKwhVnd > 0)) errors.push(`Dòng ${i + 1}: giá phải lớn hơn 0`);
    for (let t = s; t < e; t += 1) cover[t] = (cover[t] ?? 0) + 1;
  });
  if (errors.length) return errors;
  if (cover.some((c) => c > 1)) errors.push('Các khung giờ đang chồng lên nhau');
  if (cover.some((c) => c === 0))
    errors.push('Còn khoảng giờ chưa thuộc khung nào (phải phủ đủ 24 h)');
  for (const name of BAND_NAMES) {
    if (!periods.some((p) => p.band === name)) errors.push(`Thiếu khung ${name}`);
  }
  return errors;
}
