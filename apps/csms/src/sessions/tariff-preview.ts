/**
 * BE-50 — biểu giá cho tài xế xem TRƯỚC khi sạc (SRS Screen 5 "pricing preview", Screen 8, BR-P02,
 * BR-P18). Gắn vào `GET /stations` (từng trạm) và `GET /connectors/by-code/{code}/{no}`.
 *
 * Giá đặt theo Operator (FE-06, `tariff_periods`), 3 khung giờ, giờ Việt Nam. Hàng được lấy bằng
 * ĐÚNG điều kiện mà `POST /charges` dùng để giữ tiền (`CURRENT_TARIFF_WHERE`), nên
 * `max_price_per_kwh_vnd` hiển thị luôn bằng giá dùng để giữ tạm (BR-P18/P19). Tiền thật vẫn do
 * quyết toán tính theo khung giờ lúc sạc (đồng hồ trụ, dung sai 300 s — tariff-clock.ts); preview chỉ
 * để hiển thị.
 */
import type { PoolClient } from 'pg';

type Querier = Pick<PoolClient, 'query'>;

export type TariffBand = 'off_peak' | 'normal' | 'peak';

export interface TariffPeriodView {
  band: TariffBand;
  time_start: string;
  time_end: string;
  price_per_kwh_vnd: number;
}

export interface DriverTariffPreview {
  currency: 'VND';
  unit: 'kWh';
  timezone: 'Asia/Ho_Chi_Minh';
  /** Ngày (giờ VN) mà biểu giá này áp dụng. */
  effective_date: string;
  /** Khung đang áp dụng lúc CSMS trả lời; null nếu biểu giá thủng giờ (không xảy ra với FE-06). */
  current: TariffPeriodView | null;
  /** Giá cao nhất hôm nay — giá dùng để giữ tạm Charging Credit khi bắt đầu (BR-P18). */
  max_price_per_kwh_vnd: number;
  /** Mọi khung trong ngày theo giờ bắt đầu; một band có thể xuất hiện nhiều lần. */
  periods: TariffPeriodView[];
}

const TODAY = `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/** Hàng `tariff_periods` (bí danh `t`) đang hiệu lực hôm nay. Dùng chung với giữ tiền BR-P18. */
export const CURRENT_TARIFF_WHERE = `t.effective_from<=${TODAY}
  AND (t.effective_to IS NULL OR t.effective_to>=${TODAY})`;

interface Row {
  operator_id: string;
  effective_from: string;
  band: TariffBand;
  time_start: string;
  time_end: string;
  price: string;
}

/**
 * Biểu giá hôm nay của từng Operator; Operator chưa có biểu giá → null (app tắt nút Start, khớp lỗi
 * `tariff_unavailable` của `POST /charges`).
 */
export async function driverTariffPreviews(
  c: Querier,
  operatorIds: readonly string[],
): Promise<Map<string, DriverTariffPreview | null>> {
  const ids = [...new Set(operatorIds.map(String))];
  const out = new Map<string, DriverTariffPreview | null>(ids.map((id) => [id, null]));
  if (!ids.length) return out;
  const clock = (
    await c.query<{ today: string; now_time: string }>(
      `SELECT to_char(${TODAY},'YYYY-MM-DD') AS today,
        to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI:SS') AS now_time`,
    )
  ).rows[0]!;
  const { rows } = await c.query<Row>(
    `SELECT t.operator_id::text AS operator_id,to_char(t.effective_from,'YYYY-MM-DD') AS effective_from,
      t.band::text AS band,to_char(t.time_start,'HH24:MI') AS time_start,
      CASE WHEN t.time_end='24:00:00' THEN '24:00' ELSE to_char(t.time_end,'HH24:MI') END AS time_end,
      t.price_per_kwh_vnd::text AS price
     FROM tariff_periods t WHERE t.operator_id=ANY($1::bigint[]) AND ${CURRENT_TARIFF_WHERE}
     ORDER BY t.operator_id,t.effective_from,t.time_start`,
    [ids],
  );
  const byOperator = new Map<string, Row[]>();
  for (const r of rows)
    byOperator.set(r.operator_id, [...(byOperator.get(r.operator_id) ?? []), r]);
  for (const [operatorId, list] of byOperator) {
    out.set(operatorId, buildPreview(list, clock.today, clock.now_time));
  }
  return out;
}

/** Thuần, để unit test: `list` là hàng hiệu lực hôm nay của MỘT Operator, `nowTime` = HH24:MI:SS. */
export function buildPreview(
  list: readonly Pick<Row, 'effective_from' | 'band' | 'time_start' | 'time_end' | 'price'>[],
  today: string,
  nowTime: string,
): DriverTariffPreview | null {
  if (!list.length) return null;
  // Giá cao nhất trên MỌI hàng hiệu lực — đúng như câu giữ tiền; khung hiển thị lấy biểu mới nhất.
  const max = Math.max(...list.map((r) => Number(r.price)));
  const latest = list.reduce((a, r) => (r.effective_from > a ? r.effective_from : a), '');
  const periods = list
    .filter((r) => r.effective_from === latest)
    .map((r) => ({
      band: r.band,
      time_start: r.time_start,
      time_end: r.time_end,
      price_per_kwh_vnd: Number(r.price),
    }))
    .sort((a, b) => a.time_start.localeCompare(b.time_start));
  const now = nowTime.slice(0, 5);
  const current = periods.find((p) => p.time_start <= now && now < p.time_end) ?? null; // '24:00' > mọi giờ
  return {
    currency: 'VND',
    unit: 'kWh',
    timezone: 'Asia/Ho_Chi_Minh',
    effective_date: today,
    current,
    max_price_per_kwh_vnd: max,
    periods,
  };
}
