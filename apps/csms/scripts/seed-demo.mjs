/**
 * Nạp dữ liệu mẫu cho STAGING: demo/seed.sql (một trụ RH24D1-00001, hai súng, thẻ, bảng giá) rồi
 * đặt credential Basic Auth cho trụ đó.
 *
 * Vì sao tồn tại: staging chạy với ALLOW_LEGACY_NO_CREDENTIAL=false (mặc định) nên trụ không có
 * `basic_auth_password_hash` bị 401. seed.sql không tạo credential (nó có trước WF-05), nên script
 * này băm DEMO_PILLAR_PASSWORD bằng đúng hàm của CSMS (scrypt, src/stations/pillar-credential.ts —
 * bản đã build trong dist/) và ghi vào charge_points. Simulator dùng cùng mật khẩu (CP_PASSWORD).
 *
 * Idempotent: chạy lại không nhân đôi dòng; hash luôn được ghi lại, nên đổi DEMO_PILLAR_PASSWORD
 * rồi seed lại là xoay được mật khẩu. Lifecycle giữ như seed.sql đặt (`awaiting_connection`, STM-3
 * #3 sang `in_service` khi kết nối đầu tiên được nhận) và KHÔNG bị đụng khi seed lại.
 *
 * Biến môi trường: DATABASE_URL, DEMO_PILLAR_PASSWORD (bắt buộc, không mặc định, >= 16 ký tự).
 * Thoát mã 2 nếu thiếu/yếu cấu hình, mã 1 nếu lỗi khi nạp. Cần `migrate.mjs` đã chạy trước.
 * Chạy: DATABASE_URL=... DEMO_PILLAR_PASSWORD=... node scripts/seed-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_SQL = path.resolve(here, '..', 'demo', 'seed.sql');
export const DEMO_SERIAL = 'RH24D1-00001';
export const MIN_PASSWORD_LENGTH = 16;

/** Trả thông báo lỗi nếu mật khẩu không dùng được, null nếu hợp lệ. */
export function checkPassword(password) {
  if (!password) return 'Thiếu DEMO_PILLAR_PASSWORD (sinh bằng: openssl rand -base64 24)';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `DEMO_PILLAR_PASSWORD phải dài >= ${MIN_PASSWORD_LENGTH} ký tự (hiện ${password.length})`;
  }
  return null;
}

/** Băm bằng hàm của CSMS đã build; không sao chép thuật toán sang đây. */
async function loadHasher() {
  const file = path.resolve(here, '..', 'dist', 'stations', 'pillar-credential.js');
  try {
    return (await import(pathToFileURL(file).href)).hashPillarPassword;
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
  const hashPillarPassword = await loadHasher();
  const hash = await hashPillarPassword(password);

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
  return rows[0];
}

// ---- Chạy riêng ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[seed-demo] Thiếu DATABASE_URL');
    process.exit(2);
  }
  const bad = checkPassword(process.env.DEMO_PILLAR_PASSWORD);
  if (bad) {
    console.error(`[seed-demo] ${bad}`);
    process.exit(2);
  }
  const pg = createRequire(import.meta.url)('pg');
  const client = new (pg.default ?? pg).Client({ connectionString: url });
  try {
    await client.connect();
    await seedDemo(client, process.env.DEMO_PILLAR_PASSWORD, (m) =>
      console.log(`[seed-demo] ${m}`),
    );
  } catch (err) {
    console.error(`[seed-demo] LỖI: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
