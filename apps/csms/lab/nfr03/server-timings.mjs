/**
 * "Server timings" của NFR-03: thời gian CSMS xử lý từng CALL của trụ, tính từ `ocpp_message_log`.
 *
 * KHÔNG cần sửa CSMS. Gateway đã ghi đủ hai đầu của mỗi bản tin (`src/ocpp-gateway/ocpp-server.ts`):
 *   - CALL chiều vào: `received_at` = `new Date()` lấy ngay khi ocpp-rpc gọi handler của CSMS (trước
 *     hàng đợi tuần tự theo trụ, trước khi ghi log, trước nghiệp vụ);
 *   - CALLRESULT / CALLERROR chiều ra: `received_at` = `new Date()` trong sự kiện `message` mà
 *     ocpp-rpc phát ngay sau `ws.send()`.
 * Hiệu của hai mốc (cùng một đồng hồ, cùng một tiến trình) là thời gian CSMS giữ bản tin: chờ trong
 * hàng đợi của trụ + INSERT nhật ký + handler + ghi DB + tuần tự hoá trả lời. Nó KHÔNG gồm: TLS và
 * proxy của Caddy, mạng, thời gian frame nằm trong bộ đệm socket của hệ điều hành trước khi Node đọc.
 * Độ phân giải 1 ms (đồng hồ `Date` của Node).
 *
 * Ghép cặp theo (trụ, epoch, unique_id), chỉ trên trụ tải (`LOAD-%`), trong cửa sổ thời gian của lần
 * chạy. Khi có `client-rows.jsonl`, chỉ giữ các bản tin mà bộ sinh tải của ĐÚNG lần chạy đó đã gửi
 * (MessageId là UUID), nên hai lần chạy sát nhau không lẫn vào nhau.
 *
 * Chạy (từ apps/csms), sau khi `run.mjs` đã ghi `<thư mục>/meta.json` + `client-rows.jsonl`:
 *   NFR03_DB_URL=postgres://app_dev:…@127.0.0.1:5433/powerme \
 *     node lab/nfr03/server-timings.mjs --dir lab/nfr03/results/<ngày>-staging
 * Tham số: --dir <thư mục kết quả> (bắt buộc) · --db-url <postgres://…> (hoặc biến NFR03_DB_URL) ·
 *   --from / --to <ISO> (mặc định: cửa sổ trong meta.json, nới mỗi đầu 120 s phòng lệch đồng hồ).
 * Chỉ ĐỌC (một kết nối, hai câu SELECT); ghi `server-rows.jsonl`, cập nhật `meta.json` và summary.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDemoDb } from '../../demo/db-embedded.mjs';
import { dbUrlFrom, parseArgs, readJsonl, writeJson, writeJsonl } from './cli.mjs';
import { LOAD_SERIAL_LIKE, LOAD_SITE_CODE, loadFootprint } from './load-data.mjs';
import { writeSummary } from './report.mjs';
import { pairFrames } from './stats.mjs';

/** Nới cửa sổ đọc log: đồng hồ máy bắn tải và đồng hồ CSMS có thể lệch nhau. */
export const WINDOW_PAD_MS = 120_000;

/** Đọc frame của trụ tải trong [fromMs, toMs) rồi ghép cặp. `db` là pg.Client. */
export async function fetchServerRows(db, { fromMs, toMs, clientRows = null }) {
  const { rows } = await db.query(
    `SELECT l.id::text AS id, cp.serial_number AS station, l.epoch, l.direction::text AS direction,
            l.message_type, l.unique_id, l.action, l.received_at
       FROM ocpp_message_log l
       JOIN charge_points cp ON cp.id = l.charge_point_id
       JOIN sites s ON s.id = cp.site_id
      WHERE s.site_code = $1 AND cp.serial_number LIKE $2
        AND l.received_at >= $3 AND l.received_at < $4
      ORDER BY l.id`,
    [LOAD_SITE_CODE, LOAD_SERIAL_LIKE, new Date(fromMs), new Date(toMs)],
  );
  const frames = rows.map((r) => ({
    id: r.id,
    station: r.station,
    epoch: r.epoch,
    direction: r.direction,
    messageType: r.message_type,
    uniqueId: r.unique_id,
    action: r.action,
    receivedAtMs: r.received_at.getTime(),
  }));
  let paired = pairFrames(frames);
  const pairedAll = paired.length;
  if (clientRows) {
    const sent = new Set(clientRows.map((r) => `${r.station}\u0000${r.id}`));
    paired = paired.filter((r) => sent.has(`${r.station}\u0000${r.id}`));
  }
  return {
    frames: frames.length,
    callsInWindow: pairedAll,
    rows: paired.map((r) => ({
      station: r.station,
      id: r.id,
      action: r.action,
      receivedAt: new Date(r.receivedAtMs).toISOString(),
      ms: r.ms,
      result: r.result,
    })),
  };
}

/** Đọc số server cho một thư mục kết quả và ghi lại meta + summary. Dùng chung cho run.mjs và CLI. */
export async function collectInto(dir, db, { fromMs = null, toMs = null, log = () => {} } = {}) {
  const metaFile = path.join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const clientRows = readJsonl(path.join(dir, 'client-rows.jsonl'));
  const from = fromMs ?? Date.parse(meta.startedAt) - WINDOW_PAD_MS;
  const to = toMs ?? Date.parse(meta.finishedAt) + WINDOW_PAD_MS;
  const res = await fetchServerRows(db, { fromMs: from, toMs: to, clientRows });
  writeJsonl(path.join(dir, 'server-rows.jsonl'), res.rows);
  meta.serverTimings = {
    source: 'ocpp_message_log',
    readAt: new Date().toISOString(),
    windowFrom: new Date(from).toISOString(),
    windowTo: new Date(to).toISOString(),
    framesRead: res.frames,
    callsInWindow: res.callsInWindow,
    callsOfThisRun: res.rows.length,
  };
  meta.footprint = await loadFootprint(db);
  await writeJson(metaFile, meta);
  log(
    `server: ${res.frames} frame trong cửa sổ, ${res.callsInWindow} CALL của trụ tải, ` +
      `${res.rows.length} thuộc lần chạy này`,
  );
  return writeSummary(dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = (m) => console.log(`[nfr03-server] ${m}`);
  let db = null;
  try {
    const args = parseArgs(process.argv.slice(2), { values: ['dir', 'db-url', 'from', 'to'] });
    const url = dbUrlFrom(args);
    if (!args.dir || !url) {
      console.error(
        'Cần --dir <thư mục kết quả> và chuỗi kết nối Postgres (biến NFR03_DB_URL hoặc --db-url).',
      );
      process.exit(2);
    }
    const parse = (v, name) => {
      if (v === undefined) return null;
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) throw new Error(`--${name} không phải thời điểm ISO: ${v}`);
      return ms;
    };
    db = await connectDemoDb(url);
    const { verdict } = await collectInto(path.resolve(args.dir), db, {
      fromMs: parse(args.from, 'from'),
      toMs: parse(args.to, 'to'),
      log,
    });
    log(`kết luận: ${verdict.overall} → ${path.join(path.resolve(args.dir), 'summary.md')}`);
  } catch (err) {
    console.error(`[nfr03-server] LỖI: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    if (db) await db.end().catch(() => {});
  }
}
