/**
 * Đọc một thư mục kết quả NFR-03 và viết `summary.md` + `summary.csv`.
 *
 * Vì sao tách khỏi run.mjs: số server của lần chạy staging được đọc SAU, qua tunnel DB
 * (server-timings.mjs), và ai cũng phải tính lại được bảng từ dữ liệu thô đã commit mà không cần
 * CSMS (analyze.mjs). Cả ba lệnh gọi `writeSummary(dir)`.
 *
 * Đầu vào trong thư mục: `meta.json`, `client-rows.jsonl` (mỗi CALL trụ gửi một dòng), và nếu có
 * `server-rows.jsonl` (mỗi CALL CSMS nhận một dòng, từ `ocpp_message_log`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonl } from './cli.mjs';
import {
  ALL,
  joinClientServer,
  REQUIRED_DURATION_S,
  REQUIRED_STATIONS,
  summarize,
  THRESHOLD_MS,
  verdict as decide,
} from './stats.mjs';

const fmt = (ms, digits = 1) => {
  if (ms === null || ms === undefined) return '–';
  if (ms === Infinity) return '∞';
  return ms.toFixed(digits).replace('.', ',');
};
const yesNo = (ok) => (ok ? 'ĐẠT' : 'KHÔNG ĐẠT');

/** Tính mọi bảng của một lần chạy từ dữ liệu thô. */
export function analyze({ meta, clientRows, serverRows }) {
  const client = summarize(
    clientRows.map((r) => ({ action: r.action, ms: r.ms, error: r.outcome === 'callerror' })),
  );
  const server = serverRows
    ? summarize(
        serverRows.map((r) => ({ action: r.action, ms: r.ms, error: r.result === 'callerror' })),
      )
    : null;
  const join = serverRows ? joinClientServer(clientRows, serverRows) : null;
  const overhead = join ? summarize(join.joined) : null;
  const outcomes = {};
  for (const r of clientRows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const result = decide({
    client,
    server,
    stationsRequested: meta.params.stations,
    stationsConnected: meta.stations.connected,
    durationS: meta.params.durationS,
  });
  return {
    client,
    server,
    overhead,
    outcomes,
    clientOnly: join?.clientOnly ?? null,
    verdict: result,
  };
}

function table(summary, digits) {
  const lines = [
    '| Bản tin | n | Không được trả lời | CALLERROR | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | p95 ≤ 1 s |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const s of summary) {
    const name = s.action === ALL ? `**${ALL}**` : s.action;
    const p95 = s.action === ALL ? `**${fmt(s.p95Ms, digits)}**` : fmt(s.p95Ms, digits);
    lines.push(
      `| ${name} | ${s.n} | ${s.unanswered} | ${s.callErrors} | ${fmt(s.p50Ms, digits)} | ${p95} | ` +
        `${fmt(s.p99Ms, digits)} | ${fmt(s.maxMs, digits)} | ${yesNo(s.penalizedP95Ms <= THRESHOLD_MS)} |`,
    );
  }
  return lines.join('\n');
}

export function renderMarkdown({ meta, analysis }) {
  const { client, server, overhead, outcomes, clientOnly, verdict } = analysis;
  const local = meta.target.kind === 'local';
  const st = meta.stations;
  const out = [];
  out.push(`# Kết quả đo NFR-03 / NFR-OCPP-01: ${meta.label}`, '');
  out.push(
    '> Sinh tự động bởi `lab/nfr03` từ `client-rows.jsonl`' +
      (server ? ' và `server-rows.jsonl`' : '') +
      '. Tính lại: `node lab/nfr03/analyze.mjs <thư mục này>`.',
    '',
  );
  if (local) {
    out.push(
      `> **Số đo LOCAL, chưa phải staging.** CSMS, Postgres nhúng và ${meta.params.stations} trụ giả chạy trên cùng một máy ` +
        'dev qua loopback (không TLS, không Caddy, không trễ mạng). Cam kết BM04 là đo trên staging; ' +
        'lần chạy này chứng minh dụng cụ đo và cho một con số tham khảo.',
      '',
    );
  }
  out.push('## Kết luận', '');
  out.push(
    `Ngưỡng: p95 thời gian CSMS trả lời một CALL của trụ ≤ ${THRESHOLD_MS} ms, với ${REQUIRED_STATIONS} trụ giả trong ${REQUIRED_DURATION_S} s.`,
    '',
  );
  out.push('| Số đo | p95 gộp mọi bản tin (ms) | So ngưỡng |', '|---|---:|---|');
  out.push(
    `| Phía server (\`ocpp_message_log\`) | ${verdict.server ? fmt(verdict.server.p95Ms, 0) : 'chưa đọc'} | ${verdict.server ? yesNo(verdict.server.pass) : '–'} |`,
  );
  out.push(
    `| Phía client (trụ giả, gồm cả mạng) | ${fmt(verdict.client?.p95Ms)} | ${verdict.client ? yesNo(verdict.client.pass) : '–'} |`,
    '',
  );
  out.push(`**Lần chạy này: ${verdict.overall}.**`);
  const failing = [
    ...(verdict.server?.failingActions ?? []).map((a) => `${a} (server)`),
    ...(verdict.client?.failingActions ?? []).map((a) => `${a} (client)`),
  ];
  if (failing.length) out.push('', `Loại bản tin tự nó vượt ngưỡng: ${failing.join(', ')}.`);
  const notes = [...verdict.caveats];
  if (local) notes.push('đo local, không phải staging');
  if (notes.length) {
    out.push('', `Chưa dùng được làm số chính thức của NFR-03 vì: ${notes.join('; ')}.`);
  }
  out.push('');

  out.push('## Tải đã chạy', '');
  out.push('| | |', '|---|---|');
  out.push(`| Đích | \`${meta.target.endpoint}\` (${meta.target.kind}) |`);
  out.push(
    `| Trụ | ${st.connected}/${meta.params.stations} nối được; ${st.connectFailures} lần bắt tay bị từ chối; ${st.disconnects} lần rớt kết nối giữa chừng |`,
  );
  out.push(
    `| Thời gian | nối dần ${fmt(meta.params.rampS, 0)} s + tải ${meta.params.durationS} s; cả lần chạy ${meta.wallClockS} s (${meta.startedAt} → ${meta.finishedAt}) |`,
  );
  out.push(
    `| Hồ sơ | MeterValues mỗi ${meta.params.meterIntervalS} s; Heartbeat mỗi ${st.heartbeatS} s; phiên ${meta.params.profile.ticksMin}–${meta.params.profile.ticksMax} nhịp, nghỉ ${meta.params.profile.idleMinS}–${meta.params.profile.idleMaxS} s; seed ${meta.params.seed} |`,
  );
  out.push(
    `| Phiên sạc | ${st.sessionsStarted} bắt đầu, ${st.sessionsStopped} dừng xong; ${st.authorizeNotAccepted} lần Authorize không Accepted |`,
  );
  const total = client.find((s) => s.action === ALL);
  out.push(
    `| Bản tin trụ gửi | ${total?.n ?? 0} CALL (${((total?.n ?? 0) / meta.wallClockS || 0).toFixed(1).replace('.', ',')} CALL/s trung bình): ` +
      Object.entries(outcomes)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') +
      ' |',
  );
  if (meta.eventLoopDelayMs) {
    out.push(
      `| Độ trễ vòng lặp của bộ sinh tải | p50 ${fmt(meta.eventLoopDelayMs.p50)} ms, p99 ${fmt(meta.eventLoopDelayMs.p99)} ms, max ${fmt(meta.eventLoopDelayMs.max)} ms (chỉ báo bộ sinh tải có nghẽn không; trên Windows mức nền khoảng 15 ms là độ mịn timer của hệ điều hành) |`,
    );
  }
  out.push('');

  out.push('## Phía server: thời gian CSMS giữ bản tin', '');
  if (server) {
    out.push(
      'Từ `ocpp_message_log`: `received_at` của CALLRESULT/CALLERROR chiều ra trừ `received_at` của CALL chiều vào, ghép theo (trụ, epoch, unique_id). Độ phân giải 1 ms. Không gồm mạng, TLS, proxy.',
      '',
      table(server, 0),
      '',
    );
    if (clientOnly) {
      out.push(
        `${clientOnly} CALL trụ đã gửi không có trong log của CSMS (không tới nơi, hoặc nằm ngoài cửa sổ đọc).`,
        '',
      );
    }
  } else {
    out.push(
      'Chưa đọc. Chạy `node lab/nfr03/server-timings.mjs --dir <thư mục này>` với `NFR03_DB_URL` trỏ vào Postgres của CSMS được đo.',
      '',
    );
  }

  out.push('## Phía client: từ lúc trụ gửi CALL tới lúc nhận trả lời', '');
  out.push(
    'Đo trong tiến trình bộ sinh tải, từ ngay sau `ws.send()` tới khi frame trả lời về. Gồm mạng hai chiều, TLS/proxy (nếu có) và độ trễ của chính bộ sinh tải.',
    '',
    table(client, 1),
    '',
  );

  if (overhead) {
    out.push('## Chênh lệch client − server của cùng một bản tin', '');
    out.push(
      'Phần số đo server không thấy: mạng, TLS/proxy, bộ đệm socket, độ trễ của bộ sinh tải.',
      '',
      '| Bản tin | n | p50 (ms) | p95 (ms) | max (ms) |',
      '|---|---:|---:|---:|---:|',
      ...overhead.map(
        (s) =>
          `| ${s.action === ALL ? `**${ALL}**` : s.action} | ${s.answered} | ${fmt(s.p50Ms)} | ${fmt(s.p95Ms)} | ${fmt(s.maxMs)} |`,
      ),
      '',
    );
  }

  if (meta.footprint) {
    const f = meta.footprint;
    out.push('## Dữ liệu trụ tải để lại trong DB (cộng dồn mọi lần chạy)', '');
    out.push('| Bảng | Số dòng |', '|---|---:|');
    for (const key of [
      'ocpp_message_log',
      'meter_values',
      'sessions',
      'session_status_history',
      'reconciliation_records',
      'connector_status_events',
      'charge_point_connections',
      'remote_commands',
      'fault_events',
      'session_debits',
    ]) {
      out.push(`| \`${key}\` | ${f[key]} |`);
    }
    out.push(
      '',
      `Phiên theo trạng thái: ${
        Object.entries(f.sessions_by_status ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(', ') || 'không có'
      }.`,
      '',
    );
  }

  out.push('## Môi trường', '');
  out.push('| | |', '|---|---|');
  out.push(
    `| Commit | \`${meta.git.commit ?? '?'}\` (${meta.git.branch ?? '?'}${meta.git.dirty ? ', src/ có sửa chưa commit' : ''}) |`,
  );
  out.push(
    `| Máy bắn tải | ${meta.machine.cpuModel}, ${meta.machine.logicalCpus} luồng, ${meta.machine.totalMemGb} GB RAM, ${meta.machine.os}, Node ${meta.machine.node} |`,
  );
  if (meta.target.env) {
    out.push(
      `| CSMS (local) | ${Object.entries(meta.target.env)
        .map(([k, v]) => `\`${k}=${v}\``)
        .join(' ')} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

const CSV_COLUMNS = [
  'side',
  'action',
  'n',
  'answered',
  'unanswered',
  'call_errors',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'max_ms',
  'mean_ms',
  'p95_with_unanswered_ms',
  'threshold_ms',
  'pass',
];

export function renderCsv(analysis) {
  const num = (x) => (x === null || x === undefined ? '' : x === Infinity ? 'inf' : x.toFixed(2));
  const lines = [CSV_COLUMNS.join(',')];
  for (const [side, summary] of [
    ['server', analysis.server],
    ['client', analysis.client],
  ]) {
    for (const s of summary ?? []) {
      lines.push(
        [
          side,
          s.action === ALL ? 'ALL' : s.action,
          s.n,
          s.answered,
          s.unanswered,
          s.callErrors,
          num(s.p50Ms),
          num(s.p95Ms),
          num(s.p99Ms),
          num(s.maxMs),
          num(s.meanMs),
          num(s.penalizedP95Ms),
          THRESHOLD_MS,
          s.penalizedP95Ms <= THRESHOLD_MS ? 'true' : 'false',
        ].join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Đọc thư mục kết quả, ghi summary.md + summary.csv, trả phân tích. */
export function writeSummary(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const clientRows = readJsonl(path.join(dir, 'client-rows.jsonl'));
  if (!clientRows) throw new Error(`thiếu ${path.join(dir, 'client-rows.jsonl')}`);
  const serverRows = readJsonl(path.join(dir, 'server-rows.jsonl'));
  const analysis = analyze({ meta, clientRows, serverRows });
  writeFileSync(path.join(dir, 'summary.md'), renderMarkdown({ meta, analysis }));
  writeFileSync(path.join(dir, 'summary.csv'), renderCsv(analysis));
  return analysis;
}
