/**
 * Sets the dashboard login password of one Operator Staff or Admin user (FE-01a, D16, ADR-0018).
 *
 * Why it exists: demo/seed.sql creates staff and admin rows without `password_hash`, because the
 * repo is public and no password or hash is ever committed. This script reads the password from
 * DEMO_STAFF_PASSWORD or a hidden prompt, hashes it with the CSMS's own scrypt helper (the built
 * `dist/stations/charge-point-credential.js`, same as scripts/seed-demo.mjs) and writes it.
 * Drivers are refused: they register through the driver app (BE-21).
 *
 * Run:  npm run demo:set-password -w @powerme/csms -- <email> [--port-offset N]
 * DB:   DATABASE_URL, else the embedded demo DB on the given port offset (demo/db-embedded.mjs).
 * Exit: 2 bad arguments / password, 1 failure.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIN_STAFF_PASSWORD_LENGTH = 12;
export const MAX_STAFF_PASSWORD_LENGTH = 128;

/** Error text if the password cannot be used, null if it can. */
export function checkStaffPassword(password) {
  if (!password) return 'Thiếu mật khẩu (DEMO_STAFF_PASSWORD hoặc nhập khi được hỏi)';
  const length = [...password].length;
  if (length < MIN_STAFF_PASSWORD_LENGTH || length > MAX_STAFF_PASSWORD_LENGTH)
    return `Mật khẩu phải dài ${MIN_STAFF_PASSWORD_LENGTH}..${MAX_STAFF_PASSWORD_LENGTH} ký tự (hiện ${length})`;
  if (/[\s\x00-\x1f\x7f]/.test(password))
    return 'Mật khẩu có khoảng trắng hoặc ký tự điều khiển (\\r của file CRLF?)';
  return null;
}

export async function loadHasher() {
  const file = path.resolve(here, '..', 'dist', 'stations', 'charge-point-credential.js');
  try {
    return (await import(pathToFileURL(file).href)).hashChargePointPassword;
  } catch (err) {
    throw new Error(
      `không nạp được ${file} (đã chạy "npm run build -w @powerme/csms" chưa?): ${err.message}`,
    );
  }
}

/**
 * Writes the hash for `emails` (staff or admin only). `hash` is injectable for tests.
 * Returns the emails that were updated; throws if one is missing or is not staff/admin.
 */
export async function setStaffPasswords(client, emails, password, hash) {
  const bad = checkStaffPassword(password);
  if (bad) throw new Error(bad);
  const hasher = hash ?? (await loadHasher());
  const passwordHash = await hasher(password);
  const { rows } = await client.query(
    `UPDATE users SET password_hash = $1, updated_at = now()
      WHERE email = ANY($2::text[]) AND role IN ('operator_staff', 'admin')
      RETURNING email`,
    [passwordHash, emails],
  );
  const done = rows.map((r) => r.email);
  const missing = emails.filter((e) => !done.includes(e));
  if (missing.length > 0)
    throw new Error(
      `không có user staff/admin: ${missing.join(', ')} (đã nạp demo/seed.sql chưa?)`,
    );
  return done;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const offsetAt = args.indexOf('--port-offset');
  const portOffset = offsetAt >= 0 ? Number(args[offsetAt + 1]) : 0;
  const email = args.find((a, i) => !a.startsWith('--') && (offsetAt < 0 || i !== offsetAt + 1));
  if (!email || !Number.isInteger(portOffset)) {
    console.error(
      'Cách dùng: npm run demo:set-password -w @powerme/csms -- <email> [--port-offset N]',
    );
    process.exit(2);
  }
  const password =
    process.env.DEMO_STAFF_PASSWORD || (await promptHidden(`Mật khẩu cho ${email}: `));
  const bad = checkStaffPassword(password);
  if (bad) {
    console.error(bad);
    process.exit(2);
  }
  const { dbConfig, connectDemoDb } = await import('../demo/db-embedded.mjs');
  const client = await connectDemoDb(process.env.DATABASE_URL || dbConfig(portOffset).url);
  try {
    await setStaffPasswords(client, [email.trim().toLowerCase()], password);
    console.log(`đã đặt mật khẩu cho ${email}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
