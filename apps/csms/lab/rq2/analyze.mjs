/**
 * Tổng hợp kết quả RQ2 (T142) từ một hoặc nhiều rows.jsonl — không cần CSMS hay DB.
 *
 *   node lab/rq2/analyze.mjs <rows.jsonl>... [--out <thư mục>]
 *
 * Nhiều file của cùng một kịch bản (một lượt bị dừng vì hạn mức rồi chạy tiếp tối sau, Q14) được
 * gộp theo số thứ tự request k; trùng k thì dòng đọc sau thắng. Ghi summary.md + summary.csv.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wilson } from '../rq1/metrics.mjs';
import { verdict } from './score.mjs';

/** Q13: tỉ lệ `brief` vượt ngưỡng này thì ghi cảnh báo. */
export const BRIEF_WARN = 0.2;

export function readRows(files) {
  const byKey = new Map();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.phase !== 'request') continue;
      byKey.set(`${row.scenario}|${row.k}`, row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.k - b.k);
}

export function stats(values) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, mean: null, median: null, p90: null };
  const at = (q) => xs[Math.max(0, Math.ceil(xs.length * q) - 1)];
  const mid = xs.length / 2;
  return {
    n: xs.length,
    mean: round2(xs.reduce((s, x) => s + x, 0) / xs.length),
    median: round2(xs.length % 2 ? xs[Math.floor(mid)] : (xs[mid - 1] + xs[mid]) / 2),
    p90: round2(at(0.9)),
  };
}

export function verdicts(deltas) {
  const counts = { win: 0, tie: 0, loss: 0 };
  for (const d of deltas) {
    const v = verdict(d);
    if (v) counts[v]++;
  }
  const n = counts.win + counts.tie + counts.loss;
  const w = wilson(counts.win, n);
  return {
    n,
    ...counts,
    win_rate: w.p === null ? null : round3(w.p),
    win_lo: round3(w.lo),
    win_hi: round3(w.hi),
  };
}

function group(rows) {
  const pick = (side, field) => rows.map((r) => r[side][field]);
  const out = {};
  for (const metric of ['start_min', 'target_min']) {
    out[metric] = {
      smart: stats(pick('smart', metric)),
      baseline: stats(pick('baseline', metric)),
      delta: stats(rows.map((r) => r[`delta_${metric}`])),
      verdicts: verdicts(rows.map((r) => r[`delta_${metric}`])),
    };
  }
  return out;
}

export function summarize(rows) {
  const scenarios = {};
  for (const name of [...new Set(rows.map((r) => r.scenario))]) {
    const rs = rows.filter((r) => r.scenario === name);
    const brief = rs.filter((r) => r.ranking_source === 'brief').length;
    const viaRoute = rs.filter((r) => r.ranking_source === 'vietmap_route');
    const withRoad = rs.filter((r) => r.road);
    scenarios[name] = {
      requests: rs.length,
      route_calls: rs.reduce((s, r) => s + (r.route_calls ?? 0), 0),
      brief,
      brief_rate: rs.length ? round3(brief / rs.length) : null,
      brief_warning: rs.length > 0 && brief / rs.length > BRIEF_WARN,
      same_station: rs.filter((r) => r.smart.site_id === r.baseline.site_id).length,
      detours: {
        smart: rs.filter((r) => r.smart.detour).length,
        baseline: rs.filter((r) => r.baseline.detour).length,
      },
      all: group(rs),
      vietmap_route_only: group(viaRoute),
      road_secondary: {
        n: withRoad.length,
        delta_start_min: stats(withRoad.map((r) => r.road.delta_start_min)),
        delta_target_min: stats(withRoad.map((r) => r.road.delta_target_min)),
        verdicts: verdicts(withRoad.map((r) => r.road.delta_target_min)),
      },
    };
  }
  return scenarios;
}

