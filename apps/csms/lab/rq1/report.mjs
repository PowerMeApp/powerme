/**
 * Định dạng dữ liệu của harness RQ1: dựng một dòng cho mỗi lần chạy, đọc/ghi JSONL + CSV, và
 * dựng bảng tổng hợp Markdown/CSV. Không I/O đĩa ở đây (run.mjs và analyze.mjs lo việc đó).
 *
 * Một dòng = một phiên theo sự thật nền, đủ các trường NFR-02 mục 5 (`run_id`, `scenario`,
 * `config`, `seed`, `session_id`, `transaction_id`, `E_true`, `E_stop`, `E_bill`, `status`,
 * `injected_fault`, `class`) cộng các trường phụ để tính lại số đo SRS NFR-REC-01.
 */
import { CLASS_LABELS, classifyRun, summarizeAll } from './metrics.mjs';

/** Thứ tự cột CSV. JSONL chứa đúng các khoá này. */
export const COLUMNS = [
  'run_id',
  'scenario',
  'config',
  'seed',
  'run_index',
  'run_seed',
  'charge_point',
  'id_tag',
  'session_id',
  'transaction_id',
  'session_count',
  'E_true',
  'E_stop',
  'E_bill',
  'status',
  'injected_fault',
  'class',
  'class_subtype',
  'station_data_wrong',
  'gap_true',
  'max_delivered_gap_s',
  'meter_gap_records',
  'conflict_records',
  'late_sample_records',
  'replay_records',
  'duplicate_records',
  'orphan_stop_records',
  'status_path',
  'payment_mode',
  'debit_vnd',
  'meter_start_wh',
  'meter_stop_sent_wh',
  'meter_stop_true_wh',
  'db_meter_stop_wh',
  'station_transaction_ids',
  'started_at',
  'duration_s',
  'error',
];

/**
 * Dựng dòng dữ liệu từ kế hoạch + sự thật nền của trụ + kết quả đọc từ hệ thống.
 * @param gapThresholdS  ngưỡng khe hở = RECONCILE_GAP_FACTOR × nhịp MeterValues (giây)
 */
export function buildRow({ config, seed, run, truth, collected, gapThresholdS }) {
  const sessions = collected?.sessions ?? [];
  const cls = classifyRun({
    eTrue: truth.eTrueWh,
    eStop: truth.eStopWh,
    sessions: sessions.map((s) => ({ outcome: s.outcome, eBill: s.eBillWh })),
    error: truth.error ?? collected?.error ?? null,
  });
  const only = sessions.length === 1 ? sessions[0] : null;
  const rec = (type) => sessions.reduce((a, s) => a + (s.records?.[type] ?? 0), 0);
  return {
    run_id: run.runId,
    scenario: run.plan.scenario,
    config,
    seed,
    run_index: run.plan.runIndex,
    run_seed: run.plan.runSeed,
    charge_point: run.chargePoint,
    id_tag: run.idTag,
    session_id: sessions.map((s) => s.sessionId).join('|') || null,
    transaction_id: sessions.map((s) => s.transactionId).join('|') || null,
    session_count: sessions.length,
    E_true: truth.eTrueWh,
    E_stop: truth.eStopWh,
    E_bill: only ? only.eBillWh : null,
    status: sessions.map((s) => s.status).join('|') || null,
    injected_fault: JSON.stringify(truth.injectedFault),
    class: cls.class,
    class_subtype: cls.subtype,
    station_data_wrong: cls.stationDataWrong,
    gap_true: truth.maxDeliveredGapS === null ? null : truth.maxDeliveredGapS > gapThresholdS,
    max_delivered_gap_s: truth.maxDeliveredGapS,
    meter_gap_records: rec('meter_gap'),
    conflict_records: rec('conflict'),
    late_sample_records: rec('late_sample'),
    replay_records: rec('replay'),
    duplicate_records: rec('duplicate'),
    orphan_stop_records: rec('orphan_stop'),
    status_path: only?.statusPath ?? null,
    payment_mode: only?.paymentMode ?? null,
    debit_vnd: only?.debitVnd ?? null,
    meter_start_wh: truth.meterStartWh,
    meter_stop_sent_wh: truth.meterStopSentWh,
    meter_stop_true_wh: truth.meterStopTrueWh,
    db_meter_stop_wh: only?.meterStopWh ?? null,
    station_transaction_ids: truth.transactionIds.join('|') || null,
    started_at: truth.startedAt,
    duration_s: truth.durationS,
    error: truth.error ?? collected?.error ?? null,
  };
}

// ---- CSV / JSONL -------------------------------------------------------------------------

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const NUMERIC = new Set([
  'seed',
  'run_index',
  'run_seed',
  'session_count',
  'E_true',
  'E_stop',
  'E_bill',
  'max_delivered_gap_s',
  'meter_gap_records',
  'conflict_records',
  'late_sample_records',
  'replay_records',
  'duplicate_records',
  'orphan_stop_records',
  'debit_vnd',
  'meter_start_wh',
  'meter_stop_sent_wh',
  'meter_stop_true_wh',
  'db_meter_stop_wh',
  'duration_s',
]);
const BOOLEAN = new Set(['station_data_wrong', 'gap_true']);

