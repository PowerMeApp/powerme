/**
 * Nạp dữ liệu mẫu cho STAGING: demo/seed.sql (một trụ RH24D1-00001, hai súng, thẻ, bảng giá) rồi
 * đặt credential Basic Auth cho trụ đó.
 *
 * Vì sao tồn tại: staging chạy với ALLOW_LEGACY_NO_CREDENTIAL=false (mặc định) nên trụ không có
 * `basic_auth_password_hash` bị 401. seed.sql không tạo credential (nó có trước WF-05), nên script
 * này băm DEMO_CHARGE_POINT_PASSWORD bằng đúng hàm của CSMS (scrypt, src/stations/charge-point-credential.ts —
 * bản đã build trong dist/) và ghi vào charge_points. Simulator dùng cùng mật khẩu (CP_PASSWORD).
 *
 * Idempotent: chạy lại không nhân đôi dòng; hash luôn được ghi lại, nên đổi DEMO_CHARGE_POINT_PASSWORD
 * rồi seed lại là xoay được mật khẩu. Lifecycle giữ như seed.sql đặt (`awaiting_connection`, STM-3
 * #3 sang `in_service` khi kết nối đầu tiên được nhận) và KHÔNG bị đụng khi seed lại.
 *
 * BE-27: sau đó nạp demo/seed-app.sql (9 trạm quanh TP.HCM, mẫu xe, ba tài xế mẫu app.ds0x@powerme.test
 * theo BM04 DS-01..DS-03) và đặt mật khẩu đăng nhập cho ba tài xế đó từ DEMO_DRIVER_PASSWORD — băm
 * bằng đúng hàm mà BE-21 dùng cho mật khẩu tài xế (driver-account.ts dùng lại
 * hashChargePointPassword). Mật khẩu không bao giờ nằm trong repo (repo public). Thiếu biến thì bỏ
 * qua bước đặt mật khẩu và cảnh báo (tài xế mẫu chưa đăng nhập được); hash luôn được ghi lại khi có
 * biến, nên đổi DEMO_DRIVER_PASSWORD rồi seed lại là xoay mật khẩu. `--no-app` bỏ qua cả phần BE-27.
 *
 * T128 (FE-01a, ADR-0018): seed.sql tạo admin.demo@powerme.test và staff.demo@powerme.test (người thao
 * tác WF-05) không có mật khẩu. Nếu có DEMO_STAFF_PASSWORD, script băm nó bằng cùng hàm scrypt mà
 * StaffAccounts.login (src/users/auth.ts) dùng để kiểm, rồi ghi cho hai tài khoản đó — để đăng nhập
 * dashboard trên staging. Chạy cả khi `--no-app` (hai tài khoản thuộc seed.sql). Thiếu biến thì bỏ qua
 * và cảnh báo; có biến thì hash luôn được ghi lại (đổi biến rồi seed lại là xoay mật khẩu).
 *
 * Biến môi trường: DATABASE_URL, DEMO_CHARGE_POINT_PASSWORD (bắt buộc, không mặc định, >= 16 ký tự),
 * DEMO_DRIVER_PASSWORD, DEMO_STAFF_PASSWORD (tuỳ chọn, 12..128 ký tự).
 * Thoát mã 2 nếu thiếu/yếu cấu hình, mã 1 nếu lỗi khi nạp. Cần `migrate.mjs` đã chạy trước.
 * Chạy: DATABASE_URL=... DEMO_CHARGE_POINT_PASSWORD=... [DEMO_DRIVER_PASSWORD=...] [DEMO_STAFF_PASSWORD=...]
 *   node scripts/seed-demo.mjs [--no-app]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_SQL = path.resolve(here, '..', 'demo', 'seed.sql');
export const SEED_APP_SQL = path.resolve(here, '..', 'demo', 'seed-app.sql');
export const DEMO_SERIAL = 'RH24D1-00001';
export const MIN_PASSWORD_LENGTH = 16;
/** Tài xế mẫu của seed-app.sql (BE-27) — dùng chung một mật khẩu DEMO_DRIVER_PASSWORD. */
export const APP_DRIVER_EMAILS = [
  'app.ds01@powerme.test',
  'app.ds02@powerme.test',
  'app.ds03@powerme.test',
];
export const MIN_DRIVER_PASSWORD_LENGTH = 12;
/** Trần độ dài mật khẩu của BE-21 (`checkPassword` trong driver-account.ts: 8..128 code point). */
export const MAX_DRIVER_PASSWORD_LENGTH = 128;
/** Tài khoản dashboard mẫu của seed.sql (T128), dùng chung một mật khẩu DEMO_STAFF_PASSWORD. */
export const ADMIN_DEMO_EMAIL = 'admin.demo@powerme.test';
export const STAFF_DEMO_EMAIL = 'staff.demo@powerme.test';

