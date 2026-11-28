#!/usr/bin/env node
// T112: đếm test case Report 5 (docs/testing/report5-test-cases.csv) đã có test tự động.
//
// Quét tĩnh tên test, không chạy test: CI đã chạy mọi test, CI xanh nghĩa là test có mã đều pass.
// Chỉ tính mã nằm trong chuỗi tên của it / test / describe (Dart: test / testWidgets / group),
// hoặc trong bảng của .each khi tên có placeholder. Comment, test bị skip thì không tính.
// Cách dùng và quy ước: docs/testing/README.md.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV = 'docs/testing/report5-test-cases.csv';
export const TARGET = 73;

export const CODE_RE =
  /TC-(?:F\d{2}-\d{2}|WF\d{2}|NFR-\d{2}|STM\d+-t?\d+[a-z]?)(?:\/t?\d+[a-z]?)*(?![\w-])/g;

/** `TC-STM4-12/13` → hai mã; mỗi phần sau `/` thay số cuối của mã đầu. */
export function expandCode(raw) {
  const [first, ...rest] = raw.split('/');
  const prefix = first.slice(0, first.lastIndexOf('-') + 1);
  return [first, ...rest.map((p) => prefix + p)];
}

/** Dạng so khớp: bỏ `t` sau dấu gạch, bỏ số 0 đầu (`TC-STM6-t01` ≡ `TC-STM6-1`). */
export const normalizeCode = (code) =>
  code.replace(/-t(?=\d)/g, '-').replace(/\d+/g, (d) => String(Number(d)));

export function findCodes(text) {
  return [...text.matchAll(CODE_RE)].flatMap((m) =>
    expandCode(m[0]).map((code) => ({ code, index: m.index })),
  );
}

/**
 * Bỏ comment (thay bằng dấu cách, giữ offset / số dòng) và thu mọi chuỗi literal.
 * TS: '…' "…" `…${…}` và regex literal; Dart: '…' "…" '''…''' r'…' và ${…}.
 */
export function lex(src, dart = false) {
  const out = src.split('');
  const strings = [];
  const n = src.length;
  let prev = '';
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const skipRegex = (i) => {
    let inClass = false;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === '\n') return i + 1;
      if (c === '\\') j++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        while (/[a-z]/i.test(src[j + 1] ?? '')) j++;
        return j + 1;
      }
    }
    return i + 1;
  };
  const scanString = (i, raw) => {
    const q = src[i];
    const qlen = dart && src.startsWith(q.repeat(3), i) ? 3 : 1;
    const close = q.repeat(qlen);
    const interp = !raw && (q === '`' || dart);
    let j = i + qlen;
    while (j < n) {
      const c = src[j];
      if (!raw && c === '\\') j += 2;
      else if (interp && c === '$' && src[j + 1] === '{') j = scanCode(j + 2, true);
      else if (src.startsWith(close, j)) break;
      else if (c === '\n' && q !== '`' && qlen === 1) break;
      else j++;
    }
    const end = Math.min(j + qlen, n);
    strings.push({
      start: raw ? i - 1 : i,
      valueStart: i + qlen,
      value: src.slice(i + qlen, j),
      end,
    });
    return end;
  };
  const scanCode = (i, stopAtBrace) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && (d === '/' || d === '*')) {
        const e = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
        const end = e < 0 ? n : d === '/' ? e : e + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (!dart && c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
        i = skipRegex(i);
        prev = ')';
        continue;
      }
      const raw = dart && c === 'r' && (d === "'" || d === '"') && !/[\w$]/.test(src[i - 1] ?? '');
      if (raw || c === "'" || c === '"' || (c === '`' && !dart)) {
        i = scanString(raw ? i + 1 : i, raw);
        prev = '"';
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (stopAtBrace && depth === 0) return i + 1;
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return i;
  };
  scanCode(0, false);
  return { code: out.join(''), strings };
}

// Alias kiểu `const describeDb = DATABASE_URL ? describe : describe.skip`: CI có Postgres nên
// điều kiện DB coi là chạy; điều kiện khác (vd. cấu hình SePay của live test) coi là bị skip.
const DB_CONDITIONS = new Set(['DATABASE_URL', 'url', 'process.env.DATABASE_URL']);
const ALIAS_RE =
  /(?:const|let|var)\s+([\w$]+)\s*=\s*\(?\s*([\w$.]+)\s*\)?\s*\?\s*(describe|it|test)\s*:\s*\3\.skip\b/g;
