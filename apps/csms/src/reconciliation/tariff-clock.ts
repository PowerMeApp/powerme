/**
 * Đồng hồ dùng để chia phiên theo khung giá (BR-P02; T101, sửa ở T134 theo quyết định D-I 14/11 và
 * các quyết định của Trí ngày 17/11 sau review #154).
 *
 * Quy tắc, theo thứ tự:
 *  1. Đo độ lệch đồng hồ trụ trong TỪNG connection epoch: độ lệch của một bản tin = giờ CSMS nhận −
 *     giờ trụ ghi trong bản tin. Chỉ bản tin gửi LIVE mới đo được; bản tin phát bù từ hàng đợi
 *     offline mang thêm thời gian nằm chờ. OCPP 1.6 không có cờ live / phát bù, và cờ `replayed` của
 *     ReplayDetector tự nó dựa vào đồng hồ trụ (trụ chậm 10 phút thì mọi bản tin live đều bị coi là
 *     phát lại), nên ở đây nhận diện live KHÔNG dùng đồng hồ trụ mà dùng NHỊP: một cụm live là các
 *     bản tin của epoch có độ lệch cách nhau không quá `REPLAY_SKEW_THRESHOLD_S` (tức khoảng nhận
 *     giữa hai bản tin bất kỳ xấp xỉ khoảng giờ trụ của chúng) và đủ dài để không thể là một loạt
 *     phát bù tới dồn: trải ít nhất 60 giây trên đồng hồ trụ, hoặc có từ ba bản tin trải quá hai lần
 *     ngưỡng. Số đo của cụm là TRUNG VỊ độ lệch. Trong một epoch có hai cụm live lệch nhau quá dung
 *     sai nghĩa là đồng hồ bị chỉnh giữa chừng (Heartbeat.conf đồng bộ giờ) → không ổn định (bước 4).
 *     Nhiều cụm trong dung sai: lấy cụm lệch nhỏ nhất (thời gian chờ chỉ làm độ lệch lớn lên).
 *  2. Đồng hồ SAI khi có epoch đo được |độ lệch| > `TARIFF_CLOCK_TOLERANCE_S`. Khi đó MỌI epoch có
 *     bản tin của phiên phải đo được và khớp nhau trong dung sai; có epoch không đo được hoặc lệch
 *     nhau → `tariff_clock_offset_unstable` (bước 4). Mọi số đo trong dung sai, hoặc không epoch nào
 *     đo được → dùng nguyên giờ trụ, không cần điều kiện này.
 *  3. Đồng hồ sai và ổn định → cộng độ lệch (làm tròn tới giây) vào MỌI mốc giờ trụ của phiên (bắt
 *     đầu, dừng, từng mẫu công tơ). Sau đó các mốc (đã chỉnh hoặc giữ nguyên) phải qua các kiểm tra
 *     của T101 (log gốc, epoch, không ở tương lai, mẫu nằm trong phiên, mẫu live không lùi). Đến trễ
 *     không còn là lý do loại: mẫu phát bù tới trễ hơn dung sai vẫn là giờ trụ hợp lệ.
 *  4. Không ổn định hoặc kiểm tra không qua → không có độ lệch nào giải thích được phiên: tính cả
 *     phiên theo khung giá lúc CSMS nhận StartTransaction (`tariff_clock_fallback`). Phiên không bao
 *     giờ bị giữ vì đồng hồ.
 */
import type { PoolClient } from 'pg';

export const TARIFF_CLOCK_FALLBACK_PREFIX = 'tariff_clock=csms_fallback reason=';
export const TARIFF_CLOCK_OFFSET_PREFIX = 'tariff_clock=cp_offset offset_s=';
export const TARIFF_CLOCK_UNTRUSTED = 'TARIFF_CLOCK_UNTRUSTED';
export const TARIFF_BOUNDARY_INTERPOLATED_PREFIX = 'tariff_boundary=interpolated boundaries=';

/** Một số đo công tơ tích luỹ trên trục giờ tính giá (ms). */
export interface MeterPoint {
  at: number;
  wh: number;
}

