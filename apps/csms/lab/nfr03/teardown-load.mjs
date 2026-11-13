/**
 * Cất trụ tải NFR-03 sau khi đo: gỡ credential, `in_service → disabled`, khoá thẻ và tài khoản tài
 * xế của tải; in số dòng tải đã để lại.
 *
 * KHÔNG xoá gì: phiên, mẫu đo và nhật ký frame do tải sinh ra nằm trong các bảng append-only / FK
 * RESTRICT (lý do và hệ quả dung lượng: load-data.mjs, README.md). Chạy seed-load.mjs là dùng lại được.
 *
 * Chạy (từ apps/csms):
 *   NFR03_DB_URL=postgres://app_dev:…@127.0.0.1:5433/powerme node lab/nfr03/teardown-load.mjs
 * Tham số: --force = cất cả khi còn trụ tải đang nối (mặc định từ chối) · --db-url thay NFR03_DB_URL.
 */
import { connectDemoDb } from '../../demo/db-embedded.mjs';
import { dbUrlFrom, parseArgs } from './cli.mjs';
import { loadFootprint, loadState, teardownLoad } from './load-data.mjs';

const log = (m) => console.log(`[nfr03-teardown] ${m}`);
let args;
try {
  args = parseArgs(process.argv.slice(2), { values: ['db-url'], flags: ['force'] });
} catch (err) {
  console.error(`[nfr03-teardown] ${err.message}`);
  process.exit(2);
}
const url = dbUrlFrom(args);
if (!url) {
  console.error('[nfr03-teardown] Thiếu NFR03_DB_URL (hoặc --db-url)');
  process.exit(2);
}
let db = null;
try {
  db = await connectDemoDb(url);
  const done = await teardownLoad(db, { force: Boolean(args.force) });
  log(`đã cất: ${JSON.stringify(done)}`);
  if (done.openSessions > 0) {
    log(
      `CÒN ${done.openSessions} phiên của trụ tải chưa đóng: bộ quét của CSMS sẽ đưa chúng về orphaned/review ` +
        '(ân hạn 120 s, trần 24 h); không sửa tay.',
    );
  }
  log(`trạng thái: ${JSON.stringify(await loadState(db))}`);
  log(`dữ liệu tải để lại (cộng dồn): ${JSON.stringify(await loadFootprint(db))}`);
} catch (err) {
  console.error(`[nfr03-teardown] LỖI: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
}
