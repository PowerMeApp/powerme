/**
 * ErrorCodeGuide — bảng tĩnh ChargePointErrorCode (OCPP 1.6 mục 7.6) → mức độ + gợi ý xử lý cho
 * operator (FE-04 "trung tâm cảnh báo", UC-OPS-03).
 *
 * Vì sao tồn tại: cảnh báo chỉ có `error_code` nguyên văn của trụ; operator cần biết mã đó nặng
 * tới đâu và nên làm gì trước khi ra hiện trường. Dữ liệu tĩnh (không DB) để test được và để
 * dashboard dùng lại. `NoError` không phải lỗi — không tạo cảnh báo từ mã này.
 *
 * Nội dung gợi ý là bản Iteration 1 theo mô tả mã trong OCPP 1.6. Bốn mã mà SRS phần cứng của
 * Ruihua ghi riêng (WF-04 câu hỏi mở 1) có `pendingWp1 = true`: chờ WP1 gửi hướng xử lý chính thức.
 * Severity chỉ dùng để sắp xếp danh sách cảnh báo — không tự `disabled` trụ (WF-04 câu hỏi 11).
 */

export const CHARGE_POINT_ERROR_CODES = [
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'WeakSignal',
] as const;
export type ChargePointErrorCode = (typeof CHARGE_POINT_ERROR_CODES)[number];

export type FaultSeverity = 'critical' | 'major' | 'minor' | 'none';

export interface ErrorCodeEntry {
  severity: FaultSeverity;
  /** Gợi ý ngắn cho operator, hiển thị cạnh cảnh báo. */
  hint: string;
  /** Có hướng xử lý riêng trong SRS phần cứng, chờ WP1 chốt nội dung. */
  pendingWp1?: true;
}

export const ERROR_CODE_GUIDE: Readonly<Record<ChargePointErrorCode, ErrorCodeEntry>> = {
  ConnectorLockFailure: {
    severity: 'major',
    hint: 'Khoá súng không khớp: thử Reset; nếu lặp lại, kiểm tra cơ cấu khoá tại trụ.',
  },
  EVCommunicationError: {
    severity: 'minor',
    hint: 'Mất giao tiếp với xe: thường do xe/cáp. Nhờ tài xế cắm lại; lặp nhiều xe thì kiểm tra súng.',
  },
  GroundFailure: {
    severity: 'critical',
    hint: 'Lỗi chạm đất: KHÔNG Reset từ xa nhiều lần. Ngắt trụ và cử kỹ thuật kiểm tra cách điện.',
    pendingWp1: true,
  },
  HighTemperature: {
    severity: 'major',
    hint: 'Quá nhiệt: chờ trụ nguội rồi Reset; kiểm tra quạt, lọc gió nếu lặp lại.',
    pendingWp1: true,
  },
  InternalError: {
    severity: 'major',
    hint: 'Lỗi phần mềm trụ: Reset từ xa (Soft trước, Hard sau).',
  },
  LocalListConflict: {
    severity: 'minor',
    hint: 'Danh sách thẻ nội bộ của trụ lệch với CSMS: đồng bộ lại danh sách, không cần ra hiện trường.',
  },
  NoError: { severity: 'none', hint: 'Không có lỗi.' },
  OtherError: {
    severity: 'minor',
    hint: 'Lỗi khác: xem vendorErrorCode / info trong nhật ký bản tin OCPP.',
  },
  OverCurrentFailure: {
    severity: 'critical',
    hint: 'Quá dòng: không Reset lặp lại; kiểm tra súng, cáp và mạch công suất.',
    pendingWp1: true,
  },
  OverVoltage: {
    severity: 'major',
    hint: 'Quá áp nguồn vào: kiểm tra lưới điện của trạm trước khi Reset.',
  },
  PowerMeterFailure: {
    severity: 'major',
    hint: 'Công tơ lỗi: số đo có thể sai — kiểm tra đối soát các phiên gần nhất.',
    pendingWp1: true,
  },
  PowerSwitchFailure: {
    severity: 'critical',
    hint: 'Lỗi khởi động từ/contactor: cử kỹ thuật kiểm tra, không Reset lặp lại.',
  },
  ReaderFailure: {
    severity: 'minor',
    hint: 'Đầu đọc RFID lỗi: vẫn sạc được qua app (QR); cử kỹ thuật thay đầu đọc.',
  },
  ResetFailure: {
    severity: 'major',
    hint: 'Trụ không Reset được: thử Hard Reset; không được thì ra hiện trường.',
  },
  UnderVoltage: {
    severity: 'major',
    hint: 'Thấp áp nguồn vào: kiểm tra lưới điện của trạm.',
  },
  WeakSignal: {
    severity: 'minor',
    hint: 'Sóng yếu: kiểm tra anten/SIM 4G; trụ có thể rớt kết nối thường xuyên.',
  },
};

const SEVERITY_RANK: Record<FaultSeverity, number> = { critical: 0, major: 1, minor: 2, none: 3 };

export function isChargePointErrorCode(
  code: string | null | undefined,
): code is ChargePointErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_CODE_GUIDE, code);
}

/** Mục của mã; mã lạ (vendor tự đặt) hoặc thiếu → coi như OtherError. */
export function guideFor(code: string | null | undefined): ErrorCodeEntry {
  return isChargePointErrorCode(code) ? ERROR_CODE_GUIDE[code] : ERROR_CODE_GUIDE.OtherError;
}

/** Hạng để sắp xếp: 0 = critical … 3 = none (FaultService dựng CASE trong SQL từ hàm này). */
export function severityRank(severity: FaultSeverity): number {
  return SEVERITY_RANK[severity];
}

/** So sánh để sắp xếp cảnh báo: nặng trước. */
export function compareSeverity(a: FaultSeverity, b: FaultSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}
