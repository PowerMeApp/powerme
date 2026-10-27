/**
 * Bảng ChargePointErrorCode (OCPP 1.6 mục 7.6) → mức độ + gợi ý xử lý — cùng nội dung với
 * apps/csms/src/stations/faults/error-code-guide.ts (FE-04). Bốn mã `pendingWp1` chờ hướng xử lý
 * chính thức trong SRS phần cứng (WF-04 câu hỏi mở 1).
 */
import type { FaultSeverity } from '../../types/domain';

export interface ErrorCodeEntry {
  severity: FaultSeverity;
  hint: string;
  pendingWp1?: true;
}

export const ERROR_CODE_GUIDE: Readonly<Record<string, ErrorCodeEntry>> = {
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
    hint: 'Danh sách thẻ nội bộ của trụ lệch với CSMS: đồng bộ lại, không cần ra hiện trường.',
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
  UnderVoltage: { severity: 'major', hint: 'Thấp áp nguồn vào: kiểm tra lưới điện của trạm.' },
  WeakSignal: {
    severity: 'minor',
    hint: 'Sóng yếu: kiểm tra anten/SIM 4G; trụ có thể rớt kết nối thường xuyên.',
  },
};

export function guideFor(code: string | null | undefined): ErrorCodeEntry {
  return (code && ERROR_CODE_GUIDE[code]) || (ERROR_CODE_GUIDE['OtherError'] as ErrorCodeEntry);
}

const RANK: Record<FaultSeverity, number> = { critical: 0, major: 1, minor: 2, none: 3 };

export function compareSeverity(a: FaultSeverity, b: FaultSeverity): number {
  return RANK[a] - RANK[b];
}

export const SEVERITY_LABEL: Record<FaultSeverity, string> = {
  critical: 'Nghiêm trọng',
  major: 'Cao',
  minor: 'Thấp',
  none: '—',
};