/**
 * Số Wh tại thời điểm `at` trên chuỗi số đo đã sắp theo thời gian (mốc bắt đầu với meterStart, các
 * mẫu công tơ, mốc dừng với meterStop). Có số đo đúng `at` thì dùng trực tiếp (`gapMs = 0`); không
 * thì nội suy tuyến tính giữa hai số đo kề trước và kề sau, `gapMs` = khoảng cách giữa hai số đo đó.
 * Sai số của phần nội suy bị chặn bởi điện năng của đúng khoảng mẫu ấy. Hàm thuần.
 */
export function meterAt(points: MeterPoint[], at: number): { wh: number; gapMs: number } | null {
  let before: MeterPoint | undefined;
  let after: MeterPoint | undefined;
  for (const point of points) {
    if (point.at === at) return { wh: point.wh, gapMs: 0 };
    if (point.at < at) before = point;
    else after ??= point;
  }
  if (!before || !after) return null;
  return {
    wh: before.wh + ((after.wh - before.wh) * (at - before.at)) / (after.at - before.at),
    gapMs: after.at - before.at,
  };
}

interface Receipt {
  receivedAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
  firstOpenedAt: Date | null;
  epoch: number | null;
}

/**
 * Đọc timestamp của trụ. `exact` = đúng dạng dùng được cho khung giá (có múi giờ, phần lẻ không quá
 * mili giây). Phần lẻ dài hơn mili giây thì cắt bớt. `zoned = false` = chuỗi không ghi múi giờ: `at`
 * khi đó đọc như UTC nhưng KHÔNG đáng tin (trụ ghi giờ địa phương thì lệch 7 giờ) — người gọi không
 * được dùng làm mốc của mẫu công tơ. Bước kiểm schema của ocpp-rpc (strictMode) cho cả hai dạng này
 * đi qua (đã kiểm bằng test qua gateway thật). Ngày giờ không tồn tại (30/02, giờ 24) → null.
 */
export function readChargePointTime(
  raw: unknown,
): { at: Date; exact: boolean; zoned: boolean } | null {
  if (typeof raw !== 'string') return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/i.exec(raw);
  if (!parts || parts[4]!.startsWith('24')) return null;
  const [, year, month, day, time, fraction = '', zone] = parts;
  const at = new Date(
    `${year}-${month}-${day}T${time}.${fraction.slice(0, 3).padEnd(3, '0')}${zone?.toUpperCase() ?? 'Z'}`,
  );
  if (!Number.isFinite(at.getTime())) return null;
  const y = Number(year);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(day) < 1 || Number(day) > (days[Number(month) - 1] ?? 0)) return null;
  const zoned = zone !== undefined;
  return { at, exact: zoned && /^0*$/.test(fraction.slice(3)), zoned };
}

/** Timestamp dùng được cho khung giá, hoặc null (xem `readChargePointTime`). */
export function parseChargePointTime(raw: unknown): Date | null {
  const time = readChargePointTime(raw);
  return time?.exact ? time.at : null;
}

/** Một bản tin có thể đã gửi live: StartTransaction, MeterValues hoặc StopTransaction của phiên. */
export interface ClockFrame {
  epoch: number;
  receivedAt: Date;
  cp: Date;
}

export interface ClockOffset {
  /** Giờ CSMS nhận − giờ trụ (ms): dương = đồng hồ trụ chậm. */
  offsetMs: number;
  epoch: number;
  liveFrames: number;
}

/** Cụm live ngắn hơn mức này trên đồng hồ trụ phải có từ ba bản tin (xem bước 1 ở đầu file). */
const LIVE_CLUSTER_SPAN_MS = 60_000;

/**
 * Đo độ lệch đồng hồ trụ của một phiên (bước 1–2 ở đầu file). Hàm thuần.
 * Trả `undefined` khi không epoch nào đo được; `'tariff_clock_offset_unstable'` khi đồng hồ đổi
 * trong một epoch, hoặc đồng hồ sai mà có epoch không đo được / lệch với epoch khác quá dung sai.
 */