/**
 * Mật khẩu trụ demo từ môi trường. Tên cũ DEMO_PILLAR_PASSWORD vẫn được đọc khi tên mới trống,
 * để `.env` staging tạo trước T92 chạy tiếp mà không phải sửa tay.
 */
export function demoPassword(env = process.env) {
  return env.DEMO_CHARGE_POINT_PASSWORD || env.DEMO_PILLAR_PASSWORD;
}

/** Trả thông báo lỗi nếu mật khẩu không dùng được, null nếu hợp lệ. */
export function checkPassword(password) {
  if (!password) return 'Thiếu DEMO_CHARGE_POINT_PASSWORD (sinh bằng: openssl rand -base64 24)';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `DEMO_CHARGE_POINT_PASSWORD phải dài >= ${MIN_PASSWORD_LENGTH} ký tự (hiện ${password.length})`;
  }
  return null;
}

/** Trả thông báo lỗi nếu DEMO_DRIVER_PASSWORD đặt mà không dùng được, null nếu hợp lệ hoặc trống. */
export function checkDriverPassword(password, name = 'DEMO_DRIVER_PASSWORD') {
  if (!password) return null;
  const length = [...password].length;
  if (length < MIN_DRIVER_PASSWORD_LENGTH || length > MAX_DRIVER_PASSWORD_LENGTH) {
    return `${name} phải dài ${MIN_DRIVER_PASSWORD_LENGTH}..${MAX_DRIVER_PASSWORD_LENGTH} ký tự (hiện ${length}; sinh bằng: openssl rand -hex 8)`;
  }
  // Khoảng trắng / ký tự điều khiển (vd \r của file CRLF) lọt vào hash thì không ai gõ lại được.
  if (/[\s\x00-\x1f\x7f]/.test(password)) {
    return `${name} có khoảng trắng hoặc ký tự điều khiển (\\r của file CRLF?)`;
  }
  return null;
}

/** DEMO_STAFF_PASSWORD (T128): cùng luật với DEMO_DRIVER_PASSWORD; trống = hợp lệ (seed bỏ qua). */
export function checkStaffPassword(password) {
  return checkDriverPassword(password, 'DEMO_STAFF_PASSWORD');
}

/** Băm bằng hàm của CSMS đã build; không sao chép thuật toán sang đây. */
async function loadHasher() {
  const file = path.resolve(here, '..', 'dist', 'stations', 'charge-point-credential.js');
  try {
    return (await import(pathToFileURL(file).href)).hashChargePointPassword;
  } catch (err) {
    throw new Error(
      `không nạp được ${file} (đã chạy "npm run build -w @powerme/csms" chưa?): ${err.message}`,
    );
  }
}

