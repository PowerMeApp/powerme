/**
 * Dữ liệu của trụ tải NFR-03: tạo (idempotent), cất sau khi đo, và đếm những gì tải đã sinh ra.
 *
 * Vì sao tồn tại: phép đo chính thức chạy trên DB STAGING, nơi cả nhóm đang dùng dữ liệu demo. Mọi
 * thứ ở đây vì thế chỉ đụng các dòng CỦA TẢI và nhận diện chúng bằng định danh cố định:
 *
 *   operator  tax_code  `LOADTEST01`            trạng thái `suspended`
 *   site      site_code `LOAD-TEST-01`          toạ độ giữa Thái Bình Dương (Point Nemo)
 *   trụ       serial    `LOAD-0001` … `LOAD-00NN`   2 súng CCS2, có credential (scrypt)
 *   tài xế    email     `load-0001@load.powerme.test` …  mỗi trụ một tài xế, một ví, một thẻ
 *   thẻ       idTag     `LOADCARD0001` …        `online` + `active` → Authorize trả Accepted
 *
 * ẨN KHỎI APP: tìm trạm, gợi ý đường đi và bắt đầu sạc từ app đều lọc `operators.status = 'active'`
 * (station-search.ts, road-discovery.ts, driver-charging.service.ts), nên trụ của operator
 * `suspended` không hiện với tài xế. Đường OCPP không xét trạng thái operator
 * (charge-point-auth.service.ts chỉ xét lifecycle + mật khẩu), nên trụ vẫn nối và sạc bằng thẻ
 * được. Toạ độ xa là lớp thứ hai, phòng khi ai đó đổi operator sang `active`.
 *
 * KHÔNG XOÁ ĐƯỢC, và không cố xoá: phiên do tải sinh ra kéo theo `session_status_history` (trigger
 * append-only chặn DELETE) và `ocpp_message_log` (append-only, ADR-0005); `sessions` vì thế không
 * xoá được (FK RESTRICT), kéo theo `charge_points`, `connectors`, thẻ và tài xế. Gỡ trigger cần
 * quyền chủ bảng (role `app_dev` không có) và phá đúng thứ làm nhật ký đáng tin. Nên "dọn" ở đây là
 * CẤT: gỡ credential (trụ không nối lại được: staging chạy ALLOW_LEGACY_NO_CREDENTIAL=false),
 * `in_service → disabled` (STM-3 #4: không còn bị cảnh báo offline sau 900 s, G10), khoá thẻ và tài
 * khoản tài xế. Dữ liệu đã sinh ở lại, nhận diện theo serial `LOAD-%`. Chạy seed lại là dùng lại
 * được (STM-3 #5 `disabled → in_service`).
 *
 * Mật khẩu trụ chỉ đi qua tham số hàm (CLI đọc từ biến môi trường `LOAD_CP_PASSWORD`); chỉ bản băm
 * scrypt được ghi vào DB, bằng đúng hàm của CSMS (`dist/stations/charge-point-credential.js`).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CSMS_DIR } from '../../demo/db-embedded.mjs';
import { loadIdentity } from './profile.mjs';

export const LOAD_OPERATOR_TAX_CODE = 'LOADTEST01';
export const LOAD_SITE_CODE = 'LOAD-TEST-01';
export const LOAD_SERIAL_LIKE = 'LOAD-%';
export const LOAD_EMAIL_LIKE = 'load-%@load.powerme.test';
export const LOAD_CARD_LIKE = 'LOADCARD%';
export const MIN_PASSWORD_LENGTH = 16;
export const MAX_STATIONS = 500;
/** Số dư ví của tài xế tải (VND): đủ lớn để Authorize luôn qua mức tối thiểu bắt đầu sạc. */
const CREDIT_VND = 5_000_000;