const PLACEHOLDER_RE = /%[sdifjop#%]|\$[\w.]+/;
const SKIP_MODS = new Set(['skip', 'todo']);

/** Trả mọi mã trong tên test của một file: { code, line, skipped }. */
export function scanSource(src, dart = false) {
  const { code, strings } = lex(src, dart);
  const inString = new Uint8Array(src.length);
  const stringAt = new Map();
  for (const s of strings) {
    inString.fill(1, s.start, s.end);
    stringAt.set(s.start, s);
  }
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const closeOf = (open) => {
    const pair = { '(': ')', '[': ']', '{': '}' }[code[open]];
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (inString[i]) continue;
      if (code[i] === code[open]) depth++;
      else if (code[i] === pair && --depth === 0) return i;
    }
    return code.length - 1;
  };
  const skipWs = (i) => {
    while (/\s/.test(code[i] ?? '')) i++;
    return i;
  };

  const aliases = new Map();
  if (!dart) for (const m of code.matchAll(ALIAS_RE)) aliases.set(m[1], DB_CONDITIONS.has(m[2]));
  const names = dart
    ? 'test|testWidgets|group'
    : ['x?(?:it|test|describe)', ...aliases.keys()].join('|');
  const mods = '(?:\\s*\\.\\s*(?:each|skip|only|concurrent|todo|skipIf|runIf|sequential|fails))*';
  const inline = dart
    ? ''
    : '|\\(\\s*([\\w$.]+)\\s*\\?\\s*(?:describe|it|test)\\s*:\\s*\\w+\\.skip\\s*\\)';
  const headRe = new RegExp(`(?<![\\w$.])(?:(${names})(${mods})${inline})\\s*(?=[(\`<])`, 'g');

  const calls = [];
  for (const m of code.matchAll(headRe)) {
    if (inString[m.index]) continue;
    const modList = (m[2] ?? '')
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean);
    let skipped = m[1]?.startsWith('x') || modList.some((x) => SKIP_MODS.has(x));
    if (m[1] && aliases.has(m[1])) skipped ||= !aliases.get(m[1]);
    if (m[3] !== undefined) skipped ||= !DB_CONDITIONS.has(m[3]);
    let i = m.index + m[0].length;
    if (code[i] === '<') i = skipWs(closeAngle(code, i) + 1);
    let table = null;
    if (modList.includes('each')) {
      if (code[i] === '`') {
        const s = stringAt.get(i);
        table = [i, s.valueStart + s.value.length];
        i = skipWs(table[1] + 1);
      } else {
        const close = closeOf(i);
        const arg = code.slice(i + 1, close).trim();
        if (/^[\w$]+$/.test(arg)) {
          const decl = new RegExp(`(?:const|let|var)\\s+${arg.replace('$', '\\$')}\\b[^=]*=\\s*`);
          const d = decl.exec(code);
          const open = d ? code.indexOf('[', d.index + d[0].length) : -1;
          if (open >= 0) table = [open, closeOf(open)];
        } else table = [i, close];
        i = skipWs(close + 1);
      }
    }
    if (modList.some((x) => x === 'skipIf' || x === 'runIf')) i = skipWs(closeOf(i) + 1);
    if (code[i] !== '(') continue;
    const end = closeOf(i);
    if (dart) skipped ||= /,\s*skip\s*:/.test(topLevel(code, inString, i, end));
    const name = stringAt.get(skipWs(i + 1));
    calls.push({ start: m.index, end, skipped, name, table });
  }

  const found = [];
  for (const c of calls) {
    const skipped =
      c.skipped || calls.some((o) => o.skipped && o.start < c.start && c.start < o.end);
    if (!c.name) continue;
    const sources = [c.name];
    if (c.table && PLACEHOLDER_RE.test(c.name.value))
      sources.push(...strings.filter((s) => s.start > c.table[0] && s.start < c.table[1]));
    for (const s of sources)
      for (const { code: tc, index } of findCodes(s.value))
        found.push({ code: tc, line: lineOf(s.valueStart + index), skipped });
  }
  return found;
}

/** Bỏ qua tham số kiểu `it.each<[A, B]>(`. */
function closeAngle(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '<') depth++;
    else if (code[i] === '>' && code[i - 1] !== '=' && --depth === 0) return i;
  }
  return open;
}

/** Phần của (open, close) ở độ sâu 1, để `skip:` của test con không tính cho group cha. */
function topLevel(code, inString, open, close) {
  let depth = 0;
  let out = '';
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (!inString[i] && '([{'.includes(c)) depth++;
    if (depth === 0) out += c;
    if (!inString[i] && ')]}'.includes(c)) depth--;
  }
  return out;
}

export function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted && c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
      else if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) (cells.push(cur), (cur = ''));
      else cur += c;
    }
    rows.push([...cells, cur]);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const TEST_FILE = /(\.spec\.ts|\.test\.tsx?)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.dart_tool']);