/** `client` là pg.Client đã connect, schema đã migrate. Trả số liệu sau seed. */
export async function seedDemo(client, password, log = () => {}) {
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  const hashChargePointPassword = await loadHasher();
  const hash = await hashChargePointPassword(password);

  await client.query(readFileSync(SEED_SQL, 'utf8'));
  const upd = await client.query(
    `UPDATE charge_points SET basic_auth_password_hash = $1, updated_at = now()
      WHERE serial_number = $2`,
    [hash, DEMO_SERIAL],
  );
  if (upd.rowCount !== 1) throw new Error(`seed.sql không tạo trụ ${DEMO_SERIAL}`);
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM charge_points) AS charge_points,
            (SELECT count(*) FROM connectors) AS connectors,
            (SELECT count(*) FROM rfid_cards) AS rfid_cards,
            (SELECT lifecycle FROM charge_points WHERE serial_number = $1) AS lifecycle`,
    [DEMO_SERIAL],
  );
  log(`seed xong: ${JSON.stringify(rows[0])}; trụ ${DEMO_SERIAL} đã có credential`);
  // T119: ids for CONSOLE_ACTOR_ADMIN_ID / CONSOLE_ACTOR_STAFF_ID (console onboarding routes).
  const actors = await client.query(
    `SELECT (SELECT id FROM users WHERE email = 'admin.demo@powerme.test') AS admin,
            (SELECT id FROM users WHERE email = 'staff.demo@powerme.test') AS staff`,
  );
  log(
    `WF-05 console actors: CONSOLE_ACTOR_ADMIN_ID=${actors.rows[0]?.admin ?? '?'} CONSOLE_ACTOR_STAFF_ID=${actors.rows[0]?.staff ?? '?'}`,
  );
  return rows[0];
}

/**
 * BE-27: nạp seed-app.sql rồi (nếu có `driverPassword`) đặt mật khẩu cho tài xế mẫu. Cần seed.sql đã
 * chạy (operator mẫu). `hash` để test tiêm hàm băm; mặc định là hàm của CSMS đã build.
 * Trả số dòng sau seed (để log và kiểm không nhân đôi).
 */
export async function seedApp(client, driverPassword, log = () => {}, hash = undefined) {
  const bad = checkDriverPassword(driverPassword);
  if (bad) throw new Error(bad);
  const operator = await client.query(`SELECT 1 FROM operators WHERE tax_code = '0312345678'`);
  if (operator.rowCount !== 1)
    throw new Error('chưa có operator mẫu 0312345678 — chạy seed.sql trước');

  await client.query(readFileSync(SEED_APP_SQL, 'utf8'));
  if (driverPassword) {
    const hasher = hash ?? (await loadHasher());
    // Một hash (một salt) cho cả ba: cùng mật khẩu, tài khoản mẫu, không cần salt riêng.
    const passwordHash = await hasher(driverPassword);
    const upd = await client.query(
      `UPDATE users SET password_hash = $1, updated_at = now()
        WHERE email = ANY($2::text[]) AND role = 'driver'`,
      [passwordHash, APP_DRIVER_EMAILS],
    );
    log(
      `đã đặt mật khẩu cho ${upd.rowCount}/${APP_DRIVER_EMAILS.length} tài xế mẫu (DEMO_DRIVER_PASSWORD)`,
    );
  } else {
    log(
      'CẢNH BÁO: DEMO_DRIVER_PASSWORD trống — tài xế mẫu app.ds0x@powerme.test chưa có mật khẩu, ' +
        'không đăng nhập được (staging: ./init-env.sh --add-missing rồi ./seed.sh)',
    );
  }
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM sites WHERE site_code LIKE 'HCM-APP-%')::int AS sites,
            (SELECT count(*) FROM charge_points WHERE serial_number LIKE 'PMAPP-%')::int AS charge_points,
            (SELECT count(*) FROM connectors c JOIN charge_points cp ON cp.id = c.charge_point_id
              WHERE cp.serial_number LIKE 'PMAPP-%')::int AS connectors,
            (SELECT count(*) FROM vehicle_models)::int AS vehicle_models,
            (SELECT count(*) FROM users WHERE email = ANY($1::text[]))::int AS drivers,
            (SELECT count(*) FROM users WHERE email = ANY($1::text[]) AND password_hash IS NOT NULL)::int
              AS drivers_with_password,
            (SELECT count(*) FROM vehicles v JOIN users u ON u.id = v.driver_id
              WHERE u.email = ANY($1::text[]))::int AS vehicles`,
    [APP_DRIVER_EMAILS],
  );
  log(`seed app xong: ${JSON.stringify(rows[0])}`);
  return rows[0];
}

