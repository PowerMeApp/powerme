-- Dữ liệu mẫu cho demo Review 2 (BE-09) — nạp bằng script trong repo để demo lặp lại được.
--
-- Vì sao tồn tại: hướng dẫn Review 2 mục 9.2 yêu cầu dữ liệu mẫu được nạp bằng script, không gõ
-- tay. File này idempotent (ON CONFLICT DO NOTHING / WHERE NOT EXISTS): chạy lại không nhân đôi
-- dòng và không đụng tới phiên/meter đã phát sinh. Muốn làm lại từ đầu: `npm run demo:reset`.
--
-- Tên cột/enum đối chiếu với src/db/schema/*.ts và drizzle/0000_init.sql.
-- Quyết định đáng chú ý:
--   * Trụ seed ở lifecycle 'awaiting_connection' — đúng như test tích hợp EXP-01. Gateway
--     (connection-registry.open) tự chuyển sang 'in_service' khi socket mở, không chờ Boot (STM-3).
--   * Hai connector (1, 2), mặc định status 'Unavailable' cho tới StatusNotification đầu tiên.
--   * Thẻ lạ KHÔNG được seed (kịch bản DS-03c cần một idTag không có trong rfid_cards).
--   * Giá VND/kWh ở đây là GIÁ MẪU để demo, không phải biểu giá thật của PowerMe.

BEGIN;

-- Operator + site (TP.HCM) -------------------------------------------------------------
INSERT INTO operators (tax_code, legal_name, address, status)
VALUES ('0312345678', 'Cong ty PowerMe Demo', '1 Nguyen Hue, Quan 1, TP.HCM', 'active')
ON CONFLICT ON CONSTRAINT operators_tax_code_key DO NOTHING;

INSERT INTO sites (site_code, operator_id, site_name, address, latitude, longitude)
SELECT 'HCM-DEMO-01', o.id, 'Tram sac demo Quan 1', '1 Nguyen Hue, Quan 1, TP.HCM', 10.776889, 106.700806
FROM operators o
WHERE o.tax_code = '0312345678'
ON CONFLICT ON CONSTRAINT sites_site_code_key DO NOTHING;

-- Trụ D1-120 và hai súng ---------------------------------------------------------------
INSERT INTO charge_points (
  serial_number, display_code, site_id, model, firmware_version, rated_power_kw,
  lifecycle, reports_soc, supports_reservation
)
SELECT 'RH24D1-00001', 'PM-D1-HCM-0001', s.id, 'D1-120', '4.0.4.22', 120,
       'awaiting_connection', true, true
FROM sites s
WHERE s.site_code = 'HCM-DEMO-01'
ON CONFLICT ON CONSTRAINT charge_points_serial_number_key DO NOTHING;

INSERT INTO connectors (charge_point_id, connector_no, connector_type, max_power_kw)
SELECT cp.id, n.no, 'ccs2', 60
FROM charge_points cp
CROSS JOIN (VALUES (1), (2)) AS n(no)
WHERE cp.serial_number = 'RH24D1-00001'
ON CONFLICT ON CONSTRAINT connectors_charge_point_id_connector_no_key DO NOTHING;

-- Tài xế mẫu + ví tín dụng 500.000 VND --------------------------------------------------
INSERT INTO users (email, full_name, phone_number, role, account_status)
VALUES ('driver.demo@powerme.test', 'Nguyen Van Demo', '0900000001', 'driver', 'active')
ON CONFLICT ON CONSTRAINT users_email_key DO NOTHING;

INSERT INTO drivers (user_id, consent_version, consent_given_at)
SELECT u.id, '2026-09', now()
FROM users u
WHERE u.email = 'driver.demo@powerme.test'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO credit_accounts (driver_id, status, balance_vnd)
SELECT u.id, 'active', 500000
FROM users u
WHERE u.email = 'driver.demo@powerme.test'
ON CONFLICT ON CONSTRAINT credit_accounts_driver_id_key DO NOTHING;

-- Sổ cái cần một top_up làm gốc (CHECK credit_transactions_top_up_check).
INSERT INTO top_ups (
  gateway_reference, credit_account_id, amount_vnd, points_discount_vnd, amount_paid_vnd,
  status, idempotency_key, completed_at
)
SELECT 'DEMO-TOPUP-0001', ca.id, 500000, 0, 500000, 'credited', 'demo-seed-topup-0001', now()
FROM credit_accounts ca
JOIN users u ON u.id = ca.driver_id
WHERE u.email = 'driver.demo@powerme.test'
ON CONFLICT ON CONSTRAINT top_ups_idempotency_key_key DO NOTHING;

INSERT INTO credit_transactions (
  credit_account_id, entry_no, transaction_type, amount_vnd, balance_after_vnd, top_up_id
)
SELECT t.credit_account_id, 1, 'top_up', 500000, 500000, t.id
FROM top_ups t
WHERE t.idempotency_key = 'demo-seed-topup-0001'
ON CONFLICT ON CONSTRAINT credit_transactions_account_entry_no_key DO NOTHING;

-- Free vend của HMI (mật khẩu 123456 trên màn hình) gửi StartTransaction idTag 'HMI-FREEVEND' không Authorize;
-- sessions.service classifyIdTag nhận ra qua charge_points.free_vend_tag → origin=free_vend, payment_mode=free.
UPDATE charge_points SET free_vend_tag = 'HMI-FREEVEND'
WHERE serial_number = 'RH24D1-00001' AND free_vend_tag IS NULL;

-- Thẻ RFID mẫu (thẻ lạ cố ý KHÔNG có ở đây; tên khớp simulator/d1-hmi/model.mjs CARDS) -------------------------------------------------
--   DEMO-CARD-0001  : online, gắn tài xế mẫu, active   → origin=rfid, payment_mode=csms_billed
--   DEMO-WALLET-0001  : wallet (thẻ ví tại trụ), active   → origin=rfid, payment_mode=station_wallet
--   DEMO-BLOCKED-01 : online, blocked                    → Authorize trả Blocked (HMI không có nút thẻ này; dùng scripted-station ds-01b)
--   DEMO-UNKNOWN-999 (nút "thẻ lạ" của HMI) và UNKNOWN-TAG-99 (ds-03c) cố ý không seed
INSERT INTO rfid_cards (card_identifier, card_kind, driver_id, status)
SELECT 'DEMO-CARD-0001', 'online', u.id, 'active'
FROM users u
WHERE u.email = 'driver.demo@powerme.test'
ON CONFLICT ON CONSTRAINT rfid_cards_card_identifier_key DO NOTHING;

INSERT INTO rfid_cards (card_identifier, card_kind, driver_id, status)
VALUES ('DEMO-WALLET-0001', 'wallet', NULL, 'active')
ON CONFLICT ON CONSTRAINT rfid_cards_card_identifier_key DO NOTHING;

INSERT INTO rfid_cards (card_identifier, card_kind, driver_id, status)
VALUES ('DEMO-BLOCKED-01', 'online', NULL, 'blocked')
ON CONFLICT ON CONSTRAINT rfid_cards_card_identifier_key DO NOTHING;

-- Bảng giá mẫu (giờ địa phương; khung qua nửa đêm tách hai dòng) ---------------------------
INSERT INTO tariff_periods (operator_id, band, time_start, time_end, price_per_kwh_vnd, effective_from)
SELECT o.id, v.band::tariff_band, v.t_start::time, v.t_end::time, v.price, DATE '2026-01-01'
FROM operators o
CROSS JOIN (VALUES
  ('off_peak', '00:00', '04:00', 2800),
  ('normal',   '04:00', '09:30', 3800),
  ('peak',     '09:30', '11:30', 5500),
  ('normal',   '11:30', '17:00', 3800),
  ('peak',     '17:00', '20:00', 5500),
  ('normal',   '20:00', '22:00', 3800),
  ('off_peak', '22:00', '24:00', 2800)
) AS v(band, t_start, t_end, price)
WHERE o.tax_code = '0312345678'
ON CONFLICT ON CONSTRAINT tariff_periods_operator_band_range_key DO NOTHING;

COMMIT;
