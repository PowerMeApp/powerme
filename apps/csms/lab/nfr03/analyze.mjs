/**
 * Tính lại `summary.md` + `summary.csv` của một lần đo NFR-03 từ dữ liệu thô, không cần CSMS hay DB.
 *
 * Vì sao tồn tại: người review phải tự kiểm được bảng kết quả từ `client-rows.jsonl` /
 * `server-rows.jsonl` đã commit; và sau khi sửa cách trình bày, mọi lần chạy cũ phải dựng lại được.
 *
 * Chạy (từ apps/csms):  node lab/nfr03/analyze.mjs lab/nfr03/results/<thư mục> [thư mục khác…]
 */
import path from 'node:path';
import { writeSummary } from './report.mjs';
import { ALL } from './stats.mjs';

const dirs = process.argv.slice(2);
if (dirs.length === 0 || dirs.some((d) => d.startsWith('--'))) {
  console.error('Dùng: node lab/nfr03/analyze.mjs <thư mục kết quả> [thư mục khác…]');
  process.exit(2);
}
const ms = (x) => (x === null || x === undefined ? '-' : x === Infinity ? '∞' : x.toFixed(1));
for (const dir of dirs.map((d) => path.resolve(d))) {
  try {
    const a = writeSummary(dir);
    const line = (side, summary) => {
      const all = summary?.find((s) => s.action === ALL);
      return all ? `${side} p95 ${ms(all.penalizedP95Ms)} ms (n ${all.n})` : `${side} chưa có`;
    };
    console.log(
      `[nfr03-analyze] ${dir}: ${a.verdict.overall}; ${line('server', a.server)}; ${line('client', a.client)}`,
    );
  } catch (err) {
    console.error(`[nfr03-analyze] ${dir}: LỖI: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