/**
 * T128: đặt mật khẩu dashboard cho admin/staff mẫu của seed.sql. Cần seed.sql đã chạy. Chỉ ghi dòng có
 * đúng role VÀ dòng admins / operator_staff đi kèm (StaffAccounts.login đòi cả hai). `hash` để test
 * tiêm hàm băm; mặc định là hàm của CSMS đã build — cùng hàm login dùng để kiểm. Trả số tài khoản đã đặt.
 */
export async function seedStaff(client, staffPassword, log = () => {}, hash = undefined) {
  const bad = checkStaffPassword(staffPassword);
  if (bad) throw new Error(bad);
  const emails = `${ADMIN_DEMO_EMAIL}, ${STAFF_DEMO_EMAIL}`;
  if (!staffPassword) {
    log(
      `CẢNH BÁO: DEMO_STAFF_PASSWORD trống — ${emails} chưa có mật khẩu, không đăng nhập dashboard ` +
        'được (staging: ./init-env.sh --add-missing rồi ./seed.sh)',
    );
    return 0;
  }
  const hasher = hash ?? (await loadHasher());
  // Một hash (một salt) cho cả hai: cùng mật khẩu, tài khoản mẫu.
  const passwordHash = await hasher(staffPassword);
  const upd = await client.query(
    `UPDATE users u SET password_hash = $1, updated_at = now()
      WHERE (u.email = $2 AND u.role = 'admin'
             AND EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u.id))
         OR (u.email = $3 AND u.role = 'operator_staff'
             AND EXISTS (SELECT 1 FROM operator_staff s WHERE s.user_id = u.id))`,
    [passwordHash, ADMIN_DEMO_EMAIL, STAFF_DEMO_EMAIL],
  );
  log(
    `đã đặt mật khẩu dashboard cho ${upd.rowCount}/2 tài khoản mẫu (${emails}; DEMO_STAFF_PASSWORD)`,
  );
  return upd.rowCount;
}

// ---- Chạy riêng ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[seed-demo] Thiếu DATABASE_URL');
    process.exit(2);
  }
  const bad = checkPassword(demoPassword());
  if (bad) {
    console.error(`[seed-demo] ${bad}`);
    process.exit(2);
  }
  const withApp = !process.argv.slice(2).includes('--no-app');
  const unknown = process.argv.slice(2).filter((a) => a !== '--no-app');
  if (unknown.length) {
    console.error(`[seed-demo] tham số lạ: ${unknown.join(' ')} (chỉ nhận --no-app)`);
    process.exit(2);
  }
  const driverPassword = process.env.DEMO_DRIVER_PASSWORD || '';
  const badDriver = withApp ? checkDriverPassword(driverPassword) : null;
  if (badDriver) {
    console.error(`[seed-demo] ${badDriver}`);
    process.exit(2);
  }
  const staffPassword = process.env.DEMO_STAFF_PASSWORD || '';
  const badStaff = checkStaffPassword(staffPassword);
  if (badStaff) {
    console.error(`[seed-demo] ${badStaff}`);
    process.exit(2);
  }
  const pg = createRequire(import.meta.url)('pg');
  const client = new (pg.default ?? pg).Client({ connectionString: url });
  try {
    await client.connect();
    const log = (m) => console.log(`[seed-demo] ${m}`);
    await seedDemo(client, demoPassword(), log);
    await seedStaff(client, staffPassword, log);
    if (withApp) await seedApp(client, driverPassword, log);
  } catch (err) {
    console.error(`[seed-demo] LỖI: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
