/**
 * FaultService — nơi DUY NHẤT ghi `fault_events` (WF-04 xử lý lỗi trụ, STM-6, FE-04).
 *
 * Vì sao tồn tại: WF-04 (docs/WF-04-XU-LY-LOI-TRU.md) biến tín hiệu lỗi của trụ thành một cảnh
 * báo có vòng đời cho operator: raised → acknowledged → resetting → resolved. Trước FE-04,
 * StatusNotification Faulted chỉ được phản chiếu vào `connectors` / `connector_status_events`,
 * không ai ghi `fault_events`. Theo ADR-0016 D-F service này nằm trong `stations`; gateway gọi
 * vào đây, stations KHÔNG import gateway — vì vậy việc GỬI Reset (cần ConnectionRegistry) do
 * người gọi làm (console), service chỉ ghi `remote_commands`, chuyển trạng thái và giữ hẹn giờ:
 *
 *   beginReset() → [người gọi: markSent() → client.call('Reset') → onResetResult()]
 *
 * Bất biến:
 *   - Một sự cố MỞ (status <> resolved) cho mỗi connector; connector 0 = cả trụ (connector_id
 *     null). Tìm sự cố mở bằng SELECT … FOR UPDATE; chỉ mục UNIQUE của migration 0008 là rào cuối.
 *   - Faulted lặp lại → gắn vào sự cố đang mở, GIỮ error_code đầu tiên (mã sau xem ở
 *     connector_status_events).
 *   - Súng về trạng thái hoạt động ({@link RECOVERED_STATUSES}: Available hoặc bắt đầu phục vụ
 *     ngay — Preparing, Charging…) thì kết thúc sự cố (t3/t5/t7). `Unavailable` sau khi trụ khởi
 *     động lại thì chưa (WF-04 câu hỏi 6, T13: Faulted → Unavailable → Available).
 *   - Thời điểm sự cố lấy theo đồng hồ trụ khi frame là bản PHÁT LẠI (`occurredAt`, do gateway
 *     chọn): trụ mất mạng 30 phút rồi gửi lại Faulted lúc 10:05 thì raised_at = 10:05, không phải
 *     lúc CSMS nhận.
 *   - Hẹn giờ chờ Reset nằm trong RAM ({@link Scheduler}); khởi động lại thì quét DB dựng lại
 *     (cùng cách OfflineGraceService của T61).
 *
 * Trụ im lặng quá OFFLINE_ALERT_S (G10, NFR-OCPP-07): {@link FaultService.raiseOffline} /
 * {@link FaultService.resolveOffline}, do OfflineAlertService gọi theo nhịp quét — sự cố cả trụ
 * (connector 0) với error_code `Offline`.
 *
 * Chưa làm (docs/ITERATION-1-WF04.md mục 7): báo lỗi từ app tài xế (chưa có API), phiếu bảo trì
 * (Should), ẩn súng + huỷ đặt chỗ (Should), sự kiện realtime `alert.*`.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, isNull, ne, SQL, sql, SQLWrapper } from 'drizzle-orm';
import { ScheduledTask, Scheduler, TimeoutScheduler } from '../../common/scheduler.js';
import {
  CONFIG,
  CsmsConfig,
  DEFAULT_FAULT_RESET_TIMEOUT_S,
  DEFAULT_OFFLINE_ALERT_S,
} from '../../config.js';
import { DB, Db, DbExecutor } from '../../db/db.module.js';
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
  FaultSeverity,
  guideFor,
  OFFLINE_ERROR_CODE,
  OFFLINE_GUIDE,
  severityRank,
} from './error-code-guide.js';
import {
  FaultStateMachine,
  FaultStatus,
  FaultTrigger,
  InvalidFaultTransitionError,
} from './fault-state-machine.js';

export const FAULT_RESET_SCHEDULER = Symbol('FAULT_RESET_SCHEDULER');

export type ResetType = 'Soft' | 'Hard';

/** Không có sự cố với id này. */
export class FaultNotFoundError extends Error {
  constructor(readonly faultId: number) {
    super(`Không có sự cố id=${faultId}`);
    this.name = 'FaultNotFoundError';
  }
}

/** Việc FaultService đã làm với một StatusNotification. */
export type StatusOutcome =
  | { kind: 'raised'; faultId: number }
  | { kind: 'attached'; faultId: number }
  | { kind: 'resolved'; faultId: number; from: FaultStatus }
  /** Bản phát lại cũ hơn trạng thái hiện tại của sự cố: không đổi gì (xem {@link eventTime}). */
  | { kind: 'stale'; faultId: number | null }
  | { kind: 'none' };

