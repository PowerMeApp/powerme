/**
 * Phân tích RQ1: đọc dữ liệu thô (JSONL hoặc CSV, mỗi dòng một phiên) → bảng theo kịch bản × cấu
 * hình, xuất Markdown + CSV tổng hợp. KHÔNG cần CSMS hay DB: mọi chỉ số tính lại từ các trường
 * `E_true`, `E_stop`, `E_bill`, `status` của từng dòng (NFR-02 mục 5).
 *
 * Chạy (từ apps/csms):
 *   node lab/rq1/analyze.mjs lab/rq1/results/<ngày>/powerme/rows.jsonl \
 *        lab/rq1/results/<ngày>/powerme-off/rows.jsonl --out lab/rq1/results/<ngày>
 *
 * Mỗi file đầu vào nếu có `meta.json` nằm cạnh thì được đưa vào phần "Lần chạy" của báo cáo.
 * Tuỳ chọn: --out <thư mục> (mặc định: in Markdown ra stdout, không ghi file), --title "…".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeAll } from './metrics.mjs';
import {
  parseCsv,
  parseJsonl,
  reclassify,
  renderMarkdown,
  SUMMARY_COLUMNS,
  summaryRows,
  toCsv,
} from './report.mjs';

export function loadRows(file) {
  const text = readFileSync(file, 'utf8');
  return file.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseJsonl(text);
}

export function analyzeFiles(files, { title } = {}) {
  const rows = [];
  const metas = [];
  for (const file of files) {
    rows.push(...loadRows(file).map(reclassify));
    const metaFile = path.join(path.dirname(file), 'meta.json');
    if (existsSync(metaFile)) metas.push(JSON.parse(readFileSync(metaFile, 'utf8')));
  }
  const groups = summarizeAll(rows);
  return {
    rows,
    groups,
    markdown: renderMarkdown(rows, { metas, ...(title ? { title } : {}) }),
    csv: toCsv(summaryRows(groups), SUMMARY_COLUMNS),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const files = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--title') opts.title = argv[++i];
    else files.push(argv[i]);
  }
  if (files.length === 0) {
    console.error('Cách dùng: node lab/rq1/analyze.mjs <rows.jsonl|rows.csv>… [--out <thư mục>]');
    process.exit(2);
  }
  const result = analyzeFiles(files, opts);
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(path.join(opts.out, 'summary.md'), result.markdown);
    writeFileSync(path.join(opts.out, 'summary.csv'), result.csv);
    console.log(
      `đã ghi ${path.join(opts.out, 'summary.md')} và summary.csv (${result.rows.length} dòng)`,
    );
  } else {
    console.log(result.markdown);
  }
}
