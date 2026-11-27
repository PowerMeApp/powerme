/**
 * Tài xế báo lỗi súng (FE-17: UC-CHG-05, BR-P42, Q75–Q81; T131) và t8 `SESSION_COMPLETED`
 * (ADR-0019). FaultService giữ API công khai (`reportFromDriver`, `onSessionCompleted`) và gọi sang
 * đây.
 */
import type { Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  CsmsConfig,
  DEFAULT_OFFLINE_ALERT_S,
  DEFAULT_TARIFF_CLOCK_TOLERANCE_S,
} from '../../config.js';
import type { Db } from '../../db/db.module.js';
import { faultEvents, faultReports } from '../../db/schema/index.js';
import { resolveTariffClock } from '../../reconciliation/tariff-clock.js';
import { FaultStateMachine } from './fault-state-machine.js';
import { attachWaitingReports, clearReports, findOpenForUpdate } from './fault-store.js';
import {
  DriverReportError,
  DUPLICATE_REPORT_MS,
  FAULT_STOP_REASONS,
  REPORT_WINDOW_MS,
  type DriverReportResult,
} from './fault.types.js';

/** Q78: trạng thái súng "bất thường" — một báo cáo là đủ. Trụ Offline cũng tính. */
const ABNORMAL_STATUSES = ['Faulted', 'Unavailable'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const sm = new FaultStateMachine();

export interface DriverReportDeps {
  db: Db;
  config: CsmsConfig;
  logger: Logger;
}

/**
 * Ghi một báo lỗi của tài xế cho một súng và áp BR-P42:
 * - súng (hoặc cả trụ) đang có sự cố mở → gắn vào đó, không tạo sự cố mới (Q81, STM-6);
 * - 2 tài xế khác nhau trong 2 giờ, hoặc 1 tài xế khi súng Faulted / Unavailable / trụ Offline
 *   (Q78) → tạo sự cố `driver_report` (t1) và gộp mọi báo cáo chờ của súng trong 2 giờ (Q79);
 * - chưa đủ → chỉ lưu, chờ gộp sau (AD-7).
 * Cùng tài xế + cùng súng trong 60 s → `duplicate_report`, không ghi gì (Q80).
 */
export async function reportFromDriver(
  { db, config, logger }: DriverReportDeps,

  driverId: number,
  connectorId: number,
  description: string,
  at: Date = new Date(),
): Promise<DriverReportResult> {
  const text = typeof description === 'string' ? description.trim() : '';
  const length = [...text].length;
  if (length < 5 || length > 500 || CONTROL.test(text))
    throw new DriverReportError('invalid_description');
  const offlineMs = (config.offlineAlertS ?? DEFAULT_OFFLINE_ALERT_S) * 1000;

  const result = await db.transaction(async (tx) => {
    // Khoá dòng súng (cùng thứ tự và cùng kiểu khoá với đường OCPP, T131): báo cáo và
    // StatusNotification Faulted cho một súng đi tuần tự (đếm tài xế không lệch, không deadlock).
    const target = (
      await tx.execute<{
        charge_point_id: string;
        status: string | null;
        offline: boolean;
      }>(sql`SELECT c.charge_point_id::text AS charge_point_id, c.status,
          (NOT cp.is_online OR cp.last_message_at IS NULL
            OR cp.last_message_at < ${at}::timestamptz - (${offlineMs}::bigint * interval '1 millisecond')) AS offline
        FROM connectors c JOIN charge_points cp ON cp.id = c.charge_point_id
        JOIN sites st ON st.id = cp.site_id JOIN operators o ON o.id = st.operator_id
        WHERE c.id = ${connectorId} AND cp.lifecycle = 'in_service' AND o.status = 'active'
        FOR NO KEY UPDATE OF c`)
    ).rows[0];
    if (!target) throw new DriverReportError('not_found');
    const chargePointId = Number(target.charge_point_id);

    const duplicate = await tx.execute(sql`SELECT 1 FROM fault_reports
      WHERE driver_id = ${driverId} AND connector_id = ${connectorId}
        AND reported_at > ${at}::timestamptz - (${DUPLICATE_REPORT_MS}::bigint * interval '1 millisecond')`);
    if (duplicate.rows.length) throw new DriverReportError('duplicate_report');

    const open =
      (await findOpenForUpdate(tx, chargePointId, connectorId)) ??
      (await findOpenForUpdate(tx, chargePointId, null));
    if (open) sm.apply(open.status, 'SIGNAL'); // no-op: gắn vào sự cố đang mở

    const [report] = await tx
      .insert(faultReports)
      .values({
        driverId,
        connectorId,
        description: text,
        reportedAt: at,
        faultEventId: open?.id ?? null,
      })
      .returning({ id: faultReports.id, reportNo: faultReports.reportNo });
    if (!report) throw new Error('INSERT fault_reports không trả id');
    if (open) return { report, faultEventId: open.id, raised: false };

    const drivers = (
      await tx.execute<{ n: number }>(sql`SELECT count(DISTINCT driver_id)::int AS n
        FROM fault_reports WHERE connector_id = ${connectorId} AND fault_event_id IS NULL
          AND cleared_at IS NULL
          AND reported_at > ${at}::timestamptz - (${REPORT_WINDOW_MS}::bigint * interval '1 millisecond')`)
    ).rows[0]!.n;
    const abnormal = target.offline || ABNORMAL_STATUSES.includes(target.status ?? '');
    if (drivers < 2 && !abnormal) return { report, faultEventId: null, raised: false };
    // T131: "cùng tài xế chỉ tính một" (Q80) áp cho cả trụ ở đường một tài xế — trong 2 giờ, một
    // tài xế tự mình chỉ mở được một sự cố trên một trụ (trụ Offline không bị ẩn hết súng bởi một
    // người). Báo cáo vẫn lưu và chờ luật hai tài xế (AD-7).
    // T159 (ADR-0019 mục 6, BR-P42): sự cố tạo do chuyển giao (`handOverReports`) không phải "tài
    // xế tự mở" nên không tính. Sự cố tài xế tự mở luôn được tạo cùng transaction với báo cáo kích
    // hoạt nó, cùng mốc `at` (raised_at = reported_at, insert bên dưới); sự cố chuyển giao tạo khi
    // sự cố OCPP / Offline đóng, sau mọi báo cáo của nó. Nên chỉ đếm sự cố có một báo cáo đúng mốc đó.
    if (drivers < 2) {
      const alone = await tx.execute(sql`SELECT 1 FROM fault_events f
        WHERE f.charge_point_id = ${chargePointId} AND f.source = 'driver_report'
          AND f.raised_at > ${at}::timestamptz - (${REPORT_WINDOW_MS}::bigint * interval '1 millisecond')
          AND EXISTS (SELECT 1 FROM fault_reports r
            WHERE r.fault_event_id = f.id AND r.reported_at = f.raised_at)
          AND NOT EXISTS (SELECT 1 FROM fault_reports r
            WHERE r.fault_event_id = f.id AND r.driver_id <> ${driverId})
        LIMIT 1`);
      if (alone.rows.length) return { report, faultEventId: null, raised: false };
    }

    const [event] = await tx
      .insert(faultEvents)
      .values({
        chargePointId,
        connectorId,
        source: 'driver_report',
        errorCode: null,
        status: sm.initial(),
        raisedAt: at,
      })
      .returning({ id: faultEvents.id });
    if (!event) throw new Error('INSERT fault_events không trả id');
    await attachWaitingReports(tx, chargePointId, connectorId, event.id, at);
    return { report, faultEventId: event.id, raised: true };
  });

  if (result.raised)
    logger.warn(
      `sự cố #${result.faultEventId} raised: tài xế báo lỗi súng ${connectorId} (BR-P42)`,
    );
  return {
    reportId: result.report.id,
    reportNo: result.report.reportNo,
    connectorId,
    reportedAt: at,
    faultEventId: result.faultEventId,
    reportedIssue: result.faultEventId !== null,
  };
}

/**
 * t8 (BR-P42, Q77): một phiên trên súng hoàn tất bình thường — bắt đầu SAU khi sự cố
 * `driver_report` được tạo, đã dừng, có điện năng > 0 Wh, lý do dừng không phải
 * EmergencyStop / PowerLoss / Other — thì đóng sự cố và xoá nhãn. Gọi sau StopTransaction.
 *
 * "Bắt đầu sau" so theo giờ trụ đã đối soát (T131, review #139): `cp_started_at` khi đồng hồ trụ
 * qua đúng phép kiểm của BR-P02 (`resolveTariffClock`; từ T134 cộng thêm độ lệch đo được nếu đồng
 * hồ lệch quá dung sai); không qua thì giờ CSMS nhận, nhưng chỉ khi phiên không phải bản gửi bù
 * (`delivered_offline`). Phiên gửi bù mà đồng hồ trụ không kiểm được thì không biết nó bắt đầu lúc
 * nào → không đóng; Operator đóng.
 *
 * Tìm sự cố `driver_report` đang mở TRƯỚC (một truy vấn không khoá): hầu hết StopTransaction không
 * có sự cố nào để đóng và không phải trả giá ba truy vấn log của bước kiểm đồng hồ. Kết quả được
 * kiểm lại dưới khoá trong transaction bên dưới.
 */
export async function sessionCompleted(
  { db, config, logger }: DriverReportDeps,
  transactionNo: number,
): Promise<'resolved' | 'none'> {
  const session = (
    await db.execute<{
      id: string;
      charge_point_id: string;
      connector_id: string;
      connector_no: number;
      id_tag: string;
      transaction_no: number;
      meter_start_wh: string;
      meter_stop_wh: string;
      cp_started_at: Date;
      cp_stopped_at: Date | null;
      received_started_at: Date;
      received_stopped_at: Date | null;
      delivered_offline: boolean;
      energy_wh: string | null;
      stop_reason: string | null;
    }>(sql`SELECT s.id::text, s.charge_point_id::text, s.connector_id::text, c.connector_no,
        s.id_tag, s.transaction_no, s.meter_start_wh::text, s.meter_stop_wh::text,
        s.cp_started_at, s.cp_stopped_at, s.received_started_at, s.received_stopped_at,
        s.delivered_offline, (s.meter_stop_wh - s.meter_start_wh)::text AS energy_wh, s.stop_reason
      FROM sessions s JOIN connectors c ON c.id = s.connector_id
      WHERE s.transaction_no = ${transactionNo}`)
  ).rows[0];
  if (
    !session?.received_stopped_at ||
    !(Number(session.energy_wh) > 0) ||
    FAULT_STOP_REASONS.has(session.stop_reason ?? 'Local')
  )
    return 'none';
  const [candidate] = await db
    .select({ id: faultEvents.id })
    .from(faultEvents)
    .where(
      and(
        eq(faultEvents.chargePointId, Number(session.charge_point_id)),
        eq(faultEvents.connectorId, Number(session.connector_id)),
        eq(faultEvents.source, 'driver_report'),
        ne(faultEvents.status, 'resolved'),
      ),
    )
    .limit(1);
  if (!candidate) return 'none';
  const startedAt = await reconciledStart(db, config, session);
  if (startedAt === null) return 'none';
  const at = new Date(session.received_stopped_at);
  const resolvedId = await db.transaction(async (tx) => {
    const open = await findOpenForUpdate(
      tx,
      Number(session.charge_point_id),
      Number(session.connector_id),
    );
    if (
      !open ||
      open.source !== 'driver_report' ||
      !(startedAt > open.raisedAt) ||
      !sm.canApply(open.status, 'SESSION_COMPLETED')
    )
      return null;
    const step = sm.apply(open.status, 'SESSION_COMPLETED');
    await tx
      .update(faultEvents)
      .set({ status: step.to, resolvedAt: at })
      .where(eq(faultEvents.id, open.id));
    await clearReports(tx, open.id, at, null);
    return open.id;
  });
  if (resolvedId === null) return 'none';
  logger.log(`sự cố #${resolvedId} resolved: phiên ${transactionNo} hoàn tất bình thường`);
  return 'resolved';
}

/** Lúc phiên bắt đầu theo giờ đã đối soát (t8); null = không xác định được. */
async function reconciledStart(
  db: Db,
  config: CsmsConfig,
  session: {
    id: string;
    charge_point_id: string;
    connector_no: number;
    id_tag: string;
    transaction_no: number;
    meter_start_wh: string;
    meter_stop_wh: string;
    cp_started_at: Date;
    cp_stopped_at: Date | null;
    received_started_at: Date;
    received_stopped_at: Date | null;
    delivered_offline: boolean;
  },
): Promise<Date | null> {
  const client = await db.$client.connect();
  try {
    const clock = await resolveTariffClock(
      client,
      {
        ...session,
        cp_started_at: new Date(session.cp_started_at),
        cp_stopped_at: session.cp_stopped_at ? new Date(session.cp_stopped_at) : null,
        received_started_at: new Date(session.received_started_at),
        received_stopped_at: new Date(session.received_stopped_at!),
      },
      (config.tariffClockToleranceS ?? DEFAULT_TARIFF_CLOCK_TOLERANCE_S) * 1000,
      config.replaySkewThresholdS * 1000,
    );
    if (!('issue' in clock))
      return new Date(new Date(session.cp_started_at).getTime() + clock.offsetMs);
  } finally {
    client.release();
  }
  return session.delivered_offline ? null : new Date(session.received_started_at);
}
