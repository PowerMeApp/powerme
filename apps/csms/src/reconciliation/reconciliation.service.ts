/**
 * ReconciliationService — engine đối soát (BE-07): so `meterStop − meterStart` với chuỗi
 * MeterValues và ghi `reconciliation_records`.
 *
 * Vì sao tồn tại: EXP-01 hiện tượng 3 — StopTransaction phát lại mang meterStop = 242 Wh trong
 * khi MeterValues live đã lên 1042 Wh. Nếu tin một trong hai số mà không so, hoá đơn lệch 4,3
 * lần. Engine này là chỗ CSMS phát hiện và đẩy phiên vào `review` cho operator (UC-OPS-05).
 *
 * Phần tính toán (`evaluateSeries`) là HÀM THUẦN để test không cần DB. Phần ghi DB chỉ INSERT
 * `reconciliation_records` (append-only như WF-03 mục 2: mỗi lần đối soát lại = bản ghi mới).
 * Service KHÔNG đổi `sessions.status` — đó là việc của SessionsService qua SessionStateMachine
 * (WF-03 mục 4: reconciliation sửa phiên qua SessionsService, không viết SQL vào sessions).
 *
 * Ánh xạ sang enum `reconciliation_record_type` (migration 0001 thêm `conflict`, `late_sample`):
 *   - consistent     → không ghi bản ghi (không có gì để operator xử lý)
 *   - gap_detected    → meter_gap (chỉ khi KHÔNG phải mẫu muộn), resolution bắt đầu "gap_detected"
 *   - conflict        → conflict (khi kích hoạt bởi StopTransaction), resolution bắt đầu "conflict"
 *   - đối soát lại do mẫu muộn → late_sample (dù kết luận là conflict hay gap_detected); kết luận
 *     nằm ở tiền tố resolution: "conflict (late_sample): …" / "gap_detected (late_sample): …"
 *   - bản tin phát lại chạm phiên → replay; StartTransaction/MeterValues trùng → duplicate;
 *     StopTransaction cho phiên đã dừng → orphan_stop; idTag lạ → unknown_id_tag (ADR-0012).
 * Trước 0001 conflict và mẫu muộn được lưu là meter_gap + tiền tố resolution; bản ghi cũ còn nguyên
 * trong DB và console vẫn đọc được (console.mappers.reconciliationKind).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { CONFIG, CsmsConfig } from '../config.js';
import { DB, Db, DbExecutor } from '../db/db.module.js';
import { creditTransactions, reconciliationRecords } from '../db/schema/index.js';
import type { ReplayVerdict } from './replay-detector.js';

export interface EnergySample {
  cpTimestamp: Date;
  wh: number;
}

export interface ReconciliationInput {
  meterStartWh: number;
  /** null khi StopTransaction mang meterStop không dùng được (ví dụ nhỏ hơn meterStart). */
  meterStopWh: number | null;
  cpStartedAt: Date;
  cpStoppedAt: Date | null;
  /** Chuỗi Energy.Active.Import.Register, bất kỳ thứ tự — hàm tự sắp theo cp_timestamp. */
  samples: EnergySample[];
  sampleIntervalS: number;
  gapFactor: number;
  energyToleranceWh: number;
}

export type ReconciliationOutcome = 'consistent' | 'gap_detected' | 'conflict';

export interface Gap {
  start: Date;
  end: Date;
}

export interface ReconciliationVerdict {
  outcome: ReconciliationOutcome;
  /** meterStop − meterStart. */
  energyWh: number | null;
  /** Mẫu cuối của chuỗi, làm tròn Wh (SAP gửi Wh thập phân; meterStop của nó = round). */
  seriesLastWh: number | null;
  /** seriesLast − meterStop: dương = chuỗi đo vượt meterStop (EXP-01: 1043 − 242 = 801). */
  energyDifferenceWh: number | null;
  monotonic: boolean;
  gaps: Gap[];
  sampleCount: number;
}

/**
 * Đối soát thuần. Luật, theo thứ tự ưu tiên:
 *   conflict      — chuỗi không đơn điệu, hoặc meterStop < mẫu cuối − dung sai (đồng hồ "lùi"),
 *                   hoặc không có meterStop dùng được
 *   gap_detected  — có khoảng cách > gapFactor × sampleInterval giữa hai mẫu liên tiếp, giữa
 *                   cp_started_at và mẫu đầu, hoặc giữa mẫu cuối và cp_stopped_at
 *   consistent    — còn lại (meterStop ≥ mẫu cuối là bình thường: mẫu cuối đi trước lúc dừng
 *                   tối đa một chu kỳ)
 */