/** FE-17 (UC-CHG-05): lỗi nghiệp vụ của báo lỗi từ tài xế; route HTTP đổi sang mã lỗi. */
export class DriverReportError extends Error {
  constructor(readonly code: 'invalid_description' | 'not_found' | 'duplicate_report') {
    super(code);
    this.name = 'DriverReportError';
  }
}

export interface DriverReportResult {
  reportId: number;
  reportNo: number;
  connectorId: number;
  reportedAt: Date;
  /** Sự cố mà báo cáo được gắn vào (mới tạo hoặc đang mở); null = chờ gộp sau (AD-7). */
  faultEventId: number | null;
  /** Súng đang mang nhãn "reported issue" (BR-P42) sau báo cáo này. */
  reportedIssue: boolean;
}

/** BR-P42: cửa sổ 2 giờ — đếm tài xế khác nhau, và gộp báo cáo chờ khi một sự cố mở (Q79). */
export const REPORT_WINDOW_MS = 2 * 3600 * 1000;
/** Q80: cùng tài xế, cùng súng trong 60 s → trùng (bấm hai lần). */
export const DUPLICATE_REPORT_MS = 60 * 1000;
/** Q78: trạng thái súng "bất thường" — một báo cáo là đủ. Trụ Offline cũng tính. */
const ABNORMAL_STATUSES = ['Faulted', 'Unavailable'];
/** Q77: phiên dừng vì các lý do này không phải "hoàn tất bình thường" (BR-P42). */
export const FAULT_STOP_REASONS: ReadonlySet<string> = new Set([
  'EmergencyStop',
  'PowerLoss',
  'Other',
]);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface ConnectorStatusInput {
  chargePointId: number;
  /** connectorId của OCPP: 0 = cả trụ. */
  connectorNo: number;
  status: string;
  errorCode: string | null;
  receivedAt: Date;
  /**
   * Lúc sự việc xảy ra: đồng hồ trụ (`timestamp` trong payload) nếu frame là bản phát lại, ngược
   * lại `receivedAt` (ADR-0009: received_at là đồng hồ tin cậy cho frame live). Ghi raised_at /
   * resolved_at. Bỏ trống = `receivedAt`.
   */
  occurredAt?: Date;
}

/**
 * Trạng thái súng coi là ĐÃ HỒI PHỤC (trigger CONNECTOR_AVAILABLE của STM-6). OCPP 1.6 cho súng
 * thoát Faulted sang bất kỳ trạng thái nào (bảng I1…I8, `valid-transitions.ts`): lỗi tự hết rồi tài
 * xế cắm sạc luôn thì súng đi Faulted → Preparing → Charging, không qua Available. `Unavailable`
 * KHÔNG nằm đây: đó là bước giữa lúc trụ khởi động lại (T13 2.3 #14), lỗi có thể vẫn còn.
 */
export const RECOVERED_STATUSES: ReadonlySet<string> = new Set([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
]);

export interface BeginResetResult {
  faultId: number;
  commandId: number;
  serial: string;
}

/** Kết quả CALL Reset do người gọi báo lại. */
export type ResetOutcome =
  { status: 'Accepted' | 'Rejected'; response?: unknown } | { error: string };

/** List filter: `open` = not resolved, `all`, or exactly one STM-6 status (screen 21). */
export type FaultListFilter = 'open' | 'all' | FaultStatus;

/** Một dòng của danh sách cảnh báo (console, sau này dashboard FE-04). */
export interface FaultListItem {
  id: number;
  eventNo: number;
  serial: string;
  connectorNo: number | null;
  source: string;
  errorCode: string | null;
  severity: FaultSeverity;
  hint: string;
  status: FaultStatus;
  raisedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resetCommandId: number | null;
  resetCommandStatus: string | null;
  /** When the pending Reset was requested; its wait ends `resetTimeoutS` later. */
  resetRequestedAt: Date | null;
  isOnline: boolean;
  /** Số báo cáo của tài xế gắn vào sự cố (F-05: Operator thấy báo cáo). */
  reportCount: number;
  /** Charging Station name (`sites.site_name`); null for a charge point not yet on a site. */
  siteName: string | null;
}

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
 * Bản phát lại cũ hơn mức này coi là đồng hồ trụ sai (pin RTC hết → 1970…), không phải hàng đợi
 * offline thật. Hàng đợi của trụ không giữ lâu hơn vài ngày; 30 ngày để dư.
 */
