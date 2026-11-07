/**
 * InboundContext — ngữ cảnh gateway gắn vào mỗi CALL chiều vào trước khi giao cho handler.
 *
 * Vì sao tồn tại: handler nghiệp vụ (SessionsService) cần biết frame này thuộc trụ nào, epoch
 * nào, CSMS nhận lúc nào (received_at — đồng hồ tin cậy, ADR-0009), đã được ghi log với id nào
 * (ADR-0005), và ReplayDetector phán là live hay phát lại. Gom vào một object để chữ ký handler
 * không phình.
 */
import type { ReplayVerdict } from '../reconciliation/replay-detector.js';

export interface InboundContext {
  /** serial_number của trụ (đuôi URL /ocpp/{serialNumber}). */
  identity: string;
  chargePointId: number;
  epoch: number;
  epochOpenedAt: Date;
  /** Đồng hồ CSMS lúc frame tới. */
  receivedAt: Date;
  /** Đồng hồ trụ trong payload (null nếu bản tin không có timestamp). */
  cpTimestamp: Date | null;
  messageId: string;
  /** id dòng ocpp_message_log đã ghi TRƯỚC khi handler chạy. */
  messageLogId: number;
  replay: ReplayVerdict;
}
