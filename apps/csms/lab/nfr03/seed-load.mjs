/**
 * Tạo (hoặc kích hoạt lại) trụ tải NFR-03 trong một DB PowerMe có sẵn, vd staging qua tunnel.
 *
 * Idempotent, một transaction, chỉ INSERT/UPDATE các dòng của tải (xem load-data.mjs: operator
 * `LOADTEST01` bị `suspended` nên trụ không hiện trong app). Quyền của role `app_dev` là đủ.
 *
 * Chạy (từ apps/csms, sau `npm run build -w @powerme/csms` để có hàm băm của CSMS):
 *   NFR03_DB_URL=postgres://app_dev:…@127.0.0.1:5433/powerme LOAD_CP_PASSWORD=… \
 *     node lab/nfr03/seed-load.mjs [--stations 50]
 * Biến môi trường: NFR03_DB_URL (hoặc --db-url), LOAD_CP_PASSWORD (bắt buộc, 16..40 ký tự; sinh bằng
 * `openssl rand -base64 24`). Mật khẩu không có tham số dòng lệnh và không được in ra.
 * Thoát mã 2 nếu thiếu/sai cấu hình, mã 1 nếu lỗi khi nạp.
 */
import { connectDemoDb } from '../../demo/db-embedded.mjs';
import { ensureBuilt } from '../rq1/local-csms.mjs';
import { dbUrlFrom, parseArgs } from './cli.mjs';
import { checkLoadPassword, seedLoad } from './load-data.mjs';

const log = (m) => console.log(`[nfr03-seed] ${m}`);
let args;
try {
  args = parseArgs(process.argv.slice(2), { values: ['stations', 'db-url'] });
} catch (err) {
  console.error(`[nfr03-seed] ${err.message}`);
  process.exit(2);
}
const url = dbUrlFrom(args);
const password = process.env.LOAD_CP_PASSWORD;
const bad = !url ? 'Thiếu NFR03_DB_URL (hoặc --db-url)' : checkLoadPassword(password);
if (bad) {
  console.error(`[nfr03-seed] ${bad}`);
  process.exit(2);
}
let db = null;
try {
  ensureBuilt(log);
  db = await connectDemoDb(url);
  const state = await seedLoad(db, { stations: Number(args.stations ?? 50), password, log });
  log(`xong: ${JSON.stringify(state)}`);
} catch (err) {
  console.error(`[nfr03-seed] LỖI: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
}
