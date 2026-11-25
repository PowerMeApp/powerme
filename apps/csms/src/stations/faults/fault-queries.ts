/**
 * Phía đọc của WF-04: danh sách cảnh báo (console, màn 21 / 20 / 17), đếm, một sự cố, báo cáo của
 * tài xế. Không khoá, không ghi.
 */
import { and, desc, eq, ne, SQL, sql, SQLWrapper } from 'drizzle-orm';
import type { DbExecutor } from '../../db/db.module.js';
import {
  chargePoints,
  connectors,
  faultEvents,
  faultReports,
  remoteCommands,
  sites,
} from '../../db/schema/index.js';
import {
  CHARGE_POINT_ERROR_CODES,
  ERROR_CODE_GUIDE,
  guideFor,
  OFFLINE_ERROR_CODE,
  OFFLINE_GUIDE,
  severityRank,
} from './error-code-guide.js';
import { FaultNotFoundError, type FaultListFilter, type FaultListItem } from './fault.types.js';

/**
 * `CASE error_code WHEN 'GroundFailure' THEN 0 … ELSE <hạng của OtherError> END` — hạng nặng nhẹ của
 * ErrorCodeGuide đưa vào ORDER BY để sắp trước LIMIT. Mã và số đều là hằng của bảng tĩnh (không
 * phải dữ liệu người dùng) nên ghép thẳng vào SQL.
 */
function severityRankSql(column: SQLWrapper): SQL {
  const whens = CHARGE_POINT_ERROR_CODES.map((code) =>
    sql.raw(`WHEN '${code}' THEN ${severityRank(ERROR_CODE_GUIDE[code].severity)}`),
  );
  whens.push(sql.raw(`WHEN '${OFFLINE_ERROR_CODE}' THEN ${severityRank(OFFLINE_GUIDE.severity)}`));
  return sql`CASE ${column} ${sql.join(whens, sql` `)} ELSE ${sql.raw(String(severityRank(guideFor(null).severity)))} END`;
}

/**
 * Danh sách cảnh báo: sự cố mở trước, nặng trước, mới trước — sắp XẾP TRONG SQL rồi mới LIMIT, để
 * 25 lỗi nhẹ mới hơn không đẩy một lỗi nghiêm trọng cũ ra khỏi trang (review #61).
 */
export async function listFaults(
  db: DbExecutor,

  filter: FaultListFilter,
  limit: number,
  /** Only this Operator's charge points (BR-P16); omitted = all (dev console). */
  operatorId?: number,
  offset = 0,
  /** FE-05: only this charge point (screen 20 fault history). */
  chargePointId?: number,
): Promise<FaultListItem[]> {
  const rows = await db
    .select({
      id: faultEvents.id,
      eventNo: faultEvents.eventNo,
      chargePointId: faultEvents.chargePointId,
      serial: chargePoints.serialNumber,
      connectorNo: connectors.connectorNo,
      source: faultEvents.source,
      errorCode: faultEvents.errorCode,
      status: faultEvents.status,
      raisedAt: faultEvents.raisedAt,
      acknowledgedAt: faultEvents.acknowledgedAt,
      resolvedAt: faultEvents.resolvedAt,
      resetCommandId: faultEvents.resetCommandId,
      resetCommandStatus: remoteCommands.status,
      resetRequestedAt: remoteCommands.requestedAt,
      isOnline: chargePoints.isOnline,
      reportCount: sql<number>`(SELECT count(*)::int FROM fault_reports r WHERE r.fault_event_id = ${faultEvents.id})`,
      siteName: sites.siteName,
    })
    .from(faultEvents)
    .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
    .leftJoin(sites, eq(sites.id, chargePoints.siteId))
    .leftJoin(connectors, eq(connectors.id, faultEvents.connectorId))
    .leftJoin(remoteCommands, eq(remoteCommands.id, faultEvents.resetCommandId))
    .where(listWhere(filter, operatorId, chargePointId))
    .orderBy(
      sql`(${faultEvents.status} = 'resolved')`,
      severityRankSql(faultEvents.errorCode),
      desc(faultEvents.raisedAt),
      desc(faultEvents.id),
    )
    .limit(limit)
    .offset(offset);
  return rows.map((r) => {
    const g = guideFor(r.errorCode);
    return {
      ...r,
      connectorNo: r.connectorNo ?? (r.source === 'ocpp' ? 0 : null),
      severity: g.severity,
      hint: g.hint,
    };
  });
}

/** Rows `list` would page through (same filter and Operator scope), for the pager's total. */
export async function countFaults(
  db: DbExecutor,

  filter: FaultListFilter,
  operatorId?: number,
  chargePointId?: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(faultEvents)
    .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
    .leftJoin(sites, eq(sites.id, chargePoints.siteId))
    .where(listWhere(filter, operatorId, chargePointId));
  return row?.n ?? 0;
}

export function listWhere(filter: FaultListFilter, operatorId?: number, chargePointId?: number) {
  return and(
    filter === 'open'
      ? ne(faultEvents.status, 'resolved')
      : filter === 'all'
        ? undefined
        : eq(faultEvents.status, filter),
    operatorId === undefined ? undefined : eq(sites.operatorId, operatorId),
    chargePointId === undefined ? undefined : eq(faultEvents.chargePointId, chargePointId),
  );
}

/**
 * Một sự cố (không khoá) — để người gọi kiểm trước khi gửi lệnh. With `operatorId`, a FaultEvent of
 * another Operator's charge point is "not found" (404, never 403: no hint that it exists).
 */
export async function getFault(db: DbExecutor, faultId: number, operatorId?: number) {
  const [row] = await db
    .select({
      id: faultEvents.id,
      status: faultEvents.status,
      chargePointId: faultEvents.chargePointId,
      serial: chargePoints.serialNumber,
    })
    .from(faultEvents)
    .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
    .leftJoin(sites, eq(sites.id, chargePoints.siteId))
    .where(
      and(
        eq(faultEvents.id, faultId),
        operatorId === undefined ? undefined : eq(sites.operatorId, operatorId),
      ),
    );
  if (!row) throw new FaultNotFoundError(faultId);
  return row;
}

/** Báo cáo của tài xế gắn vào một sự cố (F-05: Operator thấy nội dung). */
export async function reportsOf(db: DbExecutor, faultId: number) {
  return db
    .select({
      reportNo: faultReports.reportNo,
      connectorId: faultReports.connectorId,
      description: faultReports.description,
      reportedAt: faultReports.reportedAt,
      clearedAt: faultReports.clearedAt,
    })
    .from(faultReports)
    .where(eq(faultReports.faultEventId, faultId))
    .orderBy(faultReports.reportedAt);
}