export function measureClockOffset(
  frames: ClockFrame[],
  toleranceMs: number,
  liveWindowMs: number,
): ClockOffset | 'tariff_clock_offset_unstable' | undefined {
  const epochs = [...new Set(frames.map((f) => f.epoch))].sort((a, b) => a - b);
  const measured: ClockOffset[] = [];
  for (const epoch of epochs) {
    const inEpoch = frames
      .filter((f) => f.epoch === epoch)
      .map((f) => ({ cp: f.cp.getTime(), offset: f.receivedAt.getTime() - f.cp.getTime() }))
      .filter((f) => Number.isFinite(f.offset))
      .sort((a, b) => a.offset - b.offset);
    let best: ClockOffset | undefined;
    for (let from = 0; from < inEpoch.length;) {
      // Cụm = các bản tin lệch không quá ngưỡng live so với bản tin lệch nhỏ nhất của cụm, nên
      // khoảng nhận giữa bản tin đầu và cuối cụm chênh khoảng giờ trụ của chúng không quá ngưỡng.
      let to = from;
      while (to < inEpoch.length && inEpoch[to]!.offset - inEpoch[from]!.offset <= liveWindowMs)
        to++;
      const cluster = inEpoch.slice(from, to);
      from = to;
      const cps = cluster.map((f) => f.cp);
      const span = Math.max(...cps) - Math.min(...cps);
      if (span < LIVE_CLUSTER_SPAN_MS && !(cluster.length >= 3 && span > 2 * liveWindowMs))
        continue;
      const middle = cluster.length >> 1;
      const offsetMs =
        cluster.length % 2
          ? cluster[middle]!.offset
          : (cluster[middle - 1]!.offset + cluster[middle]!.offset) / 2;
      if (!best) best = { offsetMs, epoch, liveFrames: cluster.length };
      else if (Math.abs(offsetMs - best.offsetMs) > toleranceMs)
        return 'tariff_clock_offset_unstable';
    }
    if (best) measured.push(best);
  }
  const first = measured[0];
  if (!first || measured.every((m) => Math.abs(m.offsetMs) <= toleranceMs)) return first;
  if (
    measured.length !== epochs.length ||
    measured.some((m) => Math.abs(m.offsetMs - first.offsetMs) > toleranceMs)
  )
    return 'tariff_clock_offset_unstable';
  return first;
}

/** Kiểm một mốc giờ trụ (đã cộng độ lệch nếu có) với thời điểm nhận và epoch của bản tin mang nó. */
export function checkTariffTime(cp: Date, receipt: Receipt, toleranceMs: number) {
  const { receivedAt, openedAt, closedAt, firstOpenedAt, epoch } = receipt;
  if (!Number.isFinite(cp.getTime())) return 'tariff_clock_invalid_timestamp';
  if (
    !Number.isFinite(receivedAt?.getTime()) ||
    !Number.isFinite(openedAt?.getTime()) ||
    !openedAt ||
    epoch === null ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    receivedAt < openedAt ||
    (closedAt && (!Number.isFinite(closedAt.getTime()) || receivedAt > closedAt)) ||
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0
  )
    return 'tariff_clock_epoch_unverified';
  if (cp.getTime() - receivedAt.getTime() > toleranceMs) return 'tariff_clock_future_timestamp';
  // Mốc đứng trước epoch nhận (phát bù sau khi nối lại) phải nằm trong lịch sử kết nối của trụ.
  if (
    openedAt.getTime() - cp.getTime() > toleranceMs &&
    !(epoch > 1 && firstOpenedAt && firstOpenedAt.getTime() - cp.getTime() <= toleranceMs)
  )
    return 'tariff_clock_epoch_unverified';
  return undefined;
}

interface SessionClock {
  id: string;
  charge_point_id: string;
  connector_no: number;
  id_tag: string;
  transaction_no: number;
  meter_start_wh: string;
  meter_stop_wh: string;
  received_started_at: Date;
  received_stopped_at: Date;
  cp_started_at: Date;
  cp_stopped_at: Date | null;
}

