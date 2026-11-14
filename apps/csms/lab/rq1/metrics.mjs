/**
 * Phân loại phiên và thống kê cho RQ1 / NFR-02 — HÀM THUẦN, không I/O.
 *
 * Định nghĩa lấy NGUYÊN từ docs/NFR-02-CHI-SO-DOI-SOAT.md (đã chốt 12/11/2026), không đổi ở đây:
 *   - tol = 1 Wh; "dữ liệu trụ sai" khi |E_stop − E_true| > tol
 *   - 5 nhóm (mục 3); chỉ số chính = (tính tiền đúng + giữ lại đúng) ÷ tổng, kèm CI Wilson 95%
 *   - precision / recall của việc giữ phiên lại (mục 4)
 *   - các số đo SRS NFR-REC-01: sai số Wh (trung bình + CI), trùng/mất, precision/recall phát
 *     hiện khe hở theo bản ghi `meter_gap`
 *
 * Hai chỗ tài liệu không nói, harness chọn TỐI THIỂU và ghi rõ (README mục "Chỗ phải đoán"):
 *   - phiên có trong hệ thống nhưng không tính tiền cũng không ở `review` (kẹt `orphaned`,
 *     `active`…, hoặc SteVe chưa có stop) → nhóm `unresolved`, tính là SAI;
 *   - lần chạy mà trụ giả lỗi giữa chừng → nhóm `harness_error`, vẫn nằm trong mẫu số và tính SAI.
 */

export const TOL_WH = 1;

/** Mã nhóm (ASCII, dùng trong CSV) → tên trong NFR-02 mục 3. */
export const CLASS_LABELS = {
  billed_correct: 'Tính tiền đúng',
  held_correct: 'Giữ lại đúng',
  held_unnecessary: 'Giữ lại thừa',
  billed_wrong_silent: 'Tính tiền sai im lặng',
  lost_or_duplicate: 'Mất / trùng',
  unresolved: 'Chưa kết thúc (ngoài 5 nhóm)',
  harness_error: 'Lỗi harness (ngoài 5 nhóm)',
};
export const CLASSES = Object.keys(CLASS_LABELS);
export const CORRECT_CLASSES = ['billed_correct', 'held_correct'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Dữ liệu trụ sai? (NFR-02 mục 2). Không có E_stop (trụ chưa gửi StopTransaction) → không xác định. */
export function stationDataWrong(eTrue, eStop, tol = TOL_WH) {
  if (!isNum(eTrue) || !isNum(eStop)) return null;
  return Math.abs(eStop - eTrue) > tol;
}

/**
 * Phân loại một lần chạy (= một phiên theo sự thật nền).
 * @param run.eTrue   Wh, bộ đếm nội bộ của trụ giả
 * @param run.eStop   Wh, meterStop − meterStart trụ đã gửi (null nếu chưa gửi)
 * @param run.sessions các phiên hệ thống ghi cho lần chạy này; mỗi phiên có
 *                    `outcome`: 'billed' | 'held' | 'open' và `eBill` (Wh hoặc null)
 * @param run.error   lỗi của trụ giả (chuỗi) nếu có
 */
export function classifyRun({ eTrue, eStop, sessions, error = null }, tol = TOL_WH) {
  const wrong = stationDataWrong(eTrue, eStop, tol);
  const base = { stationDataWrong: wrong, subtype: null };
  if (error) return { ...base, class: 'harness_error', subtype: 'station_error' };
  if (!sessions || sessions.length === 0) {
    return { ...base, class: 'lost_or_duplicate', subtype: 'lost' };
  }
  if (sessions.length > 1) return { ...base, class: 'lost_or_duplicate', subtype: 'duplicate' };
  const s = sessions[0];
  if (s.outcome === 'held') {
    // Giữ lại chỉ "đúng" khi dữ liệu trụ THẬT SỰ sai (NFR-02 mục 1). Không xác định → coi là thừa.
    return { ...base, class: wrong === true ? 'held_correct' : 'held_unnecessary' };
  }
  if (s.outcome === 'billed' && isNum(s.eBill) && isNum(eTrue)) {
    return {
      ...base,
      class: Math.abs(s.eBill - eTrue) <= tol ? 'billed_correct' : 'billed_wrong_silent',
    };
  }
  return { ...base, class: 'unresolved' };
}

/** z của khoảng tin cậy hai phía 95%. */
export const Z95 = 1.959963984540054;

/**
 * Khoảng tin cậy Wilson cho tỉ lệ k/n. n = 0 → null (không có gì để ước lượng).
 * Công thức: (p + z²/2n ± z·sqrt(p(1−p)/n + z²/4n²)) / (1 + z²/n).
 */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`wilson: k=${k}, n=${n} không hợp lệ`);
  }
  if (n === 0) return { p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Kẹp sai số dấu phẩy động ở hai ca biên (0/n phải cho lo = 0, n/n phải cho hi = 1).
  return {
    p,
    lo: k === 0 ? 0 : Math.max(0, centre - half),
    hi: k === n ? 1 : Math.min(1, centre + half),
  };
}

