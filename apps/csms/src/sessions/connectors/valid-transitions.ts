/**
 * Bảng chuyển trạng thái connector hợp lệ theo OCPP 1.6 — dùng để GẮN CỜ, không để từ chối.
 *
 * Vì sao tồn tại: T13 mục 2.1 — CSMS phản chiếu StatusNotification (trụ là nguồn sự thật vật
 * lý). Chuyển không có trong bảng vẫn được ghi vào `connector_status_events`, chỉ thêm cờ
 * `unexpected_transition = true` để dashboard/operator thấy.
 *
 * Nguồn: dựng lại theo hiểu biết về bảng "Connector status transitions" (mục 4.9
 * StatusNotification, OCPP 1.6 edition 2, các ô A2…I8). CẦN ĐỐI CHIẾU LẠI VỚI SPEC trước khi
 * dùng bảng này làm căn cứ báo cáo; file này không chép spec (schema OCA là CC BY-ND).
 *
 * Quy ước thêm của PowerMe: cùng trạng thái (Available → Available, ví dụ trụ gửi lại sau
 * reboot) KHÔNG coi là bất thường; trạng thái trước chưa biết (null) cũng không.
 */

export const CONNECTOR_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** from → danh sách `to` hợp lệ. */
export const VALID_CONNECTOR_TRANSITIONS: Readonly<
  Record<ConnectorStatus, readonly ConnectorStatus[]>
> = {
  // A2 A3 A4 A5 A7 A8 A9
  Available: [
    'Preparing',
    'Charging',
    'SuspendedEVSE',
    'SuspendedEV',
    'Reserved',
    'Unavailable',
    'Faulted',
  ],
  // B1 B3 B4 B5 B6 B9
  Preparing: ['Available', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Faulted'],
  // C1 C4 C5 C6 C8 C9
  Charging: ['Available', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Unavailable', 'Faulted'],
  // D1 D3 D5 D6 D8 D9
  SuspendedEV: ['Available', 'Charging', 'SuspendedEVSE', 'Finishing', 'Unavailable', 'Faulted'],
  // E1 E3 E4 E6 E8 E9
  SuspendedEVSE: ['Available', 'Charging', 'SuspendedEV', 'Finishing', 'Unavailable', 'Faulted'],
  // F1 F2 F8 F9
  Finishing: ['Available', 'Preparing', 'Unavailable', 'Faulted'],
  // G1 G2 G8 G9
  Reserved: ['Available', 'Preparing', 'Unavailable', 'Faulted'],
  // H1 H2 H3 H4 H5 H9 (H1 là "StatusNotification(Available) đầu tiên sau boot" — T13 2.3 #1;
  // H1 cũng là ChangeAvailability(Operative) — T13 2.3 #2a)
  Unavailable: ['Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Faulted'],
  // I1…I8 — trụ thoát lỗi về bất kỳ trạng thái nào (T13 2.3 #14: Faulted → Unavailable hợp lệ)
  Faulted: [
    'Available',
    'Preparing',
    'Charging',
    'SuspendedEV',
    'SuspendedEVSE',
    'Finishing',
    'Reserved',
    'Unavailable',
  ],
};

export function isConnectorStatus(value: string): value is ConnectorStatus {
  return (CONNECTOR_STATUSES as readonly string[]).includes(value);
}

/** true = chuyển hợp lệ (hoặc không có cơ sở để coi là bất thường). */
export function isExpectedTransition(from: ConnectorStatus | null, to: ConnectorStatus): boolean {
  if (from === null || from === to) return true;
  return VALID_CONNECTOR_TRANSITIONS[from].includes(to);
}