export type ActiveSessionClock = Omit<
  SessionClock,
  'meter_stop_wh' | 'received_stopped_at' | 'cp_stopped_at'
>;

interface Endpoint extends Receipt {
  rawTimestamp: string;
}

async function readEndpoint(
  c: PoolClient,
  s: ActiveSessionClock & Partial<SessionClock>,
  stop: boolean,
) {
  const { rows } = await c.query<Endpoint>(
    `SELECT DISTINCT l.raw->3->>'timestamp' AS "rawTimestamp", l.epoch, l.received_at AS "receivedAt",
       e.opened_at AS "openedAt",e.closed_at AS "closedAt",first_epoch.opened_at AS "firstOpenedAt"
     FROM ocpp_message_log l
     LEFT JOIN charge_point_connections e ON e.charge_point_id=l.charge_point_id AND e.epoch=l.epoch
     LEFT JOIN charge_point_connections first_epoch ON first_epoch.charge_point_id=l.charge_point_id AND first_epoch.epoch=1
     WHERE l.charge_point_id=$1 AND l.received_at=$2 AND l.cp_timestamp=$3
       AND l.direction='in' AND l.message_type=2 AND l.validation_error IS NULL AND l.action=$4
       AND (CASE WHEN $4='StopTransaction' THEN
         l.raw->3->>'transactionId'=$5 AND l.raw->3->>'meterStop'=$6
       ELSE l.raw->3->>'connectorId'=$5 AND l.raw->3->>'meterStart'=$6 AND l.raw->3->>'idTag'=$7 END)
     LIMIT 2`,
    [
      s.charge_point_id,
      stop ? s.received_stopped_at : s.received_started_at,
      stop ? s.cp_stopped_at : s.cp_started_at,
      stop ? 'StopTransaction' : 'StartTransaction',
      String(stop ? s.transaction_no : s.connector_no),
      stop ? s.meter_stop_wh : s.meter_start_wh,
      s.id_tag,
    ],
  );
  return rows.length === 1 ? rows[0] : undefined;
}

export type TariffClock =
  { issue: string } | { offsetMs: number; epoch: number | null; liveFrames: number };

/**
 * Đồng hồ tính giá của một phiên đã dừng: `offsetMs` phải cộng vào mọi mốc giờ trụ (0 = dùng nguyên
 * giờ trụ), hoặc `issue` = lý do phải dùng giờ CSMS.
 */
export async function resolveTariffClock(
  c: PoolClient,
  s: SessionClock,
  toleranceMs: number,
  liveWindowMs: number,
): Promise<TariffClock> {
  if (!s.cp_stopped_at) return { issue: 'tariff_clock_invalid_timestamp' };
  const cpStoppedAt = s.cp_stopped_at;
  const start = await readEndpoint(c, s, false);
  const stop = await readEndpoint(c, s, true);
  if (!start || !stop) return { issue: 'tariff_clock_frame_unverified' };
  if (
    parseChargePointTime(start.rawTimestamp)?.getTime() !== s.cp_started_at.getTime() ||
    parseChargePointTime(stop.rawTimestamp)?.getTime() !== cpStoppedAt.getTime()
  )
    return { issue: 'tariff_clock_invalid_timestamp' };

  return resolveClockEvidence(
    c,
    s,
    start,
    stop,
    cpStoppedAt,
    s.meter_stop_wh,
    toleranceMs,
    liveWindowMs,
  );
}