/** Trả thông báo lỗi nếu mật khẩu trụ tải không dùng được, null nếu hợp lệ. */
export function checkLoadPassword(password) {
  if (!password) return 'Thiếu LOAD_CP_PASSWORD (sinh bằng: openssl rand -base64 24)';
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 40) {
    // OCPP 1.6 Security Whitepaper: AuthorizationKey dài 16–40 ký tự.
    return `LOAD_CP_PASSWORD phải dài ${MIN_PASSWORD_LENGTH}..40 ký tự (hiện ${password.length})`;
  }
  if (/[\s\x00-\x1f\x7f:]/.test(password)) {
    return 'LOAD_CP_PASSWORD có khoảng trắng, ký tự điều khiển (\\r của file CRLF?) hoặc dấu ":"';
  }
  return null;
}

/** Hàm băm của CSMS đã build; không sao chép thuật toán sang đây (như scripts/seed-demo.mjs). */
export async function loadHasher() {
  const file = path.join(CSMS_DIR, 'dist', 'stations', 'charge-point-credential.js');
  try {
    return (await import(pathToFileURL(file).href)).hashChargePointPassword;
  } catch (err) {
    throw new Error(
      `không nạp được ${file} (đã chạy "npm run build -w @powerme/csms" chưa?): ${err.message}`,
    );
  }
}

function identities(stations) {
  if (!Number.isInteger(stations) || stations < 1 || stations > MAX_STATIONS) {
    throw new Error(`số trụ phải là số nguyên 1..${MAX_STATIONS}, nhận ${stations}`);
  }
  return Array.from({ length: stations }, (_, i) => loadIdentity(i + 1));
}

/**
 * Tạo / kích hoạt lại `stations` trụ tải. Idempotent: chạy lại không nhân đôi dòng; credential luôn
 * được ghi lại (đổi mật khẩu rồi seed lại = xoay mật khẩu). Một transaction: lỗi giữa chừng thì
 * không để lại gì.
 *
 * @param db  `pg.Client` đã nối (quyền INSERT/UPDATE là đủ, không cần DDL: chạy được bằng `app_dev`)
 * @param opts.hash  hàm băm (để test tiêm); mặc định là hàm của CSMS đã build
 * @returns số liệu sau seed
 */