const fmt = (x) => (x === null || x === undefined ? '—' : String(x));
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)} %`);

export function toMarkdown(summary, sources = []) {
  const lines = ['# RQ2 — Station Suggestion so với nearest compatible station', ''];
  if (sources.length) lines.push(`Nguồn: ${sources.map((s) => `\`${s}\``).join(', ')}`, '');
  lines.push(
    'Delta = baseline − smart (phút; dương = smart nhanh hơn). Thắng / hoà / thua theo ±1 phút; khoảng tin cậy Wilson 95 % cho tỉ lệ thắng. Chỉ số chính chấm lái xe bằng đường thẳng BR-P41 cho cả hai bên.',
    '',
  );
  for (const [name, s] of Object.entries(summary)) {
    lines.push(`## ${name}`, '');
    lines.push(
      `Request: **${s.requests}** · Route Vietmap: ${s.route_calls} · \`brief\`: ${s.brief} (${pct(s.brief_rate)})${s.brief_warning ? ' ⚠ vượt 20 %' : ''} · cùng trạm: ${s.same_station} · đi vòng: smart ${s.detours.smart}, baseline ${s.detours.baseline}`,
      '',
    );
    for (const [label, g] of [
      ['Tất cả request', s.all],
      ['Chỉ request `vietmap_route`', s.vietmap_route_only],
    ]) {
      lines.push(`### ${label}`, '');
      lines.push('| Chỉ số | Bên | n | TB | Trung vị | p90 |', '|---|---|---|---|---|---|');
      for (const [metric, title] of [
        ['start_min', 'Time until charging starts'],
        ['target_min', 'Time until charged'],
      ]) {
        for (const side of ['smart', 'baseline', 'delta']) {
          const x = g[metric][side];
          lines.push(
            `| ${title} | ${side} | ${x.n} | ${fmt(x.mean)} | ${fmt(x.median)} | ${fmt(x.p90)} |`,
          );
        }
      }
      lines.push(
        '',
        '| Chỉ số | n | Thắng | Hoà | Thua | Tỉ lệ thắng [Wilson 95 %] |',
        '|---|---|---|---|---|---|',
      );
      for (const [metric, title] of [
        ['start_min', 'Time until charging starts'],
        ['target_min', 'Time until charged'],
      ]) {
        const v = g[metric].verdicts;
        lines.push(
          `| ${title} | ${v.n} | ${v.win} | ${v.tie} | ${v.loss} | ${pct(v.win_rate)} [${pct(v.win_lo)}, ${pct(v.win_hi)}] |`,
        );
      }
      lines.push('');
    }
    const r = s.road_secondary;
    lines.push(
      '### Chỉ số phụ — lái xe theo Vietmap (cả hai trạm có road_estimate)',
      '',
      `n = ${r.n} · delta Time until charged: TB ${fmt(r.delta_target_min.mean)}, trung vị ${fmt(r.delta_target_min.median)} · thắng ${r.verdicts.win} / hoà ${r.verdicts.tie} / thua ${r.verdicts.loss}`,
      '',
    );
  }
  return lines.join('\n');
}

export function toCsv(summary) {
  const rows = [['scenario', 'subset', 'metric', 'side', 'n', 'mean', 'median', 'p90']];
  for (const [name, s] of Object.entries(summary))
    for (const [subset, g] of [
      ['all', s.all],
      ['vietmap_route', s.vietmap_route_only],
    ])
      for (const metric of ['start_min', 'target_min'])
        for (const side of ['smart', 'baseline', 'delta']) {
          const x = g[metric][side];
          rows.push([name, subset, metric, side, x.n, x.mean, x.median, x.p90]);
        }
  return rows.map((r) => r.map((v) => (v === null ? '' : v)).join(',')).join('\n') + '\n';
}

export function writeSummary(files, outDir) {
  const summary = summarize(readRows(files));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'summary.md'),
    toMarkdown(
      summary,
      files.map((f) => path.relative(outDir, f)),
    ) + '\n',
  );
  writeFileSync(path.join(outDir, 'summary.csv'), toCsv(summary));
  return summary;
}

const round2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const round3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  if (!positionals.length) {
    console.error('Cách dùng: node lab/rq2/analyze.mjs <rows.jsonl>... [--out <thư mục>]');
    process.exit(2);
  }
  const out = values.out ?? path.dirname(positionals[0]);
  const summary = writeSummary(positionals, out);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Đã ghi ${path.join(out, 'summary.md')}`);
}