// WP3: a running session resolves its clock from actual start and meter frames, without stop evidence.
export async function resolveActiveTariffClock(
  c: PoolClient,
  s: ActiveSessionClock,
  latest: { at: Date; receivedAt: Date; epoch: number; wh: string },
  toleranceMs: number,
  liveWindowMs: number,
): Promise<TariffClock> {
  const start = await readEndpoint(c, s, false);
  const rows = (
    await c.query<Endpoint>(
      `SELECT DISTINCT v->>'timestamp' AS "rawTimestamp",l.epoch,l.received_at AS "receivedAt",
       e.opened_at AS "openedAt",e.closed_at AS "closedAt",f.opened_at AS "firstOpenedAt"
     FROM ocpp_message_log l
     JOIN charge_point_connections e ON e.charge_point_id=l.charge_point_id AND e.epoch=l.epoch
     LEFT JOIN charge_point_connections f ON f.charge_point_id=l.charge_point_id AND f.epoch=1
     CROSS JOIN LATERAL jsonb_array_elements(l.raw->3->'meterValue') v
     WHERE l.charge_point_id=$1 AND l.received_at=$2 AND l.epoch=$3
       AND l.action='MeterValues' AND l.direction='in' AND l.message_type=2 AND l.validation_error IS NULL
       AND l.raw->3->>'transactionId'=$4 AND l.raw->3->>'connectorId'=$5`,
      [
        s.charge_point_id,
        latest.receivedAt,
        latest.epoch,
        String(s.transaction_no),
        String(s.connector_no),
      ],
    )
  ).rows.filter((r) => parseChargePointTime(r.rawTimestamp)?.getTime() === latest.at.getTime());
  const end = rows[0];
  if (!start || !end || rows.length !== 1) return { issue: 'tariff_clock_frame_unverified' };
  if (parseChargePointTime(start.rawTimestamp)?.getTime() !== s.cp_started_at.getTime())
    return { issue: 'tariff_clock_invalid_timestamp' };
  return resolveClockEvidence(
    c,
    s,
    start,
    end,
    latest.at,
    latest.wh,
    toleranceMs,
    liveWindowMs,
    true,
  );
}