export async function seedLoad(db, { stations, password, hash = undefined, log = () => {} }) {
  const bad = checkLoadPassword(password);
  if (bad) throw new Error(bad);
  const ids = identities(stations);
  const hasher = hash ?? (await loadHasher());
  // Mỗi trụ một salt riêng, như onboarding thật (WF-05): 50 lần scrypt, vài giây.
  log(`băm credential cho ${ids.length} trụ (scrypt)…`);
  const hashes = [];
  for (let i = 0; i < ids.length; i++) hashes.push(await hasher(password));

  const serials = ids.map((x) => x.serial);
  const emails = ids.map((x) => x.email);
  const idTags = ids.map((x) => x.idTag);

  await db.query('BEGIN');
  try {
    // Chặn nhầm: serial LOAD-% đã thuộc trạm KHÁC thì không phải của ta, không đụng.
    const foreign = await db.query(
      `SELECT cp.serial_number FROM charge_points cp LEFT JOIN sites s ON s.id = cp.site_id
        WHERE cp.serial_number = ANY($1::text[]) AND s.site_code IS DISTINCT FROM $2`,
      [serials, LOAD_SITE_CODE],
    );
    if (foreign.rowCount > 0) {
      throw new Error(
        `đã có trụ trùng serial nhưng không thuộc ${LOAD_SITE_CODE}: ` +
          foreign.rows.map((r) => r.serial_number).join(', '),
      );
    }

    await db.query(
      `INSERT INTO operators (tax_code, legal_name, address, status)
       VALUES ($1, 'LOAD-TEST NFR-03 (khong phai don vi that)', 'Du lieu do tai, an khoi app', 'suspended')
       ON CONFLICT ON CONSTRAINT operators_tax_code_key DO NOTHING`,
      [LOAD_OPERATOR_TAX_CODE],
    );
    await db.query(
      `INSERT INTO sites (site_code, operator_id, site_name, address, latitude, longitude)
       SELECT $2, o.id, 'LOAD-TEST NFR-03', 'Du lieu do tai (Point Nemo)', -48.876667, -123.393333
       FROM operators o WHERE o.tax_code = $1
       ON CONFLICT ON CONSTRAINT sites_site_code_key DO NOTHING`,
      [LOAD_OPERATOR_TAX_CODE, LOAD_SITE_CODE],
    );
    await db.query(
      `INSERT INTO charge_points (serial_number, display_code, site_id, model, firmware_version,
         rated_power_kw, lifecycle, reports_soc, supports_reservation, basic_auth_password_hash)
       SELECT v.serial, v.display, s.id, 'D1-120', 'nfr03-load', 120, 'awaiting_connection', false,
              false, v.hash
       FROM unnest($1::text[], $2::text[], $3::text[]) AS v(serial, display, hash)
       CROSS JOIN sites s WHERE s.site_code = $4
       ON CONFLICT ON CONSTRAINT charge_points_serial_number_key DO UPDATE
         SET basic_auth_password_hash = EXCLUDED.basic_auth_password_hash,
             -- STM-3 #5: trụ đã cất (disabled) được đưa lại vào vận hành; trạng thái khác giữ nguyên.
             lifecycle = CASE WHEN charge_points.lifecycle = 'disabled'
                              THEN 'in_service'::charge_point_lifecycle
                              ELSE charge_points.lifecycle END,
             updated_at = now()`,
      [serials, ids.map((x) => x.displayCode), hashes, LOAD_SITE_CODE],
    );
    await db.query(
      `INSERT INTO connectors (charge_point_id, connector_no, connector_type, max_power_kw)
       SELECT cp.id, n.no, 'ccs2', 60 FROM charge_points cp CROSS JOIN (VALUES (1), (2)) AS n(no)
       WHERE cp.serial_number = ANY($1::text[])
       ON CONFLICT ON CONSTRAINT connectors_charge_point_id_connector_no_key DO NOTHING`,
      [serials],
    );
    await db.query(
      `INSERT INTO users (email, full_name, role, account_status)
       SELECT v.email, 'Load Test ' || v.serial, 'driver', 'active'
       FROM unnest($1::text[], $2::text[]) AS v(email, serial)
       ON CONFLICT ON CONSTRAINT users_email_key DO UPDATE SET account_status = 'active'
         WHERE users.role = 'driver'`,
      [emails, serials],
    );
    await db.query(
      `INSERT INTO drivers (user_id, consent_version, consent_given_at)
       SELECT u.id, '2026-09', now() FROM users u
       WHERE u.email = ANY($1::text[]) AND u.role = 'driver'
       ON CONFLICT (user_id) DO NOTHING`,
      [emails],
    );
    await db.query(
      `INSERT INTO credit_accounts (driver_id, status, balance_vnd)
       SELECT u.id, 'active', $2 FROM users u
       WHERE u.email = ANY($1::text[]) AND u.role = 'driver'
       ON CONFLICT ON CONSTRAINT credit_accounts_driver_id_key DO NOTHING`,
      [emails, CREDIT_VND],
    );
    // Sổ cái cần một top_up làm gốc cho số dư (như demo/seed.sql và rq1/adapters/powerme.mjs).
    await db.query(
      `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_discount_vnd,
         amount_paid_vnd, status, idempotency_key, expires_at, completed_at)
       SELECT 'NFR03-' || v.tag, ca.id, $3, 0, $3, 'credited', 'nfr03-topup-' || v.tag,
              now() + interval '15 minutes', now()
       FROM unnest($1::text[], $2::text[]) AS v(email, tag)
       JOIN users u ON u.email = v.email AND u.role = 'driver'
       JOIN credit_accounts ca ON ca.driver_id = u.id
       -- NOT EXISTS thay cho ON CONFLICT: ràng buộc UNIQUE của idempotency_key đổi tên và đổi cột ở
       -- migration 0019, mà DB được seed có thể đứng trước hoặc sau migration đó.
       WHERE NOT EXISTS (SELECT 1 FROM top_ups t
                          WHERE t.credit_account_id = ca.id
                            AND t.idempotency_key = 'nfr03-topup-' || v.tag)`,
      [emails, idTags, CREDIT_VND],
    );
    await db.query(
      `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
         balance_after_vnd, top_up_id)
       SELECT t.credit_account_id, 1, 'top_up', t.amount_vnd, t.amount_vnd, t.id
       FROM top_ups t WHERE t.idempotency_key = ANY($1::text[])
       ON CONFLICT ON CONSTRAINT credit_transactions_account_entry_no_key DO NOTHING`,
      [idTags.map((tag) => `nfr03-topup-${tag}`)],
    );
    await db.query(
      `INSERT INTO rfid_cards (card_identifier, card_kind, driver_id, status)
       SELECT v.tag, 'online', u.id, 'active'
       FROM unnest($1::text[], $2::text[]) AS v(email, tag)
       JOIN users u ON u.email = v.email AND u.role = 'driver'
       ON CONFLICT ON CONSTRAINT rfid_cards_card_identifier_key DO UPDATE SET status = 'active'
         WHERE rfid_cards.driver_id = EXCLUDED.driver_id`,
      [emails, idTags],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
  return loadState(db);
}

/** Trạng thái hiện tại của dữ liệu tải (đếm theo định danh cố định). */
export async function loadState(db) {
  const { rows } = await db.query(
    `SELECT
       (SELECT status::text FROM operators WHERE tax_code = $1) AS operator_status,
       (SELECT count(*)::int FROM charge_points cp JOIN sites s ON s.id = cp.site_id
         WHERE s.site_code = $2 AND cp.serial_number LIKE $3) AS charge_points,
       (SELECT count(*)::int FROM charge_points cp JOIN sites s ON s.id = cp.site_id
         WHERE s.site_code = $2 AND cp.serial_number LIKE $3
           AND cp.basic_auth_password_hash IS NOT NULL) AS with_credential,
       (SELECT count(*)::int FROM charge_points cp JOIN sites s ON s.id = cp.site_id
         WHERE s.site_code = $2 AND cp.serial_number LIKE $3 AND cp.is_online) AS online,
       (SELECT coalesce(json_object_agg(x.lifecycle, x.n), '{}'::json) FROM (
          SELECT cp.lifecycle::text AS lifecycle, count(*)::int AS n
          FROM charge_points cp JOIN sites s ON s.id = cp.site_id
          WHERE s.site_code = $2 AND cp.serial_number LIKE $3 GROUP BY 1) x) AS lifecycle,
       (SELECT count(*)::int FROM connectors c JOIN charge_points cp ON cp.id = c.charge_point_id
          JOIN sites s ON s.id = cp.site_id
         WHERE s.site_code = $2 AND cp.serial_number LIKE $3) AS connectors,
       (SELECT count(*)::int FROM users WHERE email LIKE $4 AND role = 'driver'
           AND account_status = 'active') AS active_drivers,
       (SELECT count(*)::int FROM rfid_cards WHERE card_identifier LIKE $5
           AND status = 'active') AS active_cards`,
    [LOAD_OPERATOR_TAX_CODE, LOAD_SITE_CODE, LOAD_SERIAL_LIKE, LOAD_EMAIL_LIKE, LOAD_CARD_LIKE],
  );
  return rows[0];
}

/**
 * Cất dữ liệu tải sau khi đo (xem đầu file: không xoá). Từ chối khi còn trụ tải đang nối, trừ khi
 * `force`. Trả `{ chargePoints, cards, drivers, openSessions }`.
 */
export async function teardownLoad(db, { force = false } = {}) {
  const state = await loadState(db);
  if (state.online > 0 && !force) {
    throw new Error(
      `còn ${state.online} trụ tải đang nối: chờ bộ sinh tải dừng hẳn, hoặc thêm --force`,
    );
  }
  await db.query('BEGIN');
  try {
    const cps = await db.query(
      `UPDATE charge_points cp
          SET basic_auth_password_hash = NULL,
              -- STM-3 #4. Trụ chưa từng nối (awaiting_connection) giữ nguyên: không có cảnh báo
              -- offline cho nó, và không có chuyển trạng thái awaiting_connection → disabled.
              lifecycle = CASE WHEN cp.lifecycle = 'in_service'
                               THEN 'disabled'::charge_point_lifecycle ELSE cp.lifecycle END,
              updated_at = now()
         FROM sites s
        WHERE s.id = cp.site_id AND s.site_code = $1 AND cp.serial_number LIKE $2`,
      [LOAD_SITE_CODE, LOAD_SERIAL_LIKE],
    );
    const cards = await db.query(
      `UPDATE rfid_cards c SET status = 'blocked'
         FROM users u
        WHERE u.id = c.driver_id AND u.email LIKE $1 AND c.card_identifier LIKE $2
          AND c.status <> 'blocked'`,
      [LOAD_EMAIL_LIKE, LOAD_CARD_LIKE],
    );
    const drivers = await db.query(
      `UPDATE users SET account_status = 'suspended', updated_at = now()
        WHERE email LIKE $1 AND role = 'driver' AND account_status = 'active'`,
      [LOAD_EMAIL_LIKE],
    );
    await db.query('COMMIT');
    const open = await db.query(
      `SELECT count(*)::int AS n FROM sessions se JOIN charge_points cp ON cp.id = se.charge_point_id
         JOIN sites s ON s.id = cp.site_id
        WHERE s.site_code = $1 AND cp.serial_number LIKE $2
          AND se.status IN ('pending', 'active', 'paused', 'stopping', 'orphaned')`,
      [LOAD_SITE_CODE, LOAD_SERIAL_LIKE],
    );
    return {
      chargePoints: cps.rowCount,
      cards: cards.rowCount,
      drivers: drivers.rowCount,
      openSessions: open.rows[0].n,
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Số dòng mà trụ tải đã để lại trong DB, CỘNG DỒN mọi lần chạy (các bảng này không xoá được).
 * Dùng để ước tính dung lượng và để ghi vào meta.json sau mỗi lần đo.
 */
export async function loadFootprint(db) {
  const cp = `SELECT cp.id FROM charge_points cp JOIN sites s ON s.id = cp.site_id
               WHERE s.site_code = $1 AND cp.serial_number LIKE $2`;
  const se = `SELECT se.id FROM sessions se WHERE se.charge_point_id IN (${cp})`;
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM ocpp_message_log WHERE charge_point_id IN (${cp})) AS ocpp_message_log,
       (SELECT count(*)::int FROM sessions WHERE charge_point_id IN (${cp})) AS sessions,
       (SELECT count(*)::int FROM meter_values WHERE session_id IN (${se})) AS meter_values,
       (SELECT count(*)::int FROM session_status_history WHERE session_id IN (${se})) AS session_status_history,
       (SELECT count(*)::int FROM reconciliation_records WHERE session_id IN (${se})) AS reconciliation_records,
       (SELECT count(*)::int FROM connector_status_events WHERE charge_point_id IN (${cp})) AS connector_status_events,
       (SELECT count(*)::int FROM charge_point_connections WHERE charge_point_id IN (${cp})) AS charge_point_connections,
       (SELECT count(*)::int FROM remote_commands WHERE charge_point_id IN (${cp})) AS remote_commands,
       (SELECT count(*)::int FROM fault_events WHERE charge_point_id IN (${cp})) AS fault_events,
       (SELECT count(*)::int FROM credit_transactions
         WHERE session_id IN (${se}) AND transaction_type = 'session_debit') AS session_debits,
       (SELECT coalesce(json_object_agg(x.status, x.n), '{}'::json) FROM (
          SELECT status::text AS status, count(*)::int AS n FROM sessions
          WHERE charge_point_id IN (${cp}) GROUP BY 1) x) AS sessions_by_status`,
    [LOAD_SITE_CODE, LOAD_SERIAL_LIKE],
  );
  return rows[0];
}