/** Đọc CSV do `toCsv` ghi (có dấu nháy kép, ô rỗng = null), ép kiểu theo tên cột. */
export function parseCsv(text) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  const [header, ...body] = records;
  if (!header) return [];
  return body
    .filter((r) => r.some((c) => c !== ''))
    .map((r) =>
      Object.fromEntries(
        header.map((h, i) => {
          const raw = r[i] ?? '';
          if (raw === '') return [h, null];
          if (NUMERIC.has(h)) return [h, Number(raw)];
          if (BOOLEAN.has(h)) return [h, raw === 'true'];
          return [h, raw];
        }),
      ),
    );
}

/**
 * Tính lại `class` từ các trường thô của dòng (không tin cột `class` đã lưu) — bảo đảm phân tích
 * lại được mà không chạy lại. Trả dòng mới kèm `class_mismatch` nếu khác giá trị đã lưu.
 */
export function reclassify(row) {
  const statuses = row.status ? String(row.status).split('|') : [];
  const sessions = statuses.map((status) => ({
    outcome:
      status === 'review'
        ? 'held'
        : (status === 'reconciled' || status === 'stopped') && row.E_bill !== null
          ? 'billed'
          : 'open',
    eBill: statuses.length === 1 ? row.E_bill : null,
  }));
  const cls = classifyRun({
    eTrue: row.E_true,
    eStop: row.E_stop,
    sessions,
    error: row.error ?? null,
  });
  return {
    ...row,
    class: cls.class,
    class_subtype: cls.subtype,
    station_data_wrong: cls.stationDataWrong,
    class_mismatch: row.class !== undefined && row.class !== null && row.class !== cls.class,
  };
}

// ---- Bảng tổng hợp ------------------------------------------------------------------------

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const fix = (v, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d));
const frac = (v, a, b) => (v === null ? '—' : `${pct(v)} (${a}/${b})`);

export const SUMMARY_COLUMNS = [
  'config',
  'scenario',
  'n',
  'billed_correct',
  'held_correct',
  'held_unnecessary',
  'billed_wrong_silent',
  'lost_or_duplicate',
  'unresolved',
  'harness_error',
  'correct',
  'primary',
  'primary_wilson_lo',
  'primary_wilson_hi',
  'passes_95',
  'lost',
  'duplicate',
  'station_data_wrong',
  'held',
  'hold_precision',
  'hold_recall',
  'billed_n',
  'abs_err_wh_mean',
  'abs_err_wh_ci_lo',
  'abs_err_wh_ci_hi',
  'signed_err_wh_mean',
  'gap_truth',
  'gap_detected',
  'gap_tp',
  'gap_fp',
  'gap_fn',
  'gap_precision',
  'gap_recall',
];

export function summaryRows(groups) {
  return groups.map((g) => ({
    config: g.config,
    scenario: g.scenario,
    n: g.n,
    ...g.counts,
    correct: g.correct,
    primary: g.primary,
    primary_wilson_lo: g.primaryLo,
    primary_wilson_hi: g.primaryHi,
    passes_95: g.passes,
    lost: g.lost,
    duplicate: g.duplicate,
    station_data_wrong: g.wrongData,
    held: g.held,
    hold_precision: g.holdPrecision,
    hold_recall: g.holdRecall,
    billed_n: g.billedN,
    abs_err_wh_mean: g.absErr.mean,
    abs_err_wh_ci_lo: g.absErr.lo,
    abs_err_wh_ci_hi: g.absErr.hi,
    signed_err_wh_mean: g.signedErr.mean,
    gap_truth: g.gap.truth,
    gap_detected: g.gap.detected,
    gap_tp: g.gap.tp,
    gap_fp: g.gap.fp,
    gap_fn: g.gap.fn,
    gap_precision: g.gap.precision,
    gap_recall: g.gap.recall,
  }));
}

const table = (head, body) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