export function evaluateSeries(input: ReconciliationInput): ReconciliationVerdict {
  const samples = [...input.samples].sort(
    (a, b) => a.cpTimestamp.getTime() - b.cpTimestamp.getTime(),
  );
  const last = samples[samples.length - 1];
  const seriesLastWh = last ? Math.round(last.wh) : null;
  const energyWh = input.meterStopWh === null ? null : input.meterStopWh - input.meterStartWh;
  const energyDifferenceWh =
    seriesLastWh === null || input.meterStopWh === null ? null : seriesLastWh - input.meterStopWh;

  let monotonic = true;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev && cur && cur.wh < prev.wh) monotonic = false;
  }

  const gapMs = input.gapFactor * input.sampleIntervalS * 1000;
  const gaps: Gap[] = [];
  const points: Date[] = [input.cpStartedAt, ...samples.map((s) => s.cpTimestamp)];
  if (input.cpStoppedAt && (!last || input.cpStoppedAt.getTime() > last.cpTimestamp.getTime())) {
    points.push(input.cpStoppedAt);
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b && b.getTime() - a.getTime() > gapMs) gaps.push({ start: a, end: b });
  }

  let outcome: ReconciliationOutcome = 'consistent';
  if (
    input.meterStopWh === null ||
    !monotonic ||
    (seriesLastWh !== null && input.meterStopWh < seriesLastWh - input.energyToleranceWh)
  ) {
    outcome = 'conflict';
  } else if (gaps.length > 0) {
    outcome = 'gap_detected';
  }

  return {
    outcome,
    energyWh,
    seriesLastWh,
    energyDifferenceWh,
    monotonic,
    gaps,
    sampleCount: samples.length,
  };
}

/** Nguồn kích hoạt một lần đối soát — ghi vào resolution để đọc lại được. */
export interface ReconcileTrigger {
  kind: 'stop' | 'late_sample';
  replayed: boolean;
}