export function listTestFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) !SKIP_DIRS.has(e.name) && walk(rel);
      else if (
        TEST_FILE.test(e.name) ||
        (/_test\.dart$/.test(e.name) && rel.startsWith('apps/mobile/test/'))
      )
        files.push(rel);
    }
  };
  walk('apps');
  return files.sort();
}

export function buildReport(cases, occurrences) {
  const byKey = new Map(cases.map((c) => [normalizeCode(c.id), { ...c, locations: [] }]));
  const unknown = new Map();
  const skipped = [];
  for (const o of occurrences) {
    const loc = `${o.file}:${o.line}`;
    if (o.skipped) skipped.push({ code: o.code, loc });
    else if (byKey.has(normalizeCode(o.code))) byKey.get(normalizeCode(o.code)).locations.push(loc);
    else unknown.set(o.code, [...(unknown.get(o.code) ?? []), loc]);
  }
  const all = [...byKey.values()];
  const ci = all.filter((c) => c.run === 'CI');
  const group = (key) => {
    const m = new Map();
    for (const c of ci) {
      const g = m.get(c[key]) ?? { covered: 0, total: 0, missing: [] };
      g.total++;
      if (c.locations.length) g.covered++;
      else g.missing.push(c.id);
      m.set(c[key], g);
    }
    return Object.fromEntries(m);
  };
  return {
    covered: ci.filter((c) => c.locations.length).length,
    ciTotal: ci.length,
    total: all.length,
    target: TARGET,
    bySheet: group('sheet'),
    byOwner: group('owner'),
    nonCiWithTests: all.filter((c) => c.run !== 'CI' && c.locations.length),
    unknown: Object.fromEntries([...unknown].sort()),
    skipped,
    cases: all,
  };
}

export function toMarkdown(r, verbose = false) {
  const L = [`## Test case Report 5 (T112)`, ''];
  L.push(
    `**Ca CI có test tự động: ${r.covered} / ${r.ciTotal}** (tổng ${r.total} ca, mục tiêu ${r.target})`,
  );
  for (const [title, key] of [
    ['sheet', 'bySheet'],
    ['owner', 'byOwner'],
  ]) {
    L.push(
      '',
      `### Theo ${title}`,
      '',
      `| ${title} | Có test | Ca CI | Chưa có test |`,
      '|---|---|---|---|',
    );
    for (const [k, g] of Object.entries(r[key]))
      L.push(`| ${k} | ${g.covered} | ${g.total} | ${g.total - g.covered} |`);
  }
  L.push('', '### Ca CI chưa có test', '');
  for (const [owner, g] of Object.entries(r.byOwner))
    if (g.missing.length) L.push(`- **${owner}** (${g.missing.length}): ${g.missing.join(', ')}`);
  const loc = (locs) => (verbose ? ` — ${locs.join(', ')}` : '');
  if (r.nonCiWithTests.length) {
    L.push('', '### Ca Man / Stg có test tự động (không cộng vào tổng)', '');
    for (const c of r.nonCiWithTests) L.push(`- ${c.id} (${c.run})${loc(c.locations)}`);
  }
  if (Object.keys(r.unknown).length) {
    L.push('', '### ⚠️ Mã trong test nhưng không có trong CSV', '');
    for (const [code, locs] of Object.entries(r.unknown)) L.push(`- ${code}${loc(locs)}`);
  }
  if (r.skipped.length) {
    L.push('', '### Mã trong test bị skip (không tính)', '');
    for (const s of r.skipped) L.push(`- ${s.code} — ${s.loc}`);
  }
  if (verbose) {
    L.push('', '### Vị trí từng ca', '');
    for (const c of r.cases) if (c.locations.length) L.push(`- ${c.id}: ${c.locations.join(', ')}`);
  }
  return L.join('\n') + '\n';
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const minAt = argv.indexOf('--min');
  const min = minAt >= 0 ? Number(argv[minAt + 1]) : null;
  if (minAt >= 0 && !Number.isInteger(min)) throw new Error('--min cần một số nguyên');
  const cases = parseCsv(readFileSync(path.join(root, CSV), 'utf8'));
  const occurrences = listTestFiles(root).flatMap((file) =>
    scanSource(readFileSync(path.join(root, file), 'utf8'), file.endsWith('.dart')).map((o) => ({
      ...o,
      file,
    })),
  );
  const report = buildReport(cases, occurrences);
  const md = toMarkdown(report, argv.includes('--verbose'));
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (min !== null && report.covered < min) {
    console.error(`tc-coverage: ${report.covered} ca CI có test < --min ${min}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