async function resolveClockEvidence(
  c: PoolClient,
  s: ActiveSessionClock,
  start: Endpoint,
  stop: Endpoint,
  cpStoppedAt: Date,
  endMeterWh: string,
  toleranceMs: number,
  liveWindowMs: number,
  active = false,
): Promise<TariffClock> {
  const { rows } = await c.query<
    Receipt & {
      cpTimestamps: Date[];
      meterClocks: string[] | null;
      stopBatchClocks: string[] | null;
    }
  >(
    `WITH receipts AS (
       SELECT received_at,epoch,array_agg(DISTINCT cp_timestamp ORDER BY cp_timestamp) AS timestamps
       FROM meter_values WHERE session_id=$1 AND measurand='Energy.Active.Import.Register'
         AND phase IS NULL AND (unit IN ('Wh','kWh') OR unit IS NULL)
       GROUP BY received_at,epoch
     )
     SELECT m.timestamps AS "cpTimestamps",m.received_at AS "receivedAt",m.epoch,
       e.opened_at AS "openedAt",e.closed_at AS "closedAt",first_epoch.opened_at AS "firstOpenedAt",
       clocks.meter AS "meterClocks",clocks.stop_batch AS "stopBatchClocks"
     FROM receipts m
     LEFT JOIN charge_point_connections e ON e.charge_point_id=$2 AND e.epoch=m.epoch
     LEFT JOIN charge_point_connections first_epoch ON first_epoch.charge_point_id=$2 AND first_epoch.epoch=1
     LEFT JOIN LATERAL (
       SELECT array_agg(v->>'timestamp') FILTER (WHERE l.action='MeterValues') AS meter,
              array_agg(v->>'timestamp') FILTER (WHERE l.action='StopTransaction') AS stop_batch
       FROM ocpp_message_log l
       CROSS JOIN LATERAL (SELECT CASE l.action
         WHEN 'MeterValues' THEN l.raw->3->'meterValue'
         WHEN 'StopTransaction' THEN l.raw->3->'transactionData' END AS payload) p
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(p.payload)='array' THEN p.payload ELSE '[]'::jsonb END
       ) v
       WHERE l.charge_point_id=$2 AND l.received_at=m.received_at AND l.epoch=m.epoch
         AND l.direction='in' AND l.message_type=2 AND l.validation_error IS NULL
         AND l.raw->3->>'transactionId'=$3
         AND ((l.action='MeterValues' AND l.raw->3->>'connectorId'=$4)
           OR (l.action='StopTransaction' AND l.cp_timestamp=$5 AND l.raw->3->>'meterStop'=$6))
     ) clocks ON true
     ORDER BY m.received_at,m.epoch`,
    [
      s.id,
      s.charge_point_id,
      String(s.transaction_no),
      String(s.connector_no),
      cpStoppedAt,
      endMeterWh,
    ],
  );
  const samples = rows.map((receipt) => ({
    ...receipt,
    meterTimes: new Set(receipt.meterClocks?.map((raw) => parseChargePointTime(raw)?.getTime())),
    stopTimes: new Set(receipt.stopBatchClocks?.map((raw) => parseChargePointTime(raw)?.getTime())),
  }));

  // Bước 1–2: một MeterValues.req là một bản tin, gửi lúc mẫu mới nhất của nó được lấy.
  const frames: ClockFrame[] = [];
  for (const [cp, frame] of [
    [s.cp_started_at, start],
    [cpStoppedAt, stop],
  ] as const)
    if (frame.epoch !== null) frames.push({ epoch: frame.epoch, receivedAt: frame.receivedAt, cp });
  for (const receipt of samples) {
    const sent = receipt.cpTimestamps.filter((cp) => receipt.meterTimes.has(cp.getTime())).pop();
    if (
      sent &&
      receipt.epoch !== null &&
      !(
        active &&
        receipt.epoch === stop.epoch &&
        receipt.receivedAt.getTime() === stop.receivedAt.getTime() &&
        sent.getTime() === cpStoppedAt.getTime()
      )
    )
      frames.push({ epoch: receipt.epoch, receivedAt: receipt.receivedAt, cp: sent });
  }
  const measured = measureClockOffset(frames, toleranceMs, liveWindowMs);
  if (measured === 'tariff_clock_offset_unstable') return { issue: measured };
  const offsetMs =
    measured && Math.abs(measured.offsetMs) > toleranceMs
      ? Math.round(measured.offsetMs / 1000) * 1000
      : 0;
  const corrected = (cp: Date) => new Date(cp.getTime() + offsetMs);

  // Bước 3: các mốc đã chỉnh phải khớp log, epoch và thứ tự của phiên.
  for (const [cp, frame] of [
    [s.cp_started_at, start],
    [cpStoppedAt, stop],
  ] as const) {
    const issue = checkTariffTime(corrected(cp), frame, toleranceMs);
    if (issue) return { issue };
  }
  if (
    cpStoppedAt < s.cp_started_at ||
    stop.receivedAt < start.receivedAt ||
    stop.epoch! < start.epoch!
  )
    return { issue: 'tariff_clock_reversed_session' };
  const lastLive = new Map<number | null, Date>();
  for (const sample of samples) {
    const previous = lastLive.get(sample.epoch);
    for (const cp of sample.cpTimestamps) {
      if (cp < s.cp_started_at || cp > cpStoppedAt || sample.receivedAt < start.receivedAt)
        return { issue: 'tariff_clock_sample_outside_session' };
      const meterFrame = sample.meterTimes.has(cp.getTime());
      if (meterFrame === sample.stopTimes.has(cp.getTime()))
        return { issue: 'tariff_clock_sample_frame_unverified' };
      const issue = checkTariffTime(corrected(cp), sample, toleranceMs);
      if (issue) return { issue };
      if (sample.epoch! < start.epoch!) return { issue: 'tariff_clock_epoch_unverified' };
      // Within a receipt, a MeterValues frame can list samples in any order.
      if (meterFrame && sample.receivedAt.getTime() - corrected(cp).getTime() <= toleranceMs) {
        if (previous && cp < previous) return { issue: 'tariff_clock_sample_out_of_order' };
        lastLive.set(sample.epoch, cp);
      }
    }
  }
  return { offsetMs, epoch: measured?.epoch ?? null, liveFrames: measured?.liveFrames ?? 0 };
}
