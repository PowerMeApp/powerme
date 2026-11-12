-- Dữ liệu mẫu cho APP TÀI XẾ trên staging (BE-27) — nạp sau demo/seed.sql bằng scripts/seed-demo.mjs.
--
-- Vì sao tồn tại: app Flutter (Sơn) cần dữ liệu thật trên staging thay vì DB local: nhiều trạm quanh
-- TP.HCM để thử tìm trạm theo toạ độ / loại cổng / VinFast-only (#98), mẫu xe có thông số pin để
-- smart search tính được, và tài xế mẫu theo kịch bản BM04 (DS-01 đủ tiền, DS-02 thiếu tiền, DS-03
-- có điểm). Đặt ở file riêng (không sửa seed.sql) để seed.sql giữ đúng dữ liệu demo Review 2.
--
-- Idempotent: ON CONFLICT DO NOTHING / WHERE NOT EXISTS. Chạy lại không nhân đôi dòng, KHÔNG xoá và
-- KHÔNG sửa dữ liệu phát sinh (phiên, sổ cái, trạng thái súng, lifecycle). Mật khẩu tài xế mẫu KHÔNG
-- nằm ở đây (repo public): seed-demo.mjs băm DEMO_DRIVER_PASSWORD rồi ghi users.password_hash.
--
-- Quyết định đáng chú ý:
--   * Dùng lại operator mẫu của seed.sql (0312345678) và biểu giá theo khung giờ của nó — file này
--     cần seed.sql chạy trước (seed-demo.mjs làm đúng thứ tự). Operator không có thì không seed gì.
--   * Trụ mới ở lifecycle 'in_service' (station-search chỉ trả trụ in_service) nhưng KHÔNG có
--     credential (basic_auth_password_hash NULL ⇒ mọi kết nối OCPP bị 401) và chưa từng kết nối
--     (is_online=false, last_message_at NULL). App thấy các súng này ở driver_status 'offline'.
--     Trạng thái súng chỉ đến từ OCPP (StatusNotification), nên để mặc định 'Unavailable'; chỉ trụ
--     demo RH24D1-00001 (seed.sql, chạy simulator) có trạng thái sống và bắt đầu sạc được.
--     OfflineAlertService bỏ qua trụ chưa từng kết nối (COALESCE(last_message_at, online_changed_at)
--     NULL) nên không sinh sự cố "Offline" giả.
--   * VinFast-only là cờ của SITE (sites.vinfast_only, BR-P03), không phải của trụ.
--   * Toạ độ là vị trí gần đúng của các địa danh có thật; tên trạm, địa chỉ, công suất là GIẢ.
--     Thông số mẫu xe lấy gần đúng từ công bố của hãng — đủ cho smart search, không dùng làm số liệu.
--   * Không thẻ ví / station_wallet (đang bị bỏ ở PR #110). Không thẻ RFID: app bắt đầu bằng QR/súng.

BEGIN;

-- Trạm (site) quanh TP.HCM ---------------------------------------------------------------
INSERT INTO sites (site_code, operator_id, site_name, vinfast_only, address, latitude, longitude)
SELECT v.code, o.id, v.name, v.vinfast_only, v.address, v.lat, v.lng
FROM operators o
CROSS JOIN (VALUES
  ('HCM-APP-Q1-01',  'PowerMe Ben Thanh',           false, 'Le Loi, Phuong Ben Thanh, Quan 1, TP.HCM',          10.772500, 106.698000),
  ('HCM-APP-Q3-01',  'PowerMe Ho Con Rua',          false, 'Vo Van Tan, Phuong Vo Thi Sau, Quan 3, TP.HCM',     10.782700, 106.695900),
  ('HCM-APP-Q10-01', 'PowerMe Van Hanh Mall',       false, 'Su Van Hanh, Phuong 12, Quan 10, TP.HCM',           10.770600, 106.669400),
  ('HCM-APP-PN-01',  'PowerMe Phan Xich Long',      false, 'Phan Xich Long, Phuong 2, Phu Nhuan, TP.HCM',       10.800600, 106.689800),
  ('HCM-APP-BT-01',  'PowerMe Landmark 81',         false, 'Dien Bien Phu, Phuong 22, Binh Thanh, TP.HCM',      10.795000, 106.721900),
  ('HCM-APP-TD-01',  'PowerMe Thao Dien',           false, 'Xuan Thuy, Phuong Thao Dien, TP Thu Duc, TP.HCM',   10.803400, 106.733600),
  ('HCM-APP-Q7-01',  'VinFast Crescent Mall',       true,  'Ton Dat Tien, Phuong Tan Phu, Quan 7, TP.HCM',      10.729300, 106.718900),
  ('HCM-APP-TD-02',  'VinFast Vinhomes Grand Park', true,  'Nguyen Xien, Phuong Long Binh, TP Thu Duc, TP.HCM', 10.842900, 106.838200),
  ('HCM-APP-TB-01',  'VinFast Cong Hoa',            true,  'Cong Hoa, Phuong 4, Tan Binh, TP.HCM',              10.801200, 106.652700)
) AS v(code, name, vinfast_only, address, lat, lng)
WHERE o.tax_code = '0312345678'
ON CONFLICT ON CONSTRAINT sites_site_code_key DO NOTHING;

-- Trụ: in_service, không credential, chưa từng kết nối (xem đầu file) -----------------------
INSERT INTO charge_points (
  serial_number, display_code, site_id, model, firmware_version, rated_power_kw,
  lifecycle, reports_soc, supports_reservation
)
SELECT v.serial, v.display_code, s.id, v.model, 'demo-1.0', v.rated_kw, 'in_service', v.dc, v.dc
FROM sites s
JOIN (VALUES
  ('PMAPP-Q1-01A',  'PM-DC120-HCM-0101', 'HCM-APP-Q1-01',  'DC-120', 120, true),
  ('PMAPP-Q1-01B',  'PM-AC22-HCM-0102',  'HCM-APP-Q1-01',  'AC-22',   22, false),
  ('PMAPP-Q3-01A',  'PM-DC60-HCM-0201',  'HCM-APP-Q3-01',  'DC-60',   60, true),
  ('PMAPP-Q10-01A', 'PM-AC7-HCM-0301',   'HCM-APP-Q10-01', 'AC-7',     7, false),
  ('PMAPP-PN-01A',  'PM-DC30-HCM-0401',  'HCM-APP-PN-01',  'DC-30',   30, true),
  ('PMAPP-BT-01A',  'PM-DC120-HCM-0501', 'HCM-APP-BT-01',  'DC-120', 120, true),
  ('PMAPP-TD-01A',  'PM-DC50-HCM-0601',  'HCM-APP-TD-01',  'DC-50',   50, true),
  ('PMAPP-TD-01B',  'PM-AC22-HCM-0602',  'HCM-APP-TD-01',  'AC-22',   22, false),
  ('PMAPP-Q7-01A',  'PM-DC150-HCM-0701', 'HCM-APP-Q7-01',  'DC-150', 150, true),
  ('PMAPP-TD-02A',  'PM-DC60-HCM-0801',  'HCM-APP-TD-02',  'DC-60',   60, true),
  ('PMAPP-TD-02B',  'PM-AC11-HCM-0802',  'HCM-APP-TD-02',  'AC-11',   11, false),
  ('PMAPP-TB-01A',  'PM-DC60-HCM-0901',  'HCM-APP-TB-01',  'DC-60',   60, true)
) AS v(serial, display_code, site_code, model, rated_kw, dc) ON v.site_code = s.site_code
ON CONFLICT ON CONSTRAINT charge_points_serial_number_key DO NOTHING;

-- Súng: CCS2 / Type2 / CHAdeMO, công suất khác nhau; status mặc định 'Unavailable' (chỉ OCPP đổi) ---
INSERT INTO connectors (charge_point_id, connector_no, connector_type, max_power_kw)
SELECT cp.id, v.no, v.kind::connector_type, v.kw
FROM charge_points cp
JOIN (VALUES
  ('PMAPP-Q1-01A',  1, 'ccs2',    120),
  ('PMAPP-Q1-01A',  2, 'ccs2',     60),
  ('PMAPP-Q1-01B',  1, 'type2',    22),
  ('PMAPP-Q3-01A',  1, 'ccs2',     60),
  ('PMAPP-Q3-01A',  2, 'chademo',  50),
  ('PMAPP-Q10-01A', 1, 'type2',     7),
  ('PMAPP-Q10-01A', 2, 'type2',     7),
  ('PMAPP-PN-01A',  1, 'ccs2',     30),
  ('PMAPP-BT-01A',  1, 'ccs2',     60),
  ('PMAPP-BT-01A',  2, 'ccs2',     60),
  ('PMAPP-TD-01A',  1, 'ccs2',     50),
  ('PMAPP-TD-01A',  2, 'chademo',  50),
  ('PMAPP-TD-01B',  1, 'type2',    22),
  ('PMAPP-TD-01B',  2, 'type2',    22),
  ('PMAPP-Q7-01A',  1, 'ccs2',    150),
  ('PMAPP-Q7-01A',  2, 'ccs2',     75),
  ('PMAPP-TD-02A',  1, 'ccs2',     60),
  ('PMAPP-TD-02A',  2, 'ccs2',     60),
  ('PMAPP-TD-02B',  1, 'type2',    11),
  ('PMAPP-TD-02B',  2, 'type2',    11),
  ('PMAPP-TB-01A',  1, 'ccs2',     60),
  ('PMAPP-TB-01A',  2, 'ccs2',     60)
) AS v(serial, no, kind, kw) ON v.serial = cp.serial_number
ON CONFLICT ON CONSTRAINT connectors_charge_point_id_connector_no_key DO NOTHING;

-- Mẫu xe (thông số gần đúng; NULL max_dc_kw = xe chỉ sạc AC) ---------------------------------
INSERT INTO vehicle_models (
  brand, model_name, connector_type, battery_capacity_kwh, rated_range_km, max_dc_kw, is_vinfast
)
SELECT v.brand, v.model, v.kind::connector_type, v.kwh, v.km, v.dc_kw, v.vinfast
FROM (VALUES
  ('VinFast', 'VF 3',          'ccs2',    18.64, 210,  30::numeric, true),
  ('VinFast', 'VF 5 Plus',     'ccs2',    37.23, 326,  50::numeric, true),
  ('VinFast', 'VF e34',        'ccs2',    41.90, 318,  60::numeric, true),
  ('VinFast', 'VF 8 Plus',     'ccs2',    87.70, 457, 150::numeric, true),
  ('Hyundai', 'Ioniq 5',       'ccs2',    72.60, 451, 220::numeric, false),
  ('BYD',     'Atto 3',        'ccs2',    60.48, 410,  88::numeric, false),
  ('Nissan',  'Leaf',          'chademo', 40.00, 270,  50::numeric, false),
  ('Wuling',  'HongGuang MiniEV', 'type2', 14.50, 170, NULL::numeric, false)
) AS v(brand, model, kind, kwh, km, dc_kw, vinfast)
ON CONFLICT ON CONSTRAINT vehicle_models_brand_model_name_key DO NOTHING;

-- Tài xế mẫu theo kịch bản BM04 (mật khẩu do seed-demo.mjs đặt từ DEMO_DRIVER_PASSWORD) --------
--   app.ds01@powerme.test  DS-01  200.000 VND, VF 8 Plus (mặc định) + Nissan Leaf
--   app.ds02@powerme.test  DS-02   30.000 VND (dưới CHARGE_MINIMUM_START_VND 50.000), VF e34
--   app.ds03@powerme.test  DS-03  100.000 VND + 600 điểm (>= 500 điểm tối thiểu để dùng), Ioniq 5 + MiniEV
-- Số điện thoại GIẢ dạng E.164 để đăng nhập bằng SĐT (BE-30; users_phone_number_key UNIQUE từ 0017).
-- Số đã có người khác dùng thì tài xế mẫu không có số, thay vì làm hỏng cả seed.
INSERT INTO users (email, full_name, phone_number, role, account_status)
SELECT v.email, v.full_name,
       CASE WHEN EXISTS (SELECT 1 FROM users x WHERE x.phone_number = v.phone) THEN NULL ELSE v.phone END,
       'driver', 'active'
FROM (VALUES
  ('app.ds01@powerme.test', 'Tran Van Du Tien', '+84900000101'),
  ('app.ds02@powerme.test', 'Le Thi It Tien',   '+84900000102'),
  ('app.ds03@powerme.test', 'Pham Van Co Diem', '+84900000103')
) AS v(email, full_name, phone)
ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING;

-- Tài xế mẫu đã có từ trước mà chưa có số (vd số bị chiếm lúc tạo): điền số nếu số còn trống.
-- Không bao giờ ghi đè một số đã có (app / người vận hành có thể đã đổi).
UPDATE users u
SET phone_number = v.phone, updated_at = now()
FROM (VALUES
  ('app.ds01@powerme.test', '+84900000101'),
  ('app.ds02@powerme.test', '+84900000102'),
  ('app.ds03@powerme.test', '+84900000103')
) AS v(email, phone)
WHERE u.email = v.email
  AND u.phone_number IS NULL
  AND NOT EXISTS (SELECT 1 FROM users x WHERE x.phone_number = v.phone);

INSERT INTO drivers (user_id, consent_version, consent_given_at)
SELECT u.id, '2026-09', now()
FROM users u
WHERE u.email IN ('app.ds01@powerme.test', 'app.ds02@powerme.test', 'app.ds03@powerme.test')
  AND u.role = 'driver'
ON CONFLICT (user_id) DO NOTHING;

-- Xe của tài xế mẫu. Biển số GIẢ (dải 51K-90x), mỗi tài xế đúng một xe mặc định.
INSERT INTO vehicles (plate_number, driver_id, vehicle_model_id, is_default)
SELECT v.plate, d.user_id, m.id, v.is_default
FROM (VALUES
  ('51K-901.01', 'app.ds01@powerme.test', 'VinFast', 'VF 8 Plus',        true),
  ('51K-901.02', 'app.ds01@powerme.test', 'Nissan',  'Leaf',             false),
  ('51K-902.01', 'app.ds02@powerme.test', 'VinFast', 'VF e34',           true),
  ('51K-903.01', 'app.ds03@powerme.test', 'Hyundai', 'Ioniq 5',          true),
  ('51K-903.02', 'app.ds03@powerme.test', 'Wuling',  'HongGuang MiniEV', false)
) AS v(plate, email, brand, model, is_default)
JOIN users u ON u.email = v.email
JOIN drivers d ON d.user_id = u.id
JOIN vehicle_models m ON m.brand = v.brand AND m.model_name = v.model
-- Tài xế đã tự đặt xe mặc định khác (qua app) thì xe seed vào không mặc định, khỏi vấp unique index.
WHERE NOT (v.is_default AND EXISTS (SELECT 1 FROM vehicles x WHERE x.driver_id = d.user_id AND x.is_default))
-- BE-34 (0018): biển đã có — kể cả xe tài xế đã GỠ qua app — thì không nạp lại (seed không hồi sinh
-- xe đã gỡ). So theo khoá chữ + số như index vehicles_plate_key_active.
  AND NOT EXISTS (SELECT 1 FROM vehicles x
                  WHERE upper(regexp_replace(x.plate_number, '[^A-Za-z0-9]', '', 'g'))
                      = upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g')))
ON CONFLICT DO NOTHING;

-- Ví credit: số dư = sổ cái (một top_up gốc + một dòng credit_transactions entry 1) ---------------
-- Chỉ nạp khi ví CHƯA có dòng sổ cái nào: ví đã phát sinh giao dịch (app đã sạc/nạp) thì giữ nguyên,
-- không chèn top-up vào giữa sổ cái đang chạy.
INSERT INTO credit_accounts (driver_id, status, balance_vnd)
SELECT d.user_id, 'active', 0
FROM drivers d
JOIN users u ON u.id = d.user_id
WHERE u.email IN ('app.ds01@powerme.test', 'app.ds02@powerme.test', 'app.ds03@powerme.test')
ON CONFLICT ON CONSTRAINT credit_accounts_driver_id_key DO NOTHING;

-- expires_at bắt buộc (migration 0003, BR-P13: tạo + 15 phút); trạng thái credited ngay.
INSERT INTO top_ups (
  gateway_reference, credit_account_id, amount_vnd, points_discount_vnd, amount_paid_vnd,
  status, idempotency_key, expires_at, completed_at
)
SELECT 'APP-SEED-TOPUP-' || v.tag, ca.id, v.amount, 0, v.amount, 'credited',
       'app-seed-topup-' || lower(v.tag), now() + interval '15 minutes', now()
FROM (VALUES
  ('app.ds01@powerme.test', 'DS01', 200000),
  ('app.ds02@powerme.test', 'DS02',  30000),
  ('app.ds03@powerme.test', 'DS03', 100000)
) AS v(email, tag, amount)
JOIN users u ON u.email = v.email
JOIN credit_accounts ca ON ca.driver_id = u.id
WHERE NOT EXISTS (SELECT 1 FROM credit_transactions ct WHERE ct.credit_account_id = ca.id)
ON CONFLICT ON CONSTRAINT top_ups_idempotency_key_key DO NOTHING;

INSERT INTO credit_transactions (
  credit_account_id, entry_no, transaction_type, amount_vnd, balance_after_vnd, top_up_id
)
SELECT t.credit_account_id, 1, 'top_up', t.amount_vnd, t.amount_vnd, t.id
FROM top_ups t
WHERE t.idempotency_key IN ('app-seed-topup-ds01', 'app-seed-topup-ds02', 'app-seed-topup-ds03')
  AND NOT EXISTS (SELECT 1 FROM credit_transactions ct WHERE ct.credit_account_id = t.credit_account_id)
ON CONFLICT ON CONSTRAINT credit_transactions_account_entry_no_key DO NOTHING;

-- balance_vnd chỉ được đặt khi sổ cái của ví đúng là một dòng top-up seed (lần chạy đầu).
UPDATE credit_accounts ca
SET balance_vnd = ct.balance_after_vnd, updated_at = now()
FROM credit_transactions ct
JOIN top_ups t ON t.id = ct.top_up_id
WHERE ct.credit_account_id = ca.id
  AND ct.entry_no = 1
  AND t.idempotency_key IN ('app-seed-topup-ds01', 'app-seed-topup-ds02', 'app-seed-topup-ds03')
  AND ca.balance_vnd = 0
  AND NOT EXISTS (SELECT 1 FROM credit_transactions x WHERE x.credit_account_id = ca.id AND x.entry_no > 1);

-- Điểm thưởng: ví điểm cho cả ba; DS-03 có một lô earn 600 điểm, hạn 12 tháng (LOYALTY mặc định) ----
-- Lô earn seed không gắn phiên (session_id NULL) — chỉ được phép vì unique index earn/phiên là partial.
INSERT INTO loyalty_accounts (driver_id, points_balance)
SELECT d.user_id, 0
FROM drivers d
JOIN users u ON u.id = d.user_id
WHERE u.email IN ('app.ds01@powerme.test', 'app.ds02@powerme.test', 'app.ds03@powerme.test')
ON CONFLICT ON CONSTRAINT loyalty_accounts_driver_id_key DO NOTHING;

INSERT INTO loyalty_transactions (loyalty_account_id, entry_no, transaction_type, points, expires_at)
SELECT la.id, 1, 'earn', 600, now() + interval '12 months'
FROM loyalty_accounts la
JOIN users u ON u.id = la.driver_id
WHERE u.email = 'app.ds03@powerme.test'
  AND NOT EXISTS (SELECT 1 FROM loyalty_transactions lt WHERE lt.loyalty_account_id = la.id)
ON CONFLICT ON CONSTRAINT loyalty_transactions_account_entry_no_key DO NOTHING;

UPDATE loyalty_accounts la
SET points_balance = 600, updated_at = now()
FROM users u
WHERE u.id = la.driver_id
  AND u.email = 'app.ds03@powerme.test'
  AND la.points_balance = 0
  AND (SELECT count(*) FROM loyalty_transactions lt WHERE lt.loyalty_account_id = la.id) = 1
  AND EXISTS (SELECT 1 FROM loyalty_transactions lt
              WHERE lt.loyalty_account_id = la.id AND lt.entry_no = 1
                AND lt.transaction_type = 'earn' AND lt.points = 600);

COMMIT;
