// model.mjs — hằng số và hàm thuần của trụ D1 (không có trạng thái, không I/O).
//
// LÀM GÌ: danh sách 9 trạng thái connector OCPP 1.6 (STM-2, docs/XAC-NHAN-STATE-MACHINE-T13.md),
//   errorCode cho phép "gây lỗi", thẻ mẫu GIẢ, thông số điện, đường công suất theo SoC và hàm
//   rút gọn payload cho nhật ký OCPP trên HMI.
// VÌ SAO TÁCH: station.mjs giữ trạng thái + mạng; file này đọc một lượt là hiểu số liệu.
// GIẢ ĐỊNH: pin 75 kWh; đường công suất giữ 100 % tới SoC 80 % rồi giảm tuyến tính còn 5 % ở
//   100 % (hình dạng thường gặp của sạc DC, KHÔNG phải số đo của Ruihua).

export const OCPP_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
];
export const ERROR_CODES = [
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'UnderVoltage',
];
// Thẻ mẫu GIẢ. "valid"/"wallet" phải được seed ở CSMS thì mới Accepted; "unknown" thì không.
export const CARDS = {
  valid: 'DEMO-CARD-0001',
  wallet: 'DEMO-WALLET-0001',
  unknown: 'DEMO-UNKNOWN-999',
};
export const FREE_VEND_TAG = 'HMI-FREEVEND';
export const BATTERY_KWH = 75;
export const STATION_KW = 120;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const taper = (soc) => (soc <= 80 ? 1 : Math.max(0.05, 1 - ((soc - 80) / 20) * 0.95));

export function summarize(action, p) {
  if (!p) return '';
  if (action === 'MeterValues') {
    const sv = Object.fromEntries(
      (p.meterValue?.[0]?.sampledValue ?? []).map((s) => [s.measurand, s.value]),
    );
    return `c${p.connectorId} tx=${p.transactionId} E=${sv['Energy.Active.Import.Register']}Wh SoC=${sv.SoC}% P=${sv['Power.Active.Import']}W`;
  }
  const s = JSON.stringify(p);
  return s.length > 150 ? s.slice(0, 147) + '...' : s;
}
