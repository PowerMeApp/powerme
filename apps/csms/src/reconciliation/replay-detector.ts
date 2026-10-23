/**
 * ReplayDetector — phân loại một bản tin là "live" hay "phát lại từ hàng đợi offline". Lớp thuần.
 *
 * Vì sao tồn tại: OCPP 1.6 không có cờ nào phân biệt hai loại bản tin này (EXP-01 hiện tượng 1;
 * 2.0.1 mới vá bằng `offline` + `seqNo`). CSMS phải tự suy ra từ hai mốc thời gian của ADR-0009:
 *   - luật chính:  cp_timestamp < epoch_opened_at   → bản tin sinh ra trước khi socket hiện tại mở
 *   - luật phụ:    received_at − cp_timestamp > REPLAY_SKEW_THRESHOLD_S (T13: 5 s; EXP-01 đo
 *                  live 0,0 s, phát lại 104–127 s)
 *
 * Gateway gọi `classify()` cho mỗi CALL chiều vào NGAY khi frame tới (chỉ cần epoch_opened_at
 * trong bộ nhớ của ConnectionRegistry, không đọc DB), kết quả đi theo InboundContext tới
 * SessionsService / ReconciliationService.
 *
 * Bản tin không có timestamp trong payload (Heartbeat, StatusNotification của SAP) không phân
 * loại được → coi là live (replayed = false, skewS = null). Đây là giới hạn đã biết.
 */

export type ReplayReason = 'before_epoch' | 'skew' | null;

export interface ReplayVerdict {
  replayed: boolean;
  reason: ReplayReason;
  /** received_at − cp_timestamp (giây, dương = trụ ghi sớm hơn lúc CSMS nhận); null nếu không có cp_timestamp. */
  skewS: number | null;
}

export interface ReplayInput {
  cpTimestamp: Date | null;
  receivedAt: Date;
  epochOpenedAt: Date;
}

export class ReplayDetector {
  constructor(readonly skewThresholdS: number) {
    if (!(skewThresholdS >= 0)) throw new Error('REPLAY_SKEW_THRESHOLD_S phải ≥ 0');
  }

  classify({ cpTimestamp, receivedAt, epochOpenedAt }: ReplayInput): ReplayVerdict {
    if (cpTimestamp === null) return { replayed: false, reason: null, skewS: null };
    const skewS = (receivedAt.getTime() - cpTimestamp.getTime()) / 1000;
    if (cpTimestamp.getTime() < epochOpenedAt.getTime()) {
      return { replayed: true, reason: 'before_epoch', skewS };
    }
    if (skewS > this.skewThresholdS) return { replayed: true, reason: 'skew', skewS };
    return { replayed: false, reason: null, skewS };
  }
}
