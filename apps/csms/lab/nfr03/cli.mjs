/**
 * Phần dùng chung của các lệnh trong lab/nfr03: đọc tham số, lấy chuỗi kết nối Postgres mà không để
 * mật khẩu lọt ra đầu ra, đọc/ghi các file kết quả.
 *
 * Vì sao tồn tại: năm lệnh (run, server-timings, analyze, seed-load, teardown-load) cùng cần mấy
 * việc này, và cùng một quy tắc: BÍ MẬT CHỈ ĐI QUA BIẾN MÔI TRƯỜNG. `--db-url` vẫn được nhận cho tiện
 * (DB cục bộ), nhưng với staging nên dùng `NFR03_DB_URL` để mật khẩu `app_dev` không nằm trong lịch
 * sử shell; mật khẩu trụ thì chỉ có `LOAD_CP_PASSWORD`, không có tham số dòng lệnh nào.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CSMS_DIR } from '../../demo/db-embedded.mjs';

export const REPO_ROOT = path.resolve(CSMS_DIR, '..', '..');

/** `--khoá giá-trị` → đối tượng; `flags` là các khoá không có giá trị. Khoá lạ thì ném lỗi. */
export function parseArgs(argv, { values = [], flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (flags.includes(key)) out[key] = true;
    else if (values.includes(key)) {
      if (i + 1 >= argv.length) throw new Error(`--${key} thiếu giá trị`);
      out[key] = argv[++i];
    } else throw new Error(`tham số lạ: ${a}`);
  }
  return out;
}

/** Chuỗi kết nối Postgres: `--db-url`, rồi `NFR03_DB_URL`. Không đọc DATABASE_URL (dễ trỏ nhầm DB). */
export function dbUrlFrom(args, env = process.env) {
  return args['db-url'] || env.NFR03_DB_URL || null;
}

/** Bỏ user:password khỏi một URL để ghi vào meta/log. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(url không đọc được)';
  }
}

export function gitInfo() {
  const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try {
    return {
      commit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      // Chỉ xét mã CSMS chạy thật (src/, drizzle/): sửa dụng cụ đo không làm đổi CSMS được đo.
      dirty: git('status', '--porcelain', '--', 'apps/csms/src', 'apps/csms/drizzle').length > 0,
    };
  } catch {
    return { commit: null, branch: null, dirty: null };
  }
}

/** Máy chạy bộ sinh tải (và, ở chế độ local, cả CSMS + Postgres). */
export function machineInfo() {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model?.trim() ?? null,
    logicalCpus: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

export function readJsonl(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/** Ghi JSON theo đúng định dạng Prettier của repo (CI chạy `prettier --check .` trên cả kết quả). */
export async function writeJson(file, value) {
  let text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(file)) ?? {};
    text = await prettier.format(text, { ...config, parser: 'json' });
  } catch {
    // Không có prettier (máy chỉ cài dependency production): chạy `npx prettier --write` trước khi commit.
  }
  writeFileSync(file, text);
}
