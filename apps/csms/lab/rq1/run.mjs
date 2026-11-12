/**
 * Bộ chạy thí nghiệm RQ1 / NFR-02: lặp các kịch bản đứt kết nối trên một cấu hình CSMS, ghi mỗi
 * phiên một dòng (sự thật nền của trụ + kết quả đọc từ hệ thống) và tính chỉ số.
 *
 * Chạy (từ apps/csms; chi tiết và mối đe doạ tính hợp lệ: lab/rq1/README.md):
 *   node lab/rq1/run.mjs --config powerme     --scenario all --runs 30 --seed 20261112
 *   node lab/rq1/run.mjs --config powerme-off --scenario all --runs 30 --seed 20261112
 *   node lab/rq1/run.mjs --config steve       --scenario all --runs 30 --seed 20261112 \
 *        --url ws://127.0.0.1:8180/steve/websocket/CentralSystemService
 *
 * Tham số:
 *   --config powerme|powerme-off|steve   cấu hình CSMS (bắt buộc)
 *   --scenario s1|s2|s3|all              mặc định all
 *   --runs N                             số lần chạy mỗi kịch bản, mặc định 30
 *   --seed N                             seed gốc, mặc định 20261112 (cùng seed → cùng kế hoạch)
 *   --out <thư mục>                      mặc định lab/rq1/results/<ngày>; ghi vào <out>/<config>/
 *   --concurrency N                      số trụ chạy song song, mặc định 10
 *   --interval-s N / --grace-s N         nhịp MeterValues / OFFLINE_GRACE_S của thí nghiệm (2 / 5)
 *   --url <ws://…>                       CSMS có sẵn thay vì tự dựng (powerme*: cần thêm --db-url)
 *   --db-url <postgres://…>              Postgres của CSMS có sẵn (để nạp định danh và đọc kết quả)
 *   --pg-port / --pg-dir / --ocpp-port   cụm Postgres nhúng và cổng OCPP khi tự dựng (54490 / tmp / 9190)
 *   --batch <chữ số>                     tiền tố định danh trụ/thẻ (mặc định theo seed; đổi khi chạy lại
 *                                        trên một CSMS không được xoá dữ liệu)
 *   --steve-compose <file>               compose của SteVe để truy vấn MariaDB (infra/lab/steve/docker-compose.yml)
 *   --steve-schema evse|connector        tên bảng súng của SteVe (mặc định evse, SteVe 3.14.1)
 *   --register-only / --print-sql        (steve) chỉ đăng ký trụ + thẻ / chỉ in SQL đăng ký rồi thoát
 *   --s2-queue-lost-p 0..1               THĂM DÒ, ngoài 3 kịch bản chính thức: xác suất S2 làm mất hẳn
 *                                        hàng đợi MeterValues (mặc định 0). Khác 0 thì KHÔNG dùng cho NFR-02.
 * Biến môi trường: CP_PASSWORD (Basic Auth của trụ khi CSMS có sẵn yêu cầu).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDemoDb, CSMS_DIR } from '../../demo/db-embedded.mjs';
import { createPowermeAdapter } from './adapters/powerme.mjs';
import { createSteveAdapter, dockerMariadbQuery, registrationSql } from './adapters/steve.mjs';
import { startLocalCsms } from './local-csms.mjs';
import { summarizeAll } from './metrics.mjs';
import { buildPlans, DEFAULT_TIMING, SCENARIOS } from './plan.mjs';
import {
  buildRow,
  renderMarkdown,
  SUMMARY_COLUMNS,
  summaryRows,
  toCsv,
  toJsonl,
} from './report.mjs';
import { runScenario } from './scenarios.mjs';
import { LabStation } from './station.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CSMS_DIR, '..', '..');
const CONFIGS = ['powerme', 'powerme-off', 'steve'];
const CONFIG_LETTER = { powerme: 'P', 'powerme-off': 'O', steve: 'V' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[rq1 ${new Date().toISOString().slice(11, 19)}] ${m}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`tham số lạ: ${a}`);
    const key = a.slice(2);
    if (['register-only', 'print-sql', 'help'].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function gitInfo() {
  const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try {
    return {
      commit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      // Chỉ xét mã CSMS chạy thật (src/, drizzle/): sửa harness không làm đổi CSMS được đo.
      dirty: git('status', '--porcelain', '--', 'apps/csms/src', 'apps/csms/drizzle').length > 0,
    };
  } catch {
    return { commit: null, branch: null, dirty: null };
  }
}

/** Định danh của từng lần chạy: mỗi lần một trụ và một thẻ riêng (idTag ≤ 20 ký tự theo OCPP). */
export function buildRuns({ config, plans, batch }) {
  const letter = CONFIG_LETTER[config];
  return plans.map((plan) => {
    const nn = String(plan.runIndex).padStart(2, '0');
    const sc = plan.scenario.toUpperCase();
    return {
      plan,
      runId: `${config}-${plan.scenario}-${nn}`,
      chargePoint: `RQ1-${batch}-${letter}-${sc}-${nn}`,
      idTag: `T${batch}${letter}${sc}${nn}`.slice(0, 20),
    };
  });
}

