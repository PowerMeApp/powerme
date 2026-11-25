/**
 * Hàm giao dịch dùng chung của WF-04 (STM-6): khoá, tìm, gắn / chuyển / xoá báo cáo. Hàm thuần —
 * nhận `tx` (hoặc `db`) làm tham số đầu, không giữ trạng thái. Thứ tự khoá (T131): connector trước
 * (`lockConnectors`), rồi tới dòng sự cố (`findOpenForUpdate` / `lockFault`).
 */
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../db/db.module.js';
import { chargePoints, connectors, faultEvents, faultReports } from '../../db/schema/index.js';
import { FaultStateMachine } from './fault-state-machine.js';
import { FaultNotFoundError, REPORT_WINDOW_MS } from './fault.types.js';

/** Bảng chuyển trạng thái STM-6 là hằng: một instance dùng chung là đủ. */
const sm = new FaultStateMachine();

/** T141: một nhóm báo cáo tài xế đã chuyển sang sự cố đang mở của súng. */
export interface HandOver {
  toFaultId: number;
  reports: number;
  created: boolean;
}

/** connectors.id; null cho connector 0 (cả trụ); undefined khi trụ không có súng số này. */
export async function resolveConnectorId(
  db: DbExecutor,

  chargePointId: number,
  connectorNo: number,
): Promise<number | null | undefined> {
  if (connectorNo === 0) return null;
  const [row] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(eq(connectors.chargePointId, chargePointId), eq(connectors.connectorNo, connectorNo)),
    );
  return row?.id;
}

/**
 * T131: khoá dòng connector `FOR NO KEY UPDATE` (không chặn FK `KEY SHARE` của phiên / báo cáo)
 * trước khi tìm hay tạo sự cố. Sự cố cả trụ (`connectorId` null) khoá mọi connector của trụ theo
 * id — cùng thứ tự ở mọi đường nên không deadlock.
 */
export async function lockConnectors(
  tx: DbExecutor,
  chargePointId: number,
  connectorId: number | null,
) {
  await tx.execute(
    connectorId === null
      ? sql`SELECT id FROM connectors WHERE charge_point_id = ${chargePointId} ORDER BY id FOR NO KEY UPDATE`
      : sql`SELECT id FROM connectors WHERE id = ${connectorId} FOR NO KEY UPDATE`,
  );
}

export async function findOpenForUpdate(
  tx: DbExecutor,
  chargePointId: number,
  connectorId: number | null,
) {
  const [row] = await tx
    .select({
      id: faultEvents.id,
      status: faultEvents.status,
      raisedAt: faultEvents.raisedAt,
      source: faultEvents.source,
      errorCode: faultEvents.errorCode,
    })
    .from(faultEvents)
    .where(
      and(
        eq(faultEvents.chargePointId, chargePointId),
        connectorId === null
          ? isNull(faultEvents.connectorId)
          : eq(faultEvents.connectorId, connectorId),
        ne(faultEvents.status, 'resolved'),
      ),
    )
    .for('update');
  return row;
}

/** Lúc sự cố gần nhất của súng (connector 0: cả trụ) được đóng; null nếu chưa có. */
export async function lastResolvedAt(
  tx: DbExecutor,
  chargePointId: number,
  connectorId: number | null,
): Promise<Date | null> {
  const [row] = await tx
    .select({ resolvedAt: faultEvents.resolvedAt })
    .from(faultEvents)
    .where(
      and(
        eq(faultEvents.chargePointId, chargePointId),
        connectorId === null
          ? isNull(faultEvents.connectorId)
          : eq(faultEvents.connectorId, connectorId),
        eq(faultEvents.status, 'resolved'),
      ),
    )
    .orderBy(desc(faultEvents.resolvedAt))
    .limit(1);
  return row?.resolvedAt ?? null;
}