// t(0,975; df) cho df = 1…30; df lớn hơn dùng xấp xỉ chuẩn 1,96.
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
export function tCritical95(df) {
  if (df < 1) return null;
  return df <= 30 ? T975[df - 1] : Z95;
}

/** Trung bình và CI 95% (phân phối t) của một dãy số. n = 0 → null; n = 1 → không có CI. */
export function meanCi(values) {
  const n = values.length;
  if (n === 0) return { n, mean: null, lo: null, hi: null, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, lo: null, hi: null, sd: null };
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = (tCritical95(n - 1) * sd) / Math.sqrt(n);
  return { n, mean, lo: mean - half, hi: mean + half, sd };
}

const ratio = (num, den) => (den === 0 ? null : num / den);

/**
 * Tổng hợp một nhóm dòng (cùng cấu hình, cùng kịch bản — hoặc gộp cả cấu hình).
 * Mỗi dòng cần: class, class_subtype, station_data_wrong, E_true, E_bill, gap_true, meter_gap_records.
 */
export function summarize(rows) {
  const n = rows.length;
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const correct = CORRECT_CLASSES.reduce((a, c) => a + counts[c], 0);
  const w = wilson(correct, n);

  // Giữ lại = bộ phát hiện "dữ liệu trụ sai" (NFR-02 mục 4).
  const held = counts.held_correct + counts.held_unnecessary;
  const wrongData = rows.filter((r) => r.station_data_wrong === true).length;

  // Sai số Wh trên các phiên ĐÃ tính tiền (phiên bị giữ không có E_bill).
  const billed = rows.filter((r) => isNum(r.E_bill) && isNum(r.E_true));
  const absErr = meanCi(billed.map((r) => Math.abs(r.E_bill - r.E_true)));
  const signedErr = meanCi(billed.map((r) => r.E_bill - r.E_true));

  // Phát hiện khe hở (SRS NFR-REC-01). Từ T132 một phiên "bị báo khe hở" khi còn bản ghi khe hở
  // CHƯA được đóng (`open_gap_records`); dữ liệu trước T132 không có cột này thì dùng số bản ghi
  // meter_gap thô như cũ. Số thô và số phiên có bản ghi đóng vẫn được báo riêng.
  let gapTp = 0;
  let gapFp = 0;
  let gapFn = 0;
  let rawSessions = 0;
  let closedSessions = 0;
  for (const r of rows) {
    if (Number(r.meter_gap_records ?? 0) > 0) rawSessions++;
    if (Number(r.gap_closed_records ?? 0) > 0) closedSessions++;
    const detected = Number(r.open_gap_records ?? r.meter_gap_records ?? 0) > 0;
    const truth = r.gap_true === true;
    if (detected && truth) gapTp++;
    else if (detected && !truth) gapFp++;
    else if (!detected && truth) gapFn++;
  }

  return {
    n,
    counts,
    correct,
    primary: w.p,
    primaryLo: w.lo,
    primaryHi: w.hi,
    /** Đạt ngưỡng NFR-02: cận dưới Wilson ≥ 95%. */
    passes: w.lo !== null && w.lo >= 0.95,
    silentWrong: counts.billed_wrong_silent,
    lost: rows.filter((r) => r.class_subtype === 'lost').length,
    duplicate: rows.filter((r) => r.class_subtype === 'duplicate').length,
    held,
    wrongData,
    holdPrecision: ratio(counts.held_correct, held),
    holdRecall: ratio(counts.held_correct, wrongData),
    billedN: billed.length,
    absErr,
    signedErr,
    gap: {
      truth: gapTp + gapFn,
      detected: gapTp + gapFp,
      tp: gapTp,
      fp: gapFp,
      fn: gapFn,
      precision: ratio(gapTp, gapTp + gapFp),
      recall: ratio(gapTp, gapTp + gapFn),
      /** Số phiên có ít nhất một bản ghi meter_gap (kể cả đã được đóng sau đó). */
      rawSessions,
      /** Số phiên có ít nhất một bản ghi đóng khe hở (T132). */
      closedSessions,
    },
  };
}

/** Nhóm dòng theo (config, scenario), thêm dòng gộp `all` cho mỗi cấu hình. Giữ thứ tự xuất hiện. */
export function summarizeAll(rows) {
  const groups = new Map();
  const add = (config, scenario, row) => {
    const key = `${config}|${scenario}`;
    if (!groups.has(key)) groups.set(key, { config, scenario, rows: [] });
    groups.get(key).rows.push(row);
  };
  for (const r of rows) add(r.config, r.scenario, r);
  for (const r of rows) add(r.config, 'all', r);
  return [...groups.values()].map((g) => ({
    config: g.config,
    scenario: g.scenario,
    ...summarize(g.rows),
  }));
}
