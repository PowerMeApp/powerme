/**
 * Bộ sinh tải NFR-03 / NFR-OCPP-01: N trụ giả OCPP 1.6J nối đồng thời vào một CSMS, chạy hồ sơ tải
 * thường ngày trong một khoảng thời gian, đo thời gian CSMS trả lời từng bản tin.
 *
 * Cam kết (BM04 NFR-03): "CSMS reply time per charge point message, p95 ≤ 1 s with 50 simulated
 * charge points", đo bằng "Simulator load 10 min, server timings (staging)". Lệnh này cho số phía
 * client; số phía server đọc từ `ocpp_message_log` (server-timings.mjs; tự chạy luôn khi có DB).
 *
 * Chạy (từ apps/csms; chi tiết, staging và mối đe doạ tính hợp lệ: lab/nfr03/README.md):
 *   # LOCAL: tự dựng Postgres nhúng (cổng 54500) + CSMS (cổng 9200), tự nạp 50 trụ tải, tự dừng
 *   node lab/nfr03/run.mjs
 *   # STAGING: trụ tải đã nạp bằng seed-load.mjs; mật khẩu trụ qua biến môi trường
 *   LOAD_CP_PASSWORD=… node lab/nfr03/run.mjs --url wss://<host>/ocpp
 *
 * Tham số:
 *   --url <ws(s)://…/ocpp>   CSMS có sẵn; bỏ trống = tự dựng CSMS cục bộ
 *   --stations N             số trụ, mặc định 50 (LOAD-0001 … LOAD-00NN)
 *   --duration-s N           thời gian tải SAU khi mọi trụ đã bắt đầu nối, mặc định 600
 *   --ramp-s N               nối dần các trụ trong N giây, mặc định 0,5 s mỗi trụ (xem README: bộ
 *                            giới hạn đăng nhập từ chối khi quá 20 lần bắt tay cùng lúc từ một IP)
 *   --meter-interval-s N     nhịp MeterValues, mặc định 10 (= mặc định sản phẩm)
 *   --heartbeat-s N          nhịp Heartbeat; mặc định dùng `interval` CSMS trả trong BootNotification
 *   --seed N                 seed của hồ sơ tải, mặc định 20261112
 *   --call-timeout-s N       sau N giây không có trả lời thì tính là timeout, mặc định 30
 *   --out <thư mục>          mặc định lab/nfr03/results/<ngày>-<local|staging|external>
 *   --label <chữ>            tên lần chạy trong báo cáo
 *   --db-url <postgres://…>  (hoặc biến NFR03_DB_URL) Postgres của CSMS có sẵn: kiểm trụ tải trước
 *                            khi chạy và đọc server timings ngay sau khi chạy
 *   --pg-port / --pg-dir / --ocpp-port   cụm Postgres nhúng và cổng OCPP khi tự dựng (54500 / tmp / 9200)
 * Biến môi trường: LOAD_CP_PASSWORD = mật khẩu Basic Auth chung của trụ tải (bắt buộc với --url; ở
 * chế độ local thiếu thì tự sinh ngẫu nhiên trong bộ nhớ). Không có tham số dòng lệnh cho mật khẩu
 * và mật khẩu không được ghi vào bất kỳ file kết quả nào.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { connectDemoDb } from '../../demo/db-embedded.mjs';
import { startLocalCsms } from '../rq1/local-csms.mjs';
import {
  dbUrlFrom,
  gitInfo,
  machineInfo,
  parseArgs,
  redactUrl,
  writeJson,
  writeJsonl,
} from './cli.mjs';
import { checkLoadPassword, loadState, seedLoad } from './load-data.mjs';
import { LoadStation } from './load-station.mjs';
import { createStationProfile, DEFAULT_PROFILE, loadIdentity } from './profile.mjs';
import { writeSummary } from './report.mjs';
import { collectInto } from './server-timings.mjs';
import { aggregateStations, ALL, percentile } from './stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[nfr03 ${new Date().toISOString().slice(11, 19)}] ${m}`);

const VALUE_ARGS = [
  'url',
  'stations',
  'duration-s',
  'ramp-s',
  'meter-interval-s',
  'heartbeat-s',
  'seed',
  'call-timeout-s',
  'out',
  'label',
  'db-url',
  'pg-port',
  'pg-dir',
  'ocpp-port',
];

function positive(args, key, fallback, { integer = true } = {}) {
  if (args[key] === undefined) return fallback;
  const n = Number(args[key]);
  if (!(n > 0) || (integer && !Number.isInteger(n))) {
    throw new Error(`--${key} phải là số${integer ? ' nguyên' : ''} dương, nhận "${args[key]}"`);
  }
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { values: VALUE_ARGS, flags: ['help'] });
  if (args.help) {
    console.error('Xem đầu file lab/nfr03/run.mjs hoặc lab/nfr03/README.md.');
    process.exit(2);
  }
  const stationCount = positive(args, 'stations', 50);
  const durationS = positive(args, 'duration-s', 600);
  const rampS = positive(args, 'ramp-s', stationCount * 0.5, { integer: false });
  const meterIntervalS = positive(args, 'meter-interval-s', 10, { integer: false });
  const heartbeatS = positive(args, 'heartbeat-s', null, { integer: false });
  const seed = positive(args, 'seed', 20261112);
  const callTimeoutS = positive(args, 'call-timeout-s', 30, { integer: false });
  const external = Boolean(args.url);
  const kind = !external ? 'local' : /staging/i.test(args.url) ? 'staging' : 'external';
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(args.out ?? path.join(here, 'results', `${today}-${kind}`));
  const label = args.label ?? `${kind}, ${stationCount} trụ × ${durationS} s`;

  let password = process.env.LOAD_CP_PASSWORD;
  if (!external && !password) password = randomBytes(18).toString('base64url');
  const bad = checkLoadPassword(password);
  if (bad) throw new Error(bad);

  let local = null;
  let db = null;
  let ownDb = false;
  let dbUrl = null;
  const cleanup = async () => {
    if (ownDb && db) await db.end().catch(() => {});
    if (local) await local.stop();
  };
  const onSignal = () => {
    log('nhận tín hiệu dừng: dọn tiến trình, KHÔNG ghi kết quả…');
    void cleanup().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // ---- Đích -----------------------------------------------------------------------------
    let endpoint;
    let target;
    if (external) {
      endpoint = args.url.replace(/\/+$/, '');
      target = { kind, endpoint: redactUrl(endpoint) };
      dbUrl = dbUrlFrom(args);
      if (dbUrl) {
        // Chỉ mở kết nối lúc cần: role app_dev có tối đa 5 kết nối, và một kết nối để không suốt
        // 10 phút qua SSH tunnel dễ chết giữa chừng.
        const check = await connectDemoDb(dbUrl);
        let state;
        try {
          state = await loadState(check);
        } finally {
          await check.end().catch(() => {});
        }
        log(`trụ tải trong DB: ${JSON.stringify(state)}`);
        if (state.with_credential < stationCount) {
          throw new Error(
            `DB mới có ${state.with_credential}/${stationCount} trụ tải có credential: chạy seed-load.mjs trước`,
          );
        }
      } else {
        log(
          'không có NFR03_DB_URL: chỉ đo phía client; đọc server timings sau bằng server-timings.mjs',
        );
      }
    } else {
      local = await startLocalCsms({
        pgDir: path.resolve(args['pg-dir'] ?? path.join(os.tmpdir(), 'powerme-nfr03-pg')),
        pgPort: positive(args, 'pg-port', 54500),
        ocppPort: positive(args, 'ocpp-port', 9200),
        database: 'powerme_nfr03',
        reconciliationEnabled: true,
        // Mặc định SẢN PHẨM (ân hạn 120 s, ngưỡng khe hở 3 nhịp), không rút ngắn như harness RQ1.
        timing: { graceS: 120, intervalS: meterIntervalS, gapFactor: 3 },
        // Như staging: trụ phải qua Basic Auth (scrypt) lúc bắt tay.
        envOverrides: { ALLOW_LEGACY_NO_CREDENTIAL: 'false' },
        logFile: path.join(os.tmpdir(), 'powerme-nfr03-csms.log'),
        log,
      });
      db = local.db;
      endpoint = local.endpoint;
      target = { kind, endpoint, env: local.env };
      const state = await seedLoad(db, { stations: stationCount, password, log });
      log(`đã nạp trụ tải: ${JSON.stringify(state)}`);
    }

    // ---- Chạy tải -------------------------------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    const rows = [];
    const stations = Array.from({ length: stationCount }, (_, i) => {
      const identity = loadIdentity(i + 1);
      return new LoadStation({
        endpoint,
        identity,
        password,
        plan: createStationProfile({ seed, index: i + 1, meterIntervalS }),
        meterIntervalS,
        heartbeatS,
        callTimeoutMs: callTimeoutS * 1000,
        onRow: (row) => rows.push(row),
      });
    });
    // Thử MỘT trụ trước: sai mật khẩu thì dừng ở 1 lần 401, thay vì để 50 trụ cùng sai và làm bộ
    // giới hạn đăng nhập khoá IP này 15 phút (20 lần sai / 60 s, charge-point-login-limiter.ts).
    const probe = new LoadStation({
      endpoint,
      identity: loadIdentity(1),
      password,
      plan: createStationProfile({ seed, index: 1, meterIntervalS }),
      meterIntervalS,
    });
    try {
      await probe.connect();
    } catch (err) {
      throw new Error(`trụ thử không nối được, KHÔNG chạy tải: ${err.message}`);
    }
    await sleep(500);
    await probe.close();
    await sleep(500);
    log('trụ thử LOAD-0001 nối được (mật khẩu đúng), bắt đầu tải');

    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const startedAt = new Date();
    const endMs = startedAt.getTime() + (rampS + durationS) * 1000;
    log(
      `${stationCount} trụ → ${redactUrl(endpoint)}; nối dần ${rampS} s rồi tải ${durationS} s ` +
        `(tới ${new Date(endMs).toISOString().slice(11, 19)}Z), MeterValues mỗi ${meterIntervalS} s, seed ${seed}`,
    );
    let reported = 0;
    const progress = setInterval(() => {
      const recent = rows.slice(reported);
      reported = rows.length;
      const ms = recent.map((r) => r.ms).filter((x) => typeof x === 'number');
      log(
        `  ${stations.filter((s) => s.client).length}/${stationCount} trụ đang nối · ${rows.length} CALL · ` +
          `30 s vừa rồi: ${recent.length} CALL, p95 ${percentile(ms, 95)?.toFixed(1) ?? '-'} ms, ` +
          `không trả lời ${recent.length - ms.length}`,
      );
    }, 30_000);
    const stats = await Promise.all(
      stations.map((s, i) => sleep((i * rampS * 1000) / stationCount).then(() => s.run(endMs))),
    );
    clearInterval(progress);
    loopDelay.disable();
    const finishedAt = new Date();

    // ---- Ghi đầu ra -----------------------------------------------------------------------
    rows.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
    const meta = {
      tool: 'lab/nfr03',
      label,
      target,
      params: {
        stations: stationCount,
        durationS,
        rampS,
        meterIntervalS,
        heartbeatS: heartbeatS ?? 'theo BootNotification.conf',
        seed,
        callTimeoutS,
        profile: DEFAULT_PROFILE,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallClockS: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
      stations: aggregateStations(stats, stationCount),
      clientCalls: rows.length,
      eventLoopDelayMs: {
        p50: Number((loopDelay.percentile(50) / 1e6).toFixed(2)),
        p99: Number((loopDelay.percentile(99) / 1e6).toFixed(2)),
        max: Number((loopDelay.max / 1e6).toFixed(2)),
      },
      git: gitInfo(),
      machine: machineInfo(),
    };
    writeJsonl(path.join(outDir, 'client-rows.jsonl'), rows);
    await writeJson(path.join(outDir, 'meta.json'), meta);
    log(
      `xong: ${rows.length} CALL trong ${meta.wallClockS} s; ${meta.stations.connected}/${stationCount} trụ nối được, ` +
        `${meta.stations.sessionsStopped} phiên dừng xong, ${meta.stations.stepErrors} bản tin lỗi`,
    );

    let analysis = null;
    if (dbUrl) {
      try {
        db = await connectDemoDb(dbUrl);
        ownDb = true;
      } catch (err) {
        log(`không nối lại được Postgres (${err.message}): chạy server-timings.mjs --dir sau`);
      }
    }
    if (db) {
      await sleep(2000); // dòng log của các CALLRESULT cuối được ghi không đồng bộ
      try {
        analysis = await collectInto(outDir, db, { log });
      } catch (err) {
        if (!external) throw err;
        log(`đọc server timings lỗi (${err.message}): chạy server-timings.mjs --dir sau`);
      }
    }
    analysis ??= writeSummary(outDir);
    for (const [side, summary] of [
      ['server', analysis.server],
      ['client', analysis.client],
    ]) {
      const all = summary?.find((s) => s.action === ALL);
      if (!all) continue;
      log(
        `  ${side}: n ${all.n}, p50 ${all.p50Ms?.toFixed(1)} ms, p95 ${all.p95Ms?.toFixed(1)} ms, ` +
          `p99 ${all.p99Ms?.toFixed(1)} ms, max ${all.maxMs?.toFixed(1)} ms, không trả lời ${all.unanswered}`,
      );
    }
    log(`kết luận lần chạy: ${analysis.verdict.overall} → ${path.join(outDir, 'summary.md')}`);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`[nfr03] LỖI: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
