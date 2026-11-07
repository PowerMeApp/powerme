/**
 * ReplayDetector — phân loại một bản tin là "live" hay "phát lại từ hàng đợi offline". Lớp thuần.
 *
 * Vì sao tồn tại: OCPP 1.6 không có cờ nào phân biệt hai loại bản tin này (EXP-01 hiện tượng 1;
 * 2.0.1 mới vá bằng `offline` + `seqNo`). CSMS phải tự suy ra từ hai mốc thời gian của ADR-0009:
 *   - luật chính:  epoch_opened_at − cp_timestamp > REPLAY_SKEW_THRESHOLD_S
 *                  → bản tin sinh ra TRƯỚC khi socket hiện tại mở, quá dung sai.
 *                  Dung sai chống cờ giả: trụ tạo StatusNotification vài trăm ms trước khi socket mở
 *                  rồi gửi ngay là tin LIVE, không phải phát lại (Known Gap G9: demo 25/10 gắn nhầm
 *                  3–4 tin; EXP-01 không lộ vì SAP không gắn timestamp cho tin trạng thái).
 *                  Lưu ý thiết kế: tin chỉ tới được SAU khi socket mở nên skew ≥ lead; với dung sai
 *                  bằng ngưỡng skew thì mọi ca before_epoch đều cũng thoả luật skew — `before_epoch`
 *                  giữ vai trò NHÃN lý do (và ưu tiên hơn `skew` khi cả hai đúng), không bắt thêm ca.
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
    const leadS = (epochOpenedAt.getTime() - cpTimestamp.getTime()) / 1000;
    if (leadS > this.skewThresholdS) {
      return { replayed: true, reason: 'before_epoch', skewS };
    }
    if (skewS > this.skewThresholdS) return { replayed: true, reason: 'skew', skewS };
    return { replayed: false, reason: null, skewS };
  }
}