/** Báo cáo Markdown. `metas` là các meta.json của những lần chạy đã gộp (có thể rỗng). */
export function renderMarkdown(rows, { metas = [], title = 'Kết quả RQ1 / NFR-02' } = {}) {
  const groups = summarizeAll(rows);
  const scen = (s) => (s === 'all' ? '**gộp**' : s.toUpperCase());
  const out = [`# ${title}`, ''];

  if (metas.length) {
    out.push('## Lần chạy', '');
    out.push(
      table(
        [
          'Cấu hình',
          'Số dòng',
          'Seed',
          'Commit CSMS',
          'Bắt đầu (UTC)',
          'Thời gian chạy',
          'Song song',
        ],
        metas.map((m) => [
          m.config,
          String(m.rows),
          String(m.seed),
          `\`${String(m.git?.commit ?? '?').slice(0, 7)}\`${m.git?.dirty ? ' (+sửa chưa commit)' : ''}`,
          m.startedAt,
          `${m.wallClockS} s`,
          String(m.concurrency),
        ]),
      ),
      '',
    );
    const t = metas[0].timing;
    if (t) {
      out.push(
        `${
          t.intervalS === 10 && t.graceS === 120
            ? 'Tham số thời gian THEO SẢN PHẨM'
            : 'Tham số thời gian ĐÃ RÚT NGẮN (mối đe doạ tính hợp lệ, xem README)'
        }: nhịp MeterValues ` +
          `${t.intervalS} s (sản phẩm 10 s), \`OFFLINE_GRACE_S\` = ${t.graceS} s (sản phẩm 120 s), ` +
          `độ dài đứt ${t.graceS + 1}–${t.graceS + 1 + t.offlineExtraMaxS} s, ngưỡng khe hở ` +
          `${t.gapThresholdS} s. Dung sai tol = 1 Wh.`,
        '',
      );
    }
  }

  out.push('## Chỉ số chính NFR-02 (tỉ lệ phiên đúng, CI Wilson 95%)', '');
  out.push(
    table(
      [
        'Cấu hình',
        'Kịch bản',
        'n',
        'Tính tiền đúng',
        'Giữ lại đúng',
        'Giữ lại thừa',
        'Sai im lặng',
        'Mất/trùng',
        'Khác',
        'Tỉ lệ đúng',
        'CI 95% Wilson',
        'Cận dưới ≥ 95%',
      ],
      groups.map((g) => [
        g.config,
        scen(g.scenario),
        String(g.n),
        String(g.counts.billed_correct),
        String(g.counts.held_correct),
        String(g.counts.held_unnecessary),
        String(g.counts.billed_wrong_silent),
        String(g.counts.lost_or_duplicate),
        String(g.counts.unresolved + g.counts.harness_error),
        pct(g.primary),
        `${pct(g.primaryLo)} – ${pct(g.primaryHi)}`,
        g.passes ? 'đạt' : 'KHÔNG',
      ]),
    ),
    '',
    '"Khác" = `unresolved` + `harness_error` (ngoài 5 nhóm của NFR-02, tính là sai). Với n = 30, ' +
      'kể cả 30/30 đúng thì cận dưới Wilson chỉ là 88,6%: ngưỡng 95% chỉ đạt được trên mẫu gộp lớn hơn ' +
      '(90/90 → 95,9%).',
    '',
  );

  out.push('## Giữ phiên lại như một bộ phát hiện dữ liệu trụ sai', '');
  out.push(
    table(
      ['Cấu hình', 'Kịch bản', 'Phiên dữ liệu sai', 'Phiên bị giữ', 'Precision', 'Recall'],
      groups.map((g) => [
        g.config,
        scen(g.scenario),
        String(g.wrongData),
        String(g.held),
        frac(g.holdPrecision, g.counts.held_correct, g.held),
        frac(g.holdRecall, g.counts.held_correct, g.wrongData),
      ]),
    ),
    '',
  );

  out.push('## Số đo SRS NFR-REC-01', '');
  out.push(
    table(
      [
        'Cấu hình',
        'Kịch bản',
        'Phiên đã tính tiền',
        'abs(E_bill − E_true) TB (Wh)',
        'CI 95% (t)',
        'Sai số có dấu TB (Wh)',
        'Mất',
        'Trùng',
        'Khe hở thật',
        'meter_gap P',
        'meter_gap R',
      ],
      groups.map((g) => [
        g.config,
        scen(g.scenario),
        String(g.billedN),
        fix(g.absErr.mean),
        g.absErr.lo === null ? '—' : `${fix(g.absErr.lo)} – ${fix(g.absErr.hi)}`,
        fix(g.signedErr.mean),
        String(g.lost),
        String(g.duplicate),
        String(g.gap.truth),
        frac(g.gap.precision, g.gap.tp, g.gap.detected),
        frac(g.gap.recall, g.gap.tp, g.gap.truth),
      ]),
    ),
    '',
    'Sai số Wh chỉ tính trên phiên đã tính tiền (phiên bị giữ không có `E_bill`). "Khe hở thật" = ' +
      'chuỗi mẫu trụ ĐÃ GIAO (kể cả mốc bắt đầu và mốc dừng) có khoảng trống lớn hơn ngưỡng khe hở.',
    '',
  );

  const mismatches = rows.filter((r) => r.class_mismatch).length;
  if (mismatches) {
    out.push(`**Cảnh báo:** ${mismatches} dòng có cột \`class\` đã lưu khác kết quả tính lại.`, '');
  }
  out.push('## Chú giải nhóm', '');
  for (const [code, label] of Object.entries(CLASS_LABELS)) out.push(`- \`${code}\`: ${label}`);
  out.push('');
  return out.join('\n');
}
