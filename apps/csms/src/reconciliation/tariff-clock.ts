import type { PoolClient } from 'pg';

export const TARIFF_CLOCK_HOLD = 'TARIFF_CLOCK_HOLD';

interface Receipt {
  receivedAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
  firstOpenedAt: Date | null;
  epoch: number | null;
}

export function parseChargePointTime(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const date = new Date(raw);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}0*))?(?:Z|[+-]\d{2}:\d{2})$/i.exec(raw);
  if (!parts || !Number.isFinite(date.getTime()) || raw.slice(11, 13) === '24') return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day > 0 && day <= (days[month - 1] ?? 0) ? date : null;
}

export function checkTariffTime(cp: Date, receipt: Receipt, toleranceMs: number, batch = false) {
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
  if (receivedAt.getTime() - cp.getTime() <= toleranceMs) return undefined;
  if (openedAt.getTime() - cp.getTime() > toleranceMs) {
    if (epoch > 1 && firstOpenedAt && firstOpenedAt.getTime() - cp.getTime() <= toleranceMs)
      return undefined;
    return 'tariff_clock_epoch_unverified';
  }
  return batch ? undefined : 'tariff_clock_ambiguous_delay';
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
  cp_stopped_at: Date;
}

interface Endpoint extends Receipt {
  rawTimestamp: string;
}

async function readEndpoint(c: PoolClient, s: SessionClock, stop: boolean) {
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

export async function checkTariffTimeline(c: PoolClient, s: SessionClock, toleranceMs: number) {
  const start = await readEndpoint(c, s, false);
  const stop = await readEndpoint(c, s, true);
  if (!start || !stop) return 'tariff_clock_frame_unverified';
  for (const [cp, frame] of [
    [s.cp_started_at, start],
    [s.cp_stopped_at, stop],
  ] as const) {
    if (parseChargePointTime(frame.rawTimestamp)?.getTime() !== cp.getTime())
      return 'tariff_clock_invalid_timestamp';
    const issue = checkTariffTime(cp, frame, toleranceMs);
    if (issue) return issue;
  }
  if (
    s.cp_stopped_at < s.cp_started_at ||
    stop.receivedAt < start.receivedAt ||
    stop.epoch! < start.epoch!
  )
    return 'tariff_clock_reversed_session';

  const { rows } = await c.query<
    Receipt & {
      cpTimestamp: Date;
      meterClocks: string[] | null;
      stopBatchClocks: string[] | null;
    }
  >(
    `SELECT m.cp_timestamp AS "cpTimestamp",m.received_at AS "receivedAt",m.epoch,
       e.opened_at AS "openedAt",e.closed_at AS "closedAt",first_epoch.opened_at AS "firstOpenedAt",
       clocks.meter AS "meterClocks",clocks.stop_batch AS "stopBatchClocks"
     FROM meter_values m
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
     WHERE m.session_id=$1 AND m.measurand='Energy.Active.Import.Register' AND m.phase IS NULL
       AND (m.unit IN ('Wh','kWh') OR m.unit IS NULL)
     ORDER BY m.received_at,m.id`,
    [
      s.id,
      s.charge_point_id,
      String(s.transaction_no),
      String(s.connector_no),
      s.cp_stopped_at,
      s.meter_stop_wh,
    ],
  );
  let lastLive: { cp: Date; receivedAt: Date; epoch: number | null } | undefined;
  for (const sample of rows) {
    const cp = sample.cpTimestamp;
    if (cp < s.cp_started_at || cp > s.cp_stopped_at || sample.receivedAt < start.receivedAt)
      return 'tariff_clock_sample_outside_session';
    const matches = (raw: string) => parseChargePointTime(raw)?.getTime() === cp.getTime();
    const meterFrame = sample.meterClocks?.some(matches);
    const stopBatch = sample.stopBatchClocks?.some(matches) ?? false;
    const issue = checkTariffTime(cp, sample, toleranceMs, stopBatch);
    if (issue) return issue;
    if (!meterFrame && !stopBatch) return 'tariff_clock_sample_frame_unverified';
    if (meterFrame && stopBatch) return 'tariff_clock_sample_frame_unverified';
    if (sample.epoch! < start.epoch!) return 'tariff_clock_epoch_unverified';
    // Replay and stop batches can carry older readings. Live readings must move forward.
    if (!stopBatch && sample.receivedAt.getTime() - cp.getTime() <= toleranceMs) {
      if (lastLive?.epoch === sample.epoch) {
        if (sample.receivedAt > lastLive.receivedAt && cp < lastLive.cp)
          return 'tariff_clock_sample_out_of_order';
        if (cp < lastLive.cp) continue;
      }
      lastLive = { cp, receivedAt: sample.receivedAt, epoch: sample.epoch };
    }
  }
  return undefined;
}