async function collectWhenSettled(adapter, run, { timeoutMs, stepMs = 400 }) {
  const end = Date.now() + timeoutMs;
  let result = await adapter.collect(run);
  while (!adapter.isSettled(result) && Date.now() < end) {
    await sleep(stepMs);
    result = await adapter.collect(run);
  }
  return result;
}

/** Chạy `tasks` với tối đa `limit` việc cùng lúc, giữ thứ tự kết quả. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !CONFIGS.includes(args.config)) {
    console.error(
      `Cần --config ${CONFIGS.join('|')}. Xem đầu file run.mjs hoặc lab/rq1/README.md.`,
    );
    process.exit(2);
  }
  const config = args.config;
  const scenarios =
    !args.scenario || args.scenario === 'all' ? SCENARIOS : String(args.scenario).split(',');
  for (const s of scenarios) if (!SCENARIOS.includes(s)) throw new Error(`kịch bản lạ: ${s}`);
  const runsPer = Number(args.runs ?? 30);
  const seed = Number(args.seed ?? 20261112);
  const concurrency = Number(args.concurrency ?? 10);
  if (![runsPer, seed, concurrency].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('--runs, --seed, --concurrency phải là số nguyên dương');
  }
  const gapFactor = 3; // RECONCILE_GAP_FACTOR mặc định của sản phẩm
  const timing = {
    ...DEFAULT_TIMING,
    ...(args['interval-s'] ? { intervalS: Number(args['interval-s']) } : {}),
    ...(args['grace-s'] ? { graceS: Number(args['grace-s']) } : {}),
    gapFactor,
  };
  timing.gapThresholdS = gapFactor * timing.intervalS;
  const batch = String(args.batch ?? `B${seed % 100000}`);
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(args.out ?? path.join(here, 'results', today), config);

  const s2QueueLostP = Number(args['s2-queue-lost-p'] ?? 0);
  if (!(s2QueueLostP >= 0 && s2QueueLostP <= 1))
    throw new Error('--s2-queue-lost-p phải trong 0..1');
  const plans = buildPlans({ seed, scenarios, runs: runsPer, timing, s2QueueLostP });
  const runs = buildRuns({ config, plans, batch });

  if (config === 'steve' && args['print-sql']) {
    for (const sql of registrationSql(runs)) console.log(`${sql};`);
    return;
  }

  // ---- Dựng / nối cấu hình ----------------------------------------------------------------
  let adapter;
  let local = null;
  let externalDb = null;
  const meta = { config, seed, batch, scenarios, runsPerScenario: runsPer, concurrency, timing };
  if (s2QueueLostP > 0) meta.exploratory = { s2QueueLostP };
  const cleanup = async () => {
    if (externalDb) await externalDb.end().catch(() => {});
    if (local) await local.stop();
  };
  const onSignal = () => {
    log('nhận tín hiệu dừng — dọn tiến trình…');
    void cleanup().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (config === 'steve') {
      const endpoint = args.url ?? 'ws://127.0.0.1:8180/steve/websocket/CentralSystemService';
      const composeFile = path.resolve(
        args['steve-compose'] ??
          path.join(REPO_ROOT, 'infra', 'lab', 'steve', 'docker-compose.yml'),
      );
      adapter = createSteveAdapter({
        query: dockerMariadbQuery({ composeFile }),
        endpoint,
        schema: args['steve-schema'] ?? 'evse',
      });
      meta.target = {
        kind: 'steve',
        endpoint,
        composeFile,
        schema: args['steve-schema'] ?? 'evse',
      };
    } else if (args.url) {
      if (!args['db-url']) throw new Error('--url với powerme* cần --db-url để đọc kết quả');
      externalDb = await connectDemoDb(args['db-url']);
      adapter = createPowermeAdapter({ db: externalDb, endpoint: args.url, name: config });
      // CSMS có sẵn: harness KHÔNG kiểm được RECONCILIATION_ENABLED / OFFLINE_GRACE_S của nó.
      meta.target = { kind: 'external', endpoint: args.url, envVerified: false };
    } else {
      mkdirSync(outDir, { recursive: true });
      local = await startLocalCsms({
        pgDir: path.resolve(args['pg-dir'] ?? path.join(os.tmpdir(), 'powerme-rq1-pg')),
        pgPort: Number(args['pg-port'] ?? 54490),
        ocppPort: Number(args['ocpp-port'] ?? 9190),
        reconciliationEnabled: config === 'powerme',
        timing,
        logFile: path.join(os.tmpdir(), `powerme-rq1-csms-${config}.log`),
        log,
      });
      adapter = createPowermeAdapter({ db: local.db, endpoint: local.endpoint, name: config });
      meta.target = { kind: 'local', endpoint: local.endpoint, env: local.env };
    }

    log(`đăng ký ${runs.length} trụ + thẻ (lô ${batch})…`);
    await adapter.prepare(runs);
    if (args['register-only']) {
      log('--register-only: xong.');
      return;
    }

    // ---- Chạy ------------------------------------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    const startedAt = new Date();
    let done = 0;
    const tasks = runs.map((run) => async () => {
      const station = new LabStation({
        endpoint: adapter.endpoint,
        identity: run.chargePoint,
        password: process.env.CP_PASSWORD,
        meterStartWh: run.plan.meterStartWh,
      });
      // Chặn trên cho một lần chạy: trụ treo không được giữ cả thí nghiệm.
      const budgetMs = 120_000 + run.plan.offlineS * 2000;
      const truth = await Promise.race([
        runScenario(station, run.plan, run.idTag),
        sleep(budgetMs).then(async () => {
          await station.drop();
          return null;
        }),
      ]);
      const finalTruth = truth ?? {
        eTrueWh: station.registerWh - station.meterStartWh,
        eStopWh: null,
        meterStartWh: station.meterStartWh,
        meterStopTrueWh: station.registerWh,
        meterStopSentWh: null,
        transactionIds: [],
        injectedFault: { kind: 'incomplete' },
        maxDeliveredGapS: null,
        startedAt: startedAt.toISOString(),
        durationS: budgetMs / 1000,
        error: `quá ${budgetMs / 1000} s — bỏ lần chạy`,
      };
      let collected;
      try {
        collected = await collectWhenSettled(adapter, run, { timeoutMs: 10_000 });
        // Mẫu phát bù đến sau StopTransaction có thể đổi kết luận (T13 #19): đọc lại sau một nhịp.
        await sleep(1000);
        collected = await adapter.collect(run);
      } catch (err) {
        collected = { sessions: [], error: `đọc kết quả lỗi: ${err?.message ?? err}` };
      }
      const row = buildRow({
        config,
        seed,
        run,
        truth: finalTruth,
        collected,
        gapThresholdS: timing.gapThresholdS,
      });
      done++;
      log(
        `${String(done).padStart(3)}/${runs.length} ${run.runId} → ${row.class}` +
          ` (status=${row.status ?? '-'} E_true=${row.E_true} E_stop=${row.E_stop ?? '-'}` +
          ` E_bill=${row.E_bill ?? '-'}${row.error ? ` LỖI: ${row.error}` : ''})`,
      );
      return row;
    });
    const rows = await pool(tasks, concurrency);
    const finishedAt = new Date();

    // ---- Ghi đầu ra -----------------------------------------------------------------------
    Object.assign(meta, {
      rows: rows.length,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallClockS: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
      git: gitInfo(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      tolWh: 1,
    });
    writeFileSync(path.join(outDir, 'rows.jsonl'), toJsonl(rows));
    writeFileSync(path.join(outDir, 'rows.csv'), toCsv(rows));
    writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(
      path.join(outDir, 'summary.md'),
      renderMarkdown(rows, { metas: [meta], title: `Kết quả RQ1 / NFR-02 — ${config}` }),
    );
    writeFileSync(
      path.join(outDir, 'summary.csv'),
      toCsv(summaryRows(summarizeAll(rows)), SUMMARY_COLUMNS),
    );
    log(`xong ${rows.length} lần chạy trong ${meta.wallClockS} s → ${outDir}`);
    for (const g of summarizeAll(rows)) {
      log(
        `  ${g.config} ${g.scenario}: đúng ${g.correct}/${g.n}` +
          ` (Wilson lo ${g.primaryLo === null ? '-' : (g.primaryLo * 100).toFixed(1)}%)` +
          ` sai im lặng ${g.silentWrong} giữ thừa ${g.counts.held_unnecessary}` +
          ` mất/trùng ${g.counts.lost_or_duplicate}`,
      );
    }
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
      console.error(`[rq1] LỖI: ${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
