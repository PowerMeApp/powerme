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
 *   --offline-extra-max-s N              phần cộng thêm tối đa trên ân hạn khi rút độ dài đứt (mặc định 9)
 *   --stagger-s N                        nghỉ tối thiểu giữa hai lần BẮT ĐẦU chạy (mặc định 0). SteVe cần
 *                                        > 0 khi chạy song song: nhiều trụ mới nối cùng lúc làm nó deadlock
 *   --hidden-site                        (powerme* + --url) đặt trụ ở trạm ẩn RQ1-LAB-01 của operator
 *                                        `suspended` thay vì HCM-DEMO-01, băm CP_PASSWORD làm credential
 *                                        cho từng trụ, và CẤT trụ sau khi chạy. Dùng cho staging (T130)
 *   --target-note <chữ>                  ghi chú về CSMS có sẵn (tag, biến môi trường đã kiểm tay) → meta.json
 * Biến môi trường: CP_PASSWORD (Basic Auth của trụ khi CSMS có sẵn yêu cầu).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDemoDb, CSMS_DIR } from '../../demo/db-embedded.mjs';
import { createPowermeAdapter, HIDDEN_SITE_CODE } from './adapters/powerme.mjs';
import { createSteveAdapter, dockerMariadbQuery, registrationSql } from './adapters/steve.mjs';
import { loadHasher } from '../nfr03/load-data.mjs';
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
    if (['register-only', 'print-sql', 'help', 'hidden-site'].includes(key)) out[key] = true;
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

/**
 * `pg.Client` tự nối lại: lần chạy qua SSH tunnel kéo dài cả giờ, tunnel rớt một lần không được làm
 * mất các dòng kết quả còn lại. Mỗi câu lệnh thử lại tối đa 5 lần (chỉ SELECT và các lệnh idempotent
 * của adapter đi qua đây; transaction của `prepare` / `park` hỏng giữa chừng thì ném lỗi như cũ).
 */
export async function resilientDb(url, { connect = connectDemoDb, onRetry = () => {} } = {}) {
  let client = await connect(url);
  client.on?.('error', () => {});
  let inTx = false;
  return {
    async query(sql, params) {
      const text = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await client.query(sql, params);
          if (text === 'BEGIN') inTx = true;
          if (text === 'COMMIT' || text === 'ROLLBACK') inTx = false;
          return res;
        } catch (err) {
          const lost =
            /ECONNRESET|ECONNREFUSED|EPIPE|terminat|Connection|not queryable|timeout/i.test(
              String(err?.message ?? err),
            );
          if (!lost || inTx || attempt >= 5) throw err;
          onRetry(attempt, err);
          await sleep(2000 * attempt);
          await client.end().catch(() => {});
          try {
            client = await connect(url);
            client.on?.('error', () => {});
          } catch {
            // lần thử kế tiếp sẽ nối lại
          }
        }
      }
    },
    end: () => client.end(),
  };
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
    ...(args['offline-extra-max-s']
      ? { offlineExtraMaxS: Number(args['offline-extra-max-s']) }
      : {}),
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
  const staggerS = Number(args['stagger-s'] ?? 0);
  if (!(staggerS >= 0)) throw new Error('--stagger-s phải ≥ 0');
  const meta = {
    config,
    seed,
    batch,
    scenarios,
    runsPerScenario: runsPer,
    concurrency,
    staggerS,
    timing,
  };
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
      externalDb = await resilientDb(args['db-url'], {
        onRetry: (n, err) => log(`DB mất kết nối (${err?.message ?? err}) — nối lại lần ${n}…`),
      });
      let hashPassword = null;
      if (args['hidden-site']) {
        if (!process.env.CP_PASSWORD) throw new Error('--hidden-site cần CP_PASSWORD');
        const hasher = await loadHasher();
        hashPassword = () => hasher(process.env.CP_PASSWORD);
      }
      adapter = createPowermeAdapter({
        db: externalDb,
        endpoint: args.url,
        name: config,
        ...(args['hidden-site'] ? { siteCode: HIDDEN_SITE_CODE, hashPassword } : {}),
      });
      // CSMS có sẵn: harness KHÔNG kiểm được RECONCILIATION_ENABLED / OFFLINE_GRACE_S của nó.
      meta.target = {
        kind: 'external',
        endpoint: args.url,
        envVerified: false,
        hiddenSite: Boolean(args['hidden-site']),
        ...(args['target-note'] ? { note: String(args['target-note']) } : {}),
      };
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
    // CSMS ở xa (staging): chờ kết quả lâu hơn vì có trễ mạng và đọc DB qua tunnel.
    const settleTimeoutMs = meta.target.kind === 'external' ? 30_000 : 10_000;
    let lastStartMs = 0;
    const parked = { attempted: 0, chargePoints: 0, errors: [] };
    const tasks = runs.map((run) => async () => {
      if (staggerS > 0) {
        // Đặt chỗ đồng bộ (không có await giữa đọc và ghi) nên hai lần chạy không trùng chỗ.
        const slot = Math.max(Date.now(), lastStartMs + staggerS * 1000);
        lastStartMs = slot;
        await sleep(slot - Date.now());
      }
      const station = new LabStation({
        endpoint: adapter.endpoint,
        identity: run.chargePoint,
        password: process.env.CP_PASSWORD,
        meterStartWh: run.plan.meterStartWh,
      });
      // Chặn trên cho một lần chạy: trụ treo không được giữ cả thí nghiệm.
      const p = run.plan;
      const budgetMs =
        120_000 + p.offlineS * 2000 + (p.preTicks + p.postTicks + 4) * p.intervalS * 1000;
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
        collected = await collectWhenSettled(adapter, run, { timeoutMs: settleTimeoutMs });
        // Mẫu phát bù đến sau StopTransaction có thể đổi kết luận (T13 #19): đọc lại sau một nhịp.
        await sleep(1000);
        collected = await adapter.collect(run);
      } catch (err) {
        collected = { sessions: [], error: `đọc kết quả lỗi: ${err?.message ?? err}` };
      }
      if (args['hidden-site'] && adapter.park) {
        // Cất NGAY sau khi đọc kết quả: trụ đã xong mà còn `in_service` quá 900 s sẽ bị mở sự cố Offline.
        parked.attempted++;
        try {
          const r = await adapter.park([run]);
          parked.chargePoints += r.chargePoints;
        } catch (err) {
          parked.errors.push(`${run.chargePoint}: ${err?.message ?? err}`);
        }
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
    if (parked.attempted) {
      meta.parked = parked;
      log(`đã cất trụ thí nghiệm: ${JSON.stringify(parked)}`);
    }

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