/**
 * Q79 / AD-7: gắn các báo cáo chờ (chưa gộp, chưa xoá, trong 2 giờ) vào sự cố vừa mở —
 * của một súng, hoặc của mọi súng trên trụ khi sự cố là cả trụ (`connectorId` null).
 */
export async function attachWaitingReports(
  tx: DbExecutor,
  chargePointId: number,
  connectorId: number | null,
  faultId: number,
  at: Date,
): Promise<void> {
  await tx.execute(sql`UPDATE fault_reports SET fault_event_id = ${faultId}, updated_at = now()
    WHERE fault_event_id IS NULL AND cleared_at IS NULL
      AND reported_at > ${at}::timestamptz - (${REPORT_WINDOW_MS}::bigint * interval '1 millisecond')
      AND ${
        connectorId === null
          ? sql`connector_id IN (SELECT id FROM connectors WHERE charge_point_id = ${chargePointId})`
          : sql`connector_id = ${connectorId}`
      }`);
}

/**
 * T141 (BR-P42, quyết định D-X 17/11): một sự cố OCPP / Offline tự đóng (súng hồi phục, trụ nối
 * lại) KHÔNG xoá nhãn "reported issue" của các báo cáo tài xế gắn vào nó — đổi trạng thái không
 * chứng minh súng hết lỗi tài xế thấy. Các báo cáo chưa xoá được chuyển, theo từng súng, sang sự cố
 * đang mở của súng đó, hoặc một sự cố `driver_report` mới (t1). Từ đó chỉ Operator đóng (t7) hoặc
 * t8 mới xoá nhãn. Người gọi đã khoá connector (thứ tự khoá của T131) và đã đóng sự cố cũ.
 */
export async function handOverReports(
  tx: DbExecutor,
  closedFaultId: number,
  chargePointId: number,
  at: Date,
): Promise<HandOver[]> {
  const groups = (
    await tx.execute<{ connector_id: string; n: number }>(sql`SELECT connector_id::text,
        count(*)::int AS n FROM fault_reports
      WHERE fault_event_id = ${closedFaultId} AND cleared_at IS NULL
      GROUP BY connector_id ORDER BY connector_id`)
  ).rows;
  const moved: HandOver[] = [];
  for (const g of groups) {
    const connectorId = Number(g.connector_id);
    const open = await findOpenForUpdate(tx, chargePointId, connectorId);
    let toFaultId = open?.id;
    if (open)
      sm.apply(open.status, 'SIGNAL'); // no-op: gắn vào sự cố đang mở
    else {
      const [row] = await tx
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
      if (!row) throw new Error('INSERT fault_events không trả id');
      toFaultId = row.id;
    }
    await tx.execute(sql`UPDATE fault_reports SET fault_event_id = ${toFaultId!}, updated_at = now()
      WHERE fault_event_id = ${closedFaultId} AND cleared_at IS NULL
        AND connector_id = ${connectorId}`);
    moved.push({ toFaultId: toFaultId!, reports: g.n, created: !open });
  }
  return moved;
}

/** BR-P42: sự cố đóng → xoá nhãn "reported issue" của các báo cáo gắn vào nó. */
export async function clearReports(
  tx: DbExecutor,
  faultId: number,
  at: Date,
  staffId: number | null,
): Promise<void> {
  await tx
    .update(faultReports)
    .set({ clearedAt: at, clearedBy: staffId })
    .where(and(eq(faultReports.faultEventId, faultId), isNull(faultReports.clearedAt)));
}

export async function lockFault(tx: DbExecutor, faultId: number) {
  const [row] = await tx
    .select({
      id: faultEvents.id,
      status: faultEvents.status,
      chargePointId: faultEvents.chargePointId,
      serial: chargePoints.serialNumber,
    })
    .from(faultEvents)
    .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
    .where(eq(faultEvents.id, faultId))
    .for('update', { of: faultEvents });
  if (!row) throw new FaultNotFoundError(faultId);
  return row;
}