export interface FrameRef {
  action: string;
  cpTimestamp: Date | null;
  receivedAt: Date;
  messageLogId: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: CsmsConfig,
  ) {}

  /** Đối soát với tham số cấu hình (ngưỡng lỗ hổng, dung sai) — bọc evaluateSeries. */
  evaluate(
    input: Omit<ReconciliationInput, 'sampleIntervalS' | 'gapFactor' | 'energyToleranceWh'>,
  ): ReconciliationVerdict {
    return evaluateSeries({
      ...input,
      sampleIntervalS: this.config.meterValueSampleIntervalS,
      gapFactor: this.config.reconcileGapFactor,
      energyToleranceWh: this.config.reconcileEnergyToleranceWh,
    });
  }

  /**
   * Ghi kết quả đối soát. consistent → không ghi. Với late_sample, chỉ ghi khi kết luận khác
   * bản ghi đối soát (meter_gap / conflict / late_sample) gần nhất (tránh 6 bản ghi giống hệt
   * cho 6 mẫu muộn giống nhau).
   * Trả id bản ghi hoặc null.
   */
  async recordVerdict(
    ex: DbExecutor,
    sessionId: number,
    verdict: ReconciliationVerdict,
    trigger: ReconcileTrigger,
  ): Promise<number | null> {
    if (verdict.outcome === 'consistent') return null;
    const firstGap = verdict.gaps[0] ?? null;
    if (trigger.kind === 'late_sample') {
      const prev = await this.lastVerdictRecord(ex, sessionId);
      if (
        prev &&
        prev.energyDifferenceWh === verdict.energyDifferenceWh &&
        prev.gapStart?.getTime() === firstGap?.start.getTime() &&
        prev.gapEnd?.getTime() === firstGap?.end.getTime() &&
        prev.resolution?.startsWith(verdict.outcome) === true
      ) {
        return null;
      }
    }
    const resolution =
      `${verdict.outcome}${trigger.kind === 'late_sample' ? ' (late_sample)' : ''}: ` +
      `meter_stop_minus_start=${verdict.energyWh ?? 'null'} series_last=${verdict.seriesLastWh ?? 'null'} ` +
      `diff=${verdict.energyDifferenceWh ?? 'null'} samples=${verdict.sampleCount} ` +
      `monotonic=${verdict.monotonic} gaps=${verdict.gaps.length} trigger=${trigger.kind} replayed=${trigger.replayed}`;
    const recordType =
      trigger.kind === 'late_sample'
        ? 'late_sample'
        : verdict.outcome === 'conflict'
          ? 'conflict'
          : 'meter_gap';
    return this.insert(ex, sessionId, {
      recordType,
      gapStart: firstGap?.start ?? null,
      gapEnd: firstGap?.end ?? null,
      energyDifferenceWh: verdict.energyDifferenceWh,
      resolution,
    });
  }

  /** Bản tin bị ReplayDetector phán là phát lại đã chạm vào phiên này. */
  async recordReplay(
    ex: DbExecutor,
    sessionId: number,
    frame: FrameRef,
    verdict: ReplayVerdict,
  ): Promise<number> {
    return this.insert(ex, sessionId, {
      recordType: 'replay',
      gapStart: frame.cpTimestamp,
      gapEnd: frame.receivedAt,
      energyDifferenceWh: null,
      resolution:
        `replay: action=${frame.action} reason=${verdict.reason ?? 'null'} ` +
        `skew_s=${verdict.skewS ?? 'null'} message_log_id=${frame.messageLogId}`,
    });
  }

  /** StartTransaction trùng khoá tự nhiên (ADR-0010) hoặc MeterValues trùng (session, cp_timestamp, measurand). */
  async recordDuplicate(ex: DbExecutor, sessionId: number, frame: FrameRef): Promise<number> {
    return this.insert(ex, sessionId, {
      recordType: 'duplicate',
      gapStart: frame.cpTimestamp,
      gapEnd: frame.receivedAt,
      energyDifferenceWh: null,
      resolution: `duplicate: action=${frame.action} message_log_id=${frame.messageLogId}`,
    });
  }

  /** StopTransaction tới cho phiên đã có meter_stop hoặc đã kết thúc. */
  async recordOrphanStop(ex: DbExecutor, sessionId: number, frame: FrameRef): Promise<number> {
    return this.insert(ex, sessionId, {
      recordType: 'orphan_stop',
      gapStart: frame.cpTimestamp,
      gapEnd: frame.receivedAt,
      energyDifferenceWh: null,
      resolution: `orphan_stop: action=${frame.action} message_log_id=${frame.messageLogId}`,
    });
  }

  /**
   * idTag không có trong rfid_cards (ADR-0012 quyết định 5), hoặc — BM02 F22 — thẻ có trong sổ
   * nhưng không `active` (`cardStatus` = blocked / unlinked) mà phiên vẫn đã diễn ra. Enum
   * record_type chưa có loại riêng cho trường hợp sau; phân biệt bằng `card_status=` trong
   * resolution (cùng cách 0000 từng dùng tiền tố resolution cho conflict).
   */
  async recordUnknownIdTag(
    ex: DbExecutor,
    sessionId: number,
    idTag: string,
    cardStatus?: string,
  ): Promise<number> {
    return this.insert(ex, sessionId, {
      recordType: 'unknown_id_tag',
      gapStart: null,
      gapEnd: null,
      energyDifferenceWh: null,
      resolution:
        `unknown_id_tag: id_tag=${idTag}` +
        (cardStatus ? ` card_status=${cardStatus} (the co trong so, khong Accepted)` : ''),
    });
  }

  /** Guard của T13 #19: đã có dòng session_debit thì không đổi trạng thái, chỉ ghi record. */
  async hasSessionDebit(ex: DbExecutor, sessionId: number): Promise<boolean> {
    const rows = await ex
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.sessionId, sessionId),
          eq(creditTransactions.transactionType, 'session_debit'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Bản ghi kết luận đối soát gần nhất của phiên (kể cả bản ghi cũ meter_gap + tiền tố). */
  private async lastVerdictRecord(ex: DbExecutor, sessionId: number) {
    const rows = await ex
      .select({
        gapStart: reconciliationRecords.gapStart,
        gapEnd: reconciliationRecords.gapEnd,
        energyDifferenceWh: reconciliationRecords.energyDifferenceWh,
        resolution: reconciliationRecords.resolution,
      })
      .from(reconciliationRecords)
      .where(
        and(
          eq(reconciliationRecords.sessionId, sessionId),
          inArray(reconciliationRecords.recordType, ['meter_gap', 'conflict', 'late_sample']),
        ),
      )
      .orderBy(desc(reconciliationRecords.recordNo))
      .limit(1);
    return rows[0] ?? null;
  }

  private async insert(
    ex: DbExecutor,
    sessionId: number,
    row: {
      recordType: (typeof reconciliationRecords.$inferInsert)['recordType'];
      gapStart: Date | null;
      gapEnd: Date | null;
      energyDifferenceWh: number | null;
      resolution: string;
    },
  ): Promise<number> {
    const [agg] = await ex
      .select({ max: sql<number>`coalesce(max(${reconciliationRecords.recordNo}), 0)` })
      .from(reconciliationRecords)
      .where(eq(reconciliationRecords.sessionId, sessionId));
    const recordNo = Number(agg?.max ?? 0) + 1;
    const [inserted] = await ex
      .insert(reconciliationRecords)
      .values({ sessionId, recordNo, ...row })
      .returning({ id: reconciliationRecords.id });
    if (!inserted) throw new Error('INSERT reconciliation_records không trả về id');
    this.logger.log(
      `session ${sessionId} record #${recordNo} ${row.recordType}: ${row.resolution}`,
    );
    return inserted.id;
  }
}
