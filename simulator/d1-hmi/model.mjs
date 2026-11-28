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
// Thẻ mẫu GIẢ. "valid"/"valid2" phải được seed ở CSMS thì mới Accepted; "unknown" thì không.
// "valid2" (thẻ online của tài xế mẫu 2) thay thẻ ví DEMO-WALLET-0001 đã bỏ ở T110.
export const CARDS = {
  valid: 'DEMO-CARD-0001',
  valid2: 'DEMO-CARD-0002',
  unknown: 'DEMO-UNKNOWN-999',
};
export const FREE_VEND_TAG = 'HMI-FREEVEND';
export const BATTERY_KWH = 75;
export const STATION_KW = 120;

/**
 * QA-11 — cấu hình phần cứng của một trụ, khớp `charge_points` / `connectors` ở CSMS (seed-app.sql):
 *   "dc120:120/60" = trụ DC 120 kW, súng 1 tối đa 120 kW, súng 2 tối đa 60 kW
 *   "ac22:22"      = trụ AC 22 kW, một súng 22 kW
 * Trống → trụ D1 gốc: DC 120 kW, hai súng chia đều, không trần riêng (hành vi trước QA-11).
 * Trụ AC không biết SoC của xe nên KHÔNG gửi measurand SoC (charge_points.reports_soc = false).
 */
export function parseSpec(raw) {
  const text = String(raw ?? '').trim();
  if (!text)
    return {
      kind: 'dc',
      ratedKw: STATION_KW,
      model: 'D1-120',
      reportsSoc: true,
      guns: [
        { id: 1, maxKw: Infinity },
        { id: 2, maxKw: Infinity },
      ],
    };
  const m =
    /^(ac|dc)(\d{1,4}(?:\.\d{1,2})?):(\d{1,4}(?:\.\d{1,2})?)(?:\/(\d{1,4}(?:\.\d{1,2})?))?$/i.exec(
      text,
    );
  if (!m) throw new Error(`cấu hình trụ không hợp lệ: "${text}" (vd. dc120:120/60, ac22:22)`);
  const kind = m[1].toLowerCase();
  const ratedKw = Number(m[2]);
  const guns = [m[3], m[4]]
    .filter((v) => v !== undefined)
    .map((v, i) => ({ id: i + 1, maxKw: Number(v) }));
  if (!(ratedKw > 0) || guns.some((g) => !(g.maxKw > 0)))
    throw new Error(`công suất phải > 0: "${text}"`);
  return {
    kind,
    ratedKw,
    model: `${kind.toUpperCase()}-${m[2]}`,
    reportsSoc: kind === 'dc',
    guns,
  };
}
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