export const MAX_REPLAY_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * Thời điểm ghi cho sự cố: `occurredAt` (giờ trụ của bản phát lại) nhưng KHÔNG muộn hơn lúc CSMS
 * nhận (đồng hồ trụ chạy nhanh) và không cũ hơn {@link MAX_REPLAY_AGE_MS} (đồng hồ trụ hỏng) —
 * hai trường hợp đó dùng `receivedAt` (ADR-0009: received_at là đồng hồ tin cậy).
 */
export function eventTime(input: Pick<ConnectorStatusInput, 'occurredAt' | 'receivedAt'>): Date {
  const occurred = input.occurredAt;
  if (!occurred || Number.isNaN(occurred.getTime())) return input.receivedAt;
  const rx = input.receivedAt.getTime();
  if (occurred.getTime() > rx || rx - occurred.getTime() > MAX_REPLAY_AGE_MS) {
    return input.receivedAt;
  }
  return occurred;
}

/** Trạng thái lệnh `remote_commands` còn chưa có kết quả. */
const IN_FLIGHT = ['pending', 'sent'] as const;

@Injectable()
export class FaultService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FaultService.name);
  private readonly sm = new FaultStateMachine();
  /** faultId → hẹn giờ chờ Reset. */
  private readonly timers = new Map<number, ScheduledTask>();
  private readonly scheduler: Scheduler;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
    @Optional() @Inject(FAULT_RESET_SCHEDULER) scheduler?: Scheduler,
  ) {
    this.scheduler = scheduler ?? new TimeoutScheduler();
  }

  /** Hạn chờ Reset hiệu lực (giây). */
  get resetTimeoutS(): number {
    return this.config.faultResetTimeoutS ?? DEFAULT_FAULT_RESET_TIMEOUT_S;
  }

  /** Số hẹn giờ đang chờ (để test / quan sát). */
  get pendingResetCount(): number {
    return this.timers.size;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const s = await this.recoverAfterRestart();
      if (s.timedOut + s.scheduled > 0)
        this.logger.warn(
          `khởi động: ${s.timedOut} sự cố resetting quá hạn → acknowledged, ${s.scheduled} hẹn giờ dựng lại`,
        );
    } catch (err) {
      this.logger.error(`quét sự cố resetting sau khởi động lỗi: ${String(err)}`);
    }
  }

  onApplicationShutdown(): void {
    this.cancelAll();
  }

  /** Huỷ mọi hẹn giờ (Jest không treo "open handles"). */
  cancelAll(): void {
    for (const task of this.timers.values()) task.cancel();
    this.timers.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Tín hiệu từ trụ
  // ---------------------------------------------------------------------------------------------

  /**
   * Gọi SAU khi SessionsService đã phản chiếu StatusNotification (frame của một trụ được tuần tự
   * hoá nên thứ tự an toàn). `Faulted` → t1 hoặc gắn vào sự cố mở; trạng thái hồi phục
   * ({@link RECOVERED_STATUSES}) → kết thúc sự cố mở. `Unavailable` / status lạ: không làm gì.
   *
   * Chống bản phát lại cũ (hàng đợi offline trộn với frame live, EXP-01): frame hồi phục có thời
   * điểm TRƯỚC `raised_at` của sự cố đang mở không đóng sự cố (vd. `Charging` 10:00 phát lại sau
   * khi `Faulted` live 10:30 đã mở sự cố); `Faulted` có thời điểm trước lúc sự cố gần nhất của súng
   * đã đóng không mở lại sự cố cũ. Cả hai trả `stale`, frame vẫn nằm trong log.
   */
  async onConnectorStatus(input: ConnectorStatusInput): Promise<StatusOutcome> {
    if (input.status !== 'Faulted' && !RECOVERED_STATUSES.has(input.status)) {
      return { kind: 'none' };
    }
    const at = eventTime(input);
    const connectorId = await this.resolveConnectorId(input.chargePointId, input.connectorNo);
    if (connectorId === undefined) return { kind: 'none' };

    const outcome = await this.db.transaction(async (tx) => {
      const open = await this.findOpenForUpdate(tx, input.chargePointId, connectorId);
      if (input.status === 'Faulted') {
        if (open) {
          this.sm.apply(open.status, 'SIGNAL'); // no-op, ném nếu bảng đổi
          return { kind: 'attached', faultId: open.id } as const;
        }
        const lastResolved = await this.lastResolvedAt(tx, input.chargePointId, connectorId);
        if (lastResolved && at < lastResolved) return { kind: 'stale', faultId: null } as const;
        const [row] = await tx
          .insert(faultEvents)
          .values({
            chargePointId: input.chargePointId,
            connectorId,
            source: 'ocpp',
            errorCode: input.errorCode,
            status: this.sm.initial(),
            raisedAt: at,
          })
          .returning({ id: faultEvents.id });
        if (!row) throw new Error('INSERT fault_events không trả id');
        await this.attachWaitingReports(tx, input.chargePointId, connectorId, row.id, at);
        return { kind: 'raised', faultId: row.id } as const;
      }
      if (!open) return { kind: 'none' } as const;
      // FE-17 (Q76): sự cố do tài xế báo chỉ đóng bằng đúng `Available` như STM-6 ghi — cắm xe
      // (Preparing) không chứng minh súng đã hết lỗi.
      if (open.source === 'driver_report' && input.status !== 'Available') {
        return { kind: 'none' } as const;
      }
      if (at < open.raisedAt) return { kind: 'stale', faultId: open.id } as const;
      const step = this.sm.apply(open.status, 'CONNECTOR_AVAILABLE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, open.id));
      await this.clearReports(tx, open.id, at, null);
      return { kind: 'resolved', faultId: open.id, from: open.status } as const;
    });

    if (outcome.kind === 'resolved') this.clearTimer(outcome.faultId);
    if (outcome.kind === 'stale') {
      this.logger.warn(
        `trụ ${input.chargePointId} c${input.connectorNo}: bỏ qua ${input.status} phát lại lúc ${at.toISOString()} (cũ hơn trạng thái sự cố hiện tại)`,
      );
    }
    if (outcome.kind === 'raised') {
      this.logger.warn(
        `sự cố #${outcome.faultId} raised: trụ ${input.chargePointId} c${input.connectorNo} ${input.errorCode ?? '?'}`,
      );
    }
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // Trụ im lặng (G10, NFR-OCPP-07) — OfflineAlertService gọi theo nhịp quét
  // ---------------------------------------------------------------------------------------------

  /**
   * t1 cho trụ im lặng quá OFFLINE_ALERT_S: sự cố cả trụ (connector 0, `connector_id` null),
   * `error_code` = {@link OFFLINE_ERROR_CODE}. Đã có sự cố connector 0 đang mở (Faulted cả trụ, hoặc
   * Offline từ lần quét trước) → `SIGNAL` là no-op, trả `attached` — bất biến "một sự cố mở mỗi
   * connector" giữ nguyên.
   *
   * `source = 'ocpp'`: enum `fault_source` chưa có giá trị riêng cho tín hiệu do CSMS tự phát hiện;
   * thêm giá trị mới cần migration + ERD (Ân), nên tạm phân biệt bằng `error_code`.
   */
  async raiseOffline(chargePointId: number, at: Date = new Date()): Promise<StatusOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      const open = await this.findOpenForUpdate(tx, chargePointId, null);
      if (open) {
        this.sm.apply(open.status, 'SIGNAL'); // no-op, ném nếu bảng đổi
        return { kind: 'attached', faultId: open.id } as const;
      }
      const [row] = await tx
        .insert(faultEvents)
        .values({
          chargePointId,
          connectorId: null,
          source: 'ocpp',
          errorCode: OFFLINE_ERROR_CODE,
          status: this.sm.initial(),
          raisedAt: at,
        })
        .returning({ id: faultEvents.id });
      if (!row) throw new Error('INSERT fault_events không trả id');
      await this.attachWaitingReports(tx, chargePointId, null, row.id, at);
      return { kind: 'raised', faultId: row.id } as const;
    });
    if (outcome.kind === 'raised') {
      this.logger.warn(`sự cố #${outcome.faultId} raised: trụ ${chargePointId} im lặng (Offline)`);
    }
    return outcome;
  }

  /**
   * Trụ đã nói lại: đóng sự cố `Offline` đang mở bằng `CONNECTOR_AVAILABLE` (t3/t5/t7). Chỉ đụng sự
   * cố còn mở và đúng mã `Offline` — sự cố Faulted cả trụ vẫn chờ StatusNotification hồi phục.
   */
  async resolveOffline(faultId: number, at: Date = new Date()): Promise<'resolved' | 'noop'> {
    const res = await this.db.transaction(async (tx) => {
      const [fault] = await tx
        .select({ status: faultEvents.status, errorCode: faultEvents.errorCode })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId))
        .for('update');
      if (!fault || fault.status === 'resolved' || fault.errorCode !== OFFLINE_ERROR_CODE) {
        return 'noop' as const;
      }
      const step = this.sm.apply(fault.status, 'CONNECTOR_AVAILABLE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, faultId));
      await this.clearReports(tx, faultId, at, null);
      return 'resolved' as const;
    });
    if (res === 'resolved') {
      this.clearTimer(faultId);
      this.logger.log(`sự cố #${faultId} resolved: trụ đã kết nối lại`);
    }
    return res;
  }

  // ---------------------------------------------------------------------------------------------
  // Hành động của operator
  // ---------------------------------------------------------------------------------------------

  // ---------------------------------------------------------------------------------------------
  // Tài xế báo lỗi (FE-17: UC-CHG-05, BR-P42, Q75–Q81)
  // ---------------------------------------------------------------------------------------------

  /**
   * Ghi một báo lỗi của tài xế cho một súng và áp BR-P42:
   * - súng (hoặc cả trụ) đang có sự cố mở → gắn vào đó, không tạo sự cố mới (Q81, STM-6);
   * - 2 tài xế khác nhau trong 2 giờ, hoặc 1 tài xế khi súng Faulted / Unavailable / trụ Offline
   *   (Q78) → tạo sự cố `driver_report` (t1) và gộp mọi báo cáo chờ của súng trong 2 giờ (Q79);
   * - chưa đủ → chỉ lưu, chờ gộp sau (AD-7).
   * Cùng tài xế + cùng súng trong 60 s → `duplicate_report`, không ghi gì (Q80).
   */
  async reportFromDriver(
    driverId: number,
    connectorId: number,
    description: string,
    at: Date = new Date(),
  ): Promise<DriverReportResult> {
    const text = typeof description === 'string' ? description.trim() : '';
    const length = [...text].length;
    if (length < 5 || length > 500 || CONTROL.test(text))
      throw new DriverReportError('invalid_description');
    const offlineMs = (this.config.offlineAlertS ?? DEFAULT_OFFLINE_ALERT_S) * 1000;

    const result = await this.db.transaction(async (tx) => {
      // Khoá dòng súng: hai báo cáo cùng lúc cho một súng đi tuần tự (đếm tài xế không lệch).
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
          FOR UPDATE OF c`)
      ).rows[0];
      if (!target) throw new DriverReportError('not_found');
      const chargePointId = Number(target.charge_point_id);

      const duplicate = await tx.execute(sql`SELECT 1 FROM fault_reports
        WHERE driver_id = ${driverId} AND connector_id = ${connectorId}
          AND reported_at > ${at}::timestamptz - (${DUPLICATE_REPORT_MS}::bigint * interval '1 millisecond')`);
      if (duplicate.rows.length) throw new DriverReportError('duplicate_report');

      const open =
        (await this.findOpenForUpdate(tx, chargePointId, connectorId)) ??
        (await this.findOpenForUpdate(tx, chargePointId, null));
      if (open) this.sm.apply(open.status, 'SIGNAL'); // no-op: gắn vào sự cố đang mở

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

      const [event] = await tx
        .insert(faultEvents)
        .values({
          chargePointId,
          connectorId,
          source: 'driver_report',
          errorCode: null,
          status: this.sm.initial(),
          raisedAt: at,
        })
        .returning({ id: faultEvents.id });
      if (!event) throw new Error('INSERT fault_events không trả id');
      await this.attachWaitingReports(tx, chargePointId, connectorId, event.id, at);
      return { report, faultEventId: event.id, raised: true };
    });

    if (result.raised)
      this.logger.warn(
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
   */
  async onSessionCompleted(transactionNo: number): Promise<'resolved' | 'none'> {
    const session = (
      await this.db.execute<{
        charge_point_id: string;
        connector_id: string;
        received_started_at: Date;
        received_stopped_at: Date | null;
        energy_wh: string | null;
        stop_reason: string | null;
      }>(sql`SELECT charge_point_id::text, connector_id::text, received_started_at,
          received_stopped_at, (meter_stop_wh - meter_start_wh)::text AS energy_wh, stop_reason
        FROM sessions WHERE transaction_no = ${transactionNo}`)
    ).rows[0];
    if (
      !session?.received_stopped_at ||
      !(Number(session.energy_wh) > 0) ||
      FAULT_STOP_REASONS.has(session.stop_reason ?? 'Local')
    )
      return 'none';
    const at = new Date(session.received_stopped_at);
    const resolvedId = await this.db.transaction(async (tx) => {
      const open = await this.findOpenForUpdate(
        tx,
        Number(session.charge_point_id),
        Number(session.connector_id),
      );
      if (
        !open ||
        open.source !== 'driver_report' ||
        !(new Date(session.received_started_at) > open.raisedAt) ||
        !this.sm.canApply(open.status, 'SESSION_COMPLETED')
      )
        return null;
      const step = this.sm.apply(open.status, 'SESSION_COMPLETED');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, open.id));
      await this.clearReports(tx, open.id, at, null);
      return open.id;
    });
    if (resolvedId === null) return 'none';
    this.logger.log(`sự cố #${resolvedId} resolved: phiên ${transactionNo} hoàn tất bình thường`);
    return 'resolved';
  }

  /** Báo cáo của tài xế gắn vào một sự cố (F-05: Operator thấy nội dung). */
  async reportsOf(faultId: number) {
    return this.db
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

  /** t2 raised → acknowledged. `operatorId` = operator_staff.user_id; null khi chưa có đăng nhập. */
  async acknowledge(faultId: number, operatorId: number | null, at: Date = new Date()) {
    return this.db.transaction(async (tx) => {
      const fault = await this.lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'ACKNOWLEDGE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, acknowledgedBy: operatorId, acknowledgedAt: at })
        .where(eq(faultEvents.id, faultId));
      return { id: faultId, status: step.to };
    });
  }

  /**
   * t4 acknowledged → resetting: ghi lệnh Reset (pending) và gắn vào sự cố, rồi hẹn giờ chờ.
   * Người gọi gửi CALL thật và báo kết quả bằng {@link markSent} + {@link onResetResult}.
   */
  async beginReset(
    faultId: number,
    opts: { type: ResetType; requestedBy: number | null; at?: Date; force?: boolean },
  ): Promise<BeginResetResult> {
    const at = opts.at ?? new Date();
    const result = await this.db.transaction(async (tx) => {
      const fault = await this.lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'RESET_SENT');
      const [cmd] = await tx
        .insert(remoteCommands)
        .values({
          chargePointId: fault.chargePointId,
          action: 'Reset',
          payload: opts.force ? { type: opts.type, force: true } : { type: opts.type },
          status: 'pending',
          requestedBy: opts.requestedBy,
          requestedAt: at,
        })
        .returning({ id: remoteCommands.id });
      if (!cmd) throw new Error('INSERT remote_commands không trả id');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resetCommandId: cmd.id })
        .where(eq(faultEvents.id, faultId));
      return { faultId, commandId: cmd.id, serial: fault.serial };
    });
    this.armTimer(result.faultId, result.commandId, this.resetTimeoutS * 1000);
    return result;
  }

  /** Lệnh sắp được gửi qua socket: pending → sent. */
  async markSent(commandId: number, at: Date = new Date()): Promise<void> {
    await this.db
      .update(remoteCommands)
      .set({ status: 'sent', sentAt: at })
      .where(and(eq(remoteCommands.id, commandId), eq(remoteCommands.status, 'pending')));
  }

  /**
   * Kết quả CALL Reset. Accepted: chỉ ghi lệnh — sự cố vẫn `resetting` chờ súng hoạt động lại hoặc
   * hết hạn. Rejected / lỗi gửi: ghi lệnh và t6 resetting → acknowledged.
   * Kết quả tới muộn của một lệnh không còn gắn với sự cố đang `resetting` thì chỉ ghi lệnh.
   */
  async onResetResult(
    commandId: number,
    outcome: ResetOutcome,
    at: Date = new Date(),
  ): Promise<{ faultId: number | null; faultStatus: FaultStatus | null }> {
    const failed = 'error' in outcome || outcome.status === 'Rejected';
    const res = await this.db.transaction(async (tx) => {
      const [cmd] = await tx
        .select({ status: remoteCommands.status, sentAt: remoteCommands.sentAt })
        .from(remoteCommands)
        .where(eq(remoteCommands.id, commandId))
        .for('update');
      if (!cmd) throw new Error(`Không có remote_commands id=${commandId}`);
      if ((IN_FLIGHT as readonly string[]).includes(cmd.status)) {
        const sentAt = cmd.sentAt ?? at;
        await tx
          .update(remoteCommands)
          .set(
            'error' in outcome
              ? { status: 'failed', sentAt, respondedAt: at, error: outcome.error }
              : {
                  status: outcome.status === 'Accepted' ? 'accepted' : 'rejected',
                  sentAt,
                  respondedAt: at,
                  response: outcome.response ?? { status: outcome.status },
                },
          )
          .where(eq(remoteCommands.id, commandId));
      }
      const [fault] = await tx
        .select({ id: faultEvents.id, status: faultEvents.status })
        .from(faultEvents)
        .where(eq(faultEvents.resetCommandId, commandId))
        .for('update');
      if (!fault) return { faultId: null, faultStatus: null, changed: false };
      if (!failed || fault.status !== 'resetting') {
        return { faultId: fault.id, faultStatus: fault.status, changed: false };
      }
      const step = this.sm.apply(fault.status, 'RESET_FAILED');
      await tx.update(faultEvents).set({ status: step.to }).where(eq(faultEvents.id, fault.id));
      return { faultId: fault.id, faultStatus: step.to, changed: true };
    });
    if (res.changed && res.faultId !== null) this.clearTimer(res.faultId);
    return { faultId: res.faultId, faultStatus: res.faultStatus };
  }

  /**
   * Hết hạn chờ Reset (t6). Chỉ áp khi sự cố còn `resetting` VỚI ĐÚNG lệnh này; lệnh chưa có kết
   * quả thì thành `timeout` (lệnh đã Accepted giữ nguyên — trụ nhận lệnh nhưng lỗi chưa hết).
   * Public để test và quét khởi động gọi thẳng.
   */
  async onResetTimeout(faultId: number, commandId: number): Promise<'timed_out' | 'noop'> {
    this.timers.delete(faultId);
    return this.db.transaction(async (tx) => {
      const [fault] = await tx
        .select({ status: faultEvents.status, resetCommandId: faultEvents.resetCommandId })
        .from(faultEvents)
        .where(eq(faultEvents.id, faultId))
        .for('update');
      if (!fault || fault.status !== 'resetting' || fault.resetCommandId !== commandId) {
        return 'noop';
      }
      const step = this.sm.apply(fault.status, 'RESET_FAILED');
      await tx.update(faultEvents).set({ status: step.to }).where(eq(faultEvents.id, faultId));
      await tx
        .update(remoteCommands)
        .set({ status: 'timeout', error: `Hết hạn chờ ${this.resetTimeoutS} s` })
        .where(
          and(
            eq(remoteCommands.id, commandId),
            sql`${remoteCommands.status} IN ('pending', 'sent')`,
          ),
        );
      this.logger.warn(`sự cố #${faultId}: Reset hết hạn chờ → acknowledged`);
      return 'timed_out';
    });
  }

  /** t7 acknowledged → resolved bằng OPERATOR_CLOSE (sau khi kiểm tra tại chỗ). */
  async close(faultId: number, operatorId: number | null, at: Date = new Date()) {
    const res = await this.db.transaction(async (tx) => {
      const fault = await this.lockFault(tx, faultId);
      const step = this.sm.apply(fault.status, 'OPERATOR_CLOSE');
      await tx
        .update(faultEvents)
        .set({ status: step.to, resolvedAt: at })
        .where(eq(faultEvents.id, faultId));
      await this.clearReports(tx, faultId, at, operatorId);
      return { id: faultId, status: step.to };
    });
    // fault_events chưa có cột "ai đóng" — chỉ vào log (ITERATION-1-WF04 câu hỏi mở).
    this.logger.log(`sự cố #${faultId} đóng bởi operator ${operatorId ?? 'console'}`);
    this.clearTimer(faultId);
    return res;
  }

  // ---------------------------------------------------------------------------------------------
  // Đọc
  // ---------------------------------------------------------------------------------------------

  /**
   * Danh sách cảnh báo: sự cố mở trước, nặng trước, mới trước — sắp XẾP TRONG SQL rồi mới LIMIT, để
   * 25 lỗi nhẹ mới hơn không đẩy một lỗi nghiêm trọng cũ ra khỏi trang (review #61).
   */
  async list(
    filter: FaultListFilter,
    limit: number,
    /** Only this Operator's charge points (BR-P16); omitted = all (dev console). */
    operatorId?: number,
    offset = 0,
  ): Promise<FaultListItem[]> {
    const rows = await this.db
      .select({
        id: faultEvents.id,
        eventNo: faultEvents.eventNo,
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
      .where(this.listWhere(filter, operatorId))
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
  async count(filter: FaultListFilter, operatorId?: number): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(faultEvents)
      .innerJoin(chargePoints, eq(chargePoints.id, faultEvents.chargePointId))
      .leftJoin(sites, eq(sites.id, chargePoints.siteId))
      .where(this.listWhere(filter, operatorId));
    return row?.n ?? 0;
  }

  private listWhere(filter: FaultListFilter, operatorId?: number) {
    return and(
      filter === 'open'
        ? ne(faultEvents.status, 'resolved')
        : filter === 'all'
          ? undefined
          : eq(faultEvents.status, filter),
      operatorId === undefined ? undefined : eq(sites.operatorId, operatorId),
    );
  }

  /**
   * Một sự cố (không khoá) — để người gọi kiểm trước khi gửi lệnh. With `operatorId`, a FaultEvent of
   * another Operator's charge point is "not found" (404, never 403: no hint that it exists).
   */
  async get(faultId: number, operatorId?: number) {
    const [row] = await this.db
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

  /** Trigger có áp được cho trạng thái hiện tại không (để trả 409 trước khi đụng tới trụ). */
  canApply(status: FaultStatus, trigger: FaultTrigger): boolean {
    return this.sm.canApply(status, trigger);
  }

  // ---------------------------------------------------------------------------------------------
  // Phục hồi sau khởi động
  // ---------------------------------------------------------------------------------------------

  /**
   * Hẹn giờ trong RAM đã mất: với mỗi sự cố `resetting`, mốc là `remote_commands.requested_at`
   * của lệnh đang chờ. Quá hạn → t6 ngay; chưa quá → hẹn giờ cho phần còn lại.
   */
  async recoverAfterRestart(
    now: Date = new Date(),
  ): Promise<{ timedOut: number; scheduled: number }> {
    const rows = await this.db
      .select({
        id: faultEvents.id,
        commandId: faultEvents.resetCommandId,
        requestedAt: remoteCommands.requestedAt,
      })
      .from(faultEvents)
      .leftJoin(remoteCommands, eq(remoteCommands.id, faultEvents.resetCommandId))
      .where(eq(faultEvents.status, 'resetting'));
    const summary = { timedOut: 0, scheduled: 0 };
    const timeoutMs = this.resetTimeoutS * 1000;
    for (const r of rows) {
      if (r.commandId === null) {
        // Dữ liệu trước migration 0008 / sửa tay: không biết lệnh nào → coi như hết hạn.
        await this.db
          .update(faultEvents)
          .set({ status: this.sm.apply('resetting', 'RESET_FAILED').to })
          .where(and(eq(faultEvents.id, r.id), eq(faultEvents.status, 'resetting')));
        summary.timedOut += 1;
        continue;
      }
      const elapsed = now.getTime() - (r.requestedAt ?? now).getTime();
      if (elapsed >= timeoutMs) {
        if ((await this.onResetTimeout(r.id, r.commandId)) === 'timed_out') {
          summary.timedOut += 1;
        }
      } else {
        this.armTimer(r.id, r.commandId, timeoutMs - elapsed);
        summary.scheduled += 1;
      }
    }
    return summary;
  }

  // ---------------------------------------------------------------------------------------------
  // Nội bộ
  // ---------------------------------------------------------------------------------------------

  private armTimer(faultId: number, commandId: number, delayMs: number): void {
    this.clearTimer(faultId);
    const task = this.scheduler.schedule(delayMs, () => {
      this.onResetTimeout(faultId, commandId).catch((err: unknown) =>
        this.logger.error(`hết hạn Reset sự cố #${faultId} lỗi: ${String(err)}`),
      );
    });
    this.timers.set(faultId, task);
  }

  private clearTimer(faultId: number): void {
    this.timers.get(faultId)?.cancel();
    this.timers.delete(faultId);
  }

  /** connectors.id; null cho connector 0 (cả trụ); undefined khi trụ không có súng số này. */
  private async resolveConnectorId(
    chargePointId: number,
    connectorNo: number,
  ): Promise<number | null | undefined> {
    if (connectorNo === 0) return null;
    const [row] = await this.db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(eq(connectors.chargePointId, chargePointId), eq(connectors.connectorNo, connectorNo)),
      );
    return row?.id;
  }

  private async findOpenForUpdate(
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
  private async lastResolvedAt(
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
  private async attachWaitingReports(
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

  /** BR-P42: sự cố đóng → xoá nhãn "reported issue" của các báo cáo gắn vào nó. */
  private async clearReports(
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

  private async lockFault(tx: DbExecutor, faultId: number) {
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
}

export { InvalidFaultTransitionError };
