-- =============================================================================
-- PowerMe CSMS — migration 0014_erd-alignment-varchar-audit (BE-16, WP2) — đợt 2
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0012. Schema Drizzle phải khớp file này.
-- Tham chiếu: mục C1 và C2 của `0011_physical-guide-alignment.sql` (Ân, WP1; hướng dẫn ERD §9.1).
--
--   C1  mã và định danh chuẩn: text → VARCHAR(n) theo độ dài thật (48 cột; nguồn từng độ dài ghi
--       trong file của Ân: OCPP / RFC 5321 / E.164 / MST / VNPay / code / giả định [A]). Văn bản tự
--       do (tên, địa chỉ, mô tả, ghi chú, lý do, thông báo, băm) giữ TEXT. Hai CHECK char_length ≤ 20
--       (rfid_cards.card_identifier, driver_charge_intents.id_tag) bị thay bằng chính kiểu VARCHAR(20).
--       LỆCH FILE CỦA ÂN: charge_settlement_jobs.reason là VARCHAR(50), không phải 30 (giả định [A]
--       của Ân). Mã chạy thật ghi 'tariff_coverage_or_boundary_meter_required' (42 ký tự,
--       charge-settlement.service.ts) — với 30 thì quyết toán rơi vào transient_error (test wf01 T72
--       "tariff gap/overlap" bắt được). Ân xác nhận lại độ dài này.
--   C2  cột kiểm toán: created_at / updated_at cho các bảng còn thiếu (NOT NULL DEFAULT now(); dòng
--       cũ nhận thời điểm chạy migration — không có dữ liệu thật hơn để backfill).
--
-- KIỂM TRƯỚC (C1): migration đo max(char_length) của từng cột và DỪNG, không đổi gì, nếu có giá trị
-- dài hơn độ dài mới — thông báo liệt kê bảng.cột, độ dài thực, độ dài mới. Xử lý dữ liệu tay rồi chạy lại.
--
-- LƯU Ý VẬN HÀNH: ALTER … TYPE varchar(n) từ text ghi lại cả bảng (ACCESS EXCLUSIVE). Với
-- ocpp_message_log và meter_values (bảng partition, có thể lớn) nên chạy ngoài giờ tải; trigger
-- append-only chỉ chặn UPDATE/DELETE nên không bị kích hoạt khi ghi lại bảng.
-- Cả file là MỘT transaction.
-- =============================================================================

BEGIN;

-- ---- C1: kiểm độ dài hiện có ----
DO $$
DECLARE
  r record;
  mx integer;
  bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('users', 'email', 254),
    ('users', 'phone_number', 16),
    ('drivers', 'consent_version', 20),
    ('operators', 'tax_code', 14),
    ('sites', 'site_code', 20),
    ('charge_points', 'serial_number', 25),
    ('charge_points', 'display_code', 100),
    ('charge_points', 'model', 20),
    ('charge_points', 'firmware_version', 50),
    ('charge_points', 'free_vend_tag', 20),
    ('connector_status_events', 'error_code', 30),
    ('connector_status_events', 'vendor_error_code', 50),
    ('connector_status_events', 'info', 50),
    ('remote_commands', 'action', 40),
    ('remote_commands', 'idempotency_key', 64),
    ('fault_events', 'error_code', 50),
    ('policy_templates', 'template_code', 30),
    ('policy_templates', 'template_type', 30),
    ('promotions', 'promotion_code', 20),
    ('sessions', 'id_tag', 20),
    ('sessions', 'stop_reason', 20),
    ('session_status_history', 'event', 50),
    ('session_status_history', 'actor', 50),
    ('meter_values', 'measurand', 40),
    ('meter_values', 'unit', 20),
    ('meter_values', 'context', 20),
    ('meter_values', 'phase', 10),
    ('vehicles', 'plate_number', 12),
    ('rfid_cards', 'card_identifier', 20),
    ('top_ups', 'gateway_reference', 100),
    ('top_ups', 'idempotency_key', 64),
    ('top_ups', 'gateway_transaction_no', 20),
    ('top_ups', 'late_gateway_ref', 100),
    ('e_invoices', 'invoice_no', 20),
    ('ocpp_message_log', 'unique_id', 36),
    ('ocpp_message_log', 'action', 40),
    ('charge_point_connections', 'remote_address', 64),
    ('driver_charge_intents', 'id_tag', 20),
    ('driver_charge_intents', 'idempotency_key', 64),
    ('driver_charge_intents', 'request_hash', 64),
    ('driver_charge_intents', 'state', 20),
    ('driver_stop_intents', 'idempotency_key', 64),
    ('driver_stop_intents', 'state', 20),
    ('driver_stop_attempts', 'kind', 20),
    ('driver_charge_intent_events', 'event', 50),
    ('charge_settlement_jobs', 'state', 20),
    ('charge_settlement_jobs', 'reason', 50),
    ('charge_settlement_jobs', 'last_error_code', 50)
  ) AS v(tbl, col, len)
  LOOP
    EXECUTE format('SELECT max(char_length(%I)) FROM %I', r.col, r.tbl) INTO mx;
    IF mx IS NOT NULL AND mx > r.len THEN
      bad := bad || format(E'\n  %s.%s: dài nhất %s > varchar(%s)', r.tbl, r.col, mx, r.len);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION '0014/C1: có giá trị dài hơn độ dài mới, không đổi gì:%', bad;
  END IF;
END $$;

-- ---- C1: đổi kiểu ----
ALTER TABLE users
  ALTER COLUMN email TYPE varchar(254),
  ALTER COLUMN phone_number TYPE varchar(16);
ALTER TABLE drivers
  ALTER COLUMN consent_version TYPE varchar(20);
ALTER TABLE operators
  ALTER COLUMN tax_code TYPE varchar(14);
ALTER TABLE sites
  ALTER COLUMN site_code TYPE varchar(20);
ALTER TABLE charge_points
  ALTER COLUMN serial_number TYPE varchar(25),
  ALTER COLUMN display_code TYPE varchar(100),
  ALTER COLUMN model TYPE varchar(20),
  ALTER COLUMN firmware_version TYPE varchar(50),
  ALTER COLUMN free_vend_tag TYPE varchar(20);
ALTER TABLE connector_status_events
  ALTER COLUMN error_code TYPE varchar(30),
  ALTER COLUMN vendor_error_code TYPE varchar(50),
  ALTER COLUMN info TYPE varchar(50);
ALTER TABLE remote_commands
  ALTER COLUMN action TYPE varchar(40),
  ALTER COLUMN idempotency_key TYPE varchar(64);
ALTER TABLE fault_events
  ALTER COLUMN error_code TYPE varchar(50);
ALTER TABLE policy_templates
  ALTER COLUMN template_code TYPE varchar(30),
  ALTER COLUMN template_type TYPE varchar(30);
ALTER TABLE promotions
  ALTER COLUMN promotion_code TYPE varchar(20);
ALTER TABLE sessions
  ALTER COLUMN id_tag TYPE varchar(20),
  ALTER COLUMN stop_reason TYPE varchar(20);
ALTER TABLE session_status_history
  ALTER COLUMN event TYPE varchar(50),
  ALTER COLUMN actor TYPE varchar(50);
ALTER TABLE meter_values
  ALTER COLUMN measurand TYPE varchar(40),
  ALTER COLUMN unit TYPE varchar(20),
  ALTER COLUMN context TYPE varchar(20),
  ALTER COLUMN phase TYPE varchar(10);
ALTER TABLE vehicles
  ALTER COLUMN plate_number TYPE varchar(12);
ALTER TABLE rfid_cards
  DROP CONSTRAINT rfid_cards_card_identifier_check,
  ALTER COLUMN card_identifier TYPE varchar(20);
ALTER TABLE top_ups
  ALTER COLUMN gateway_reference TYPE varchar(100),
  ALTER COLUMN idempotency_key TYPE varchar(64),
  ALTER COLUMN gateway_transaction_no TYPE varchar(20),
  ALTER COLUMN late_gateway_ref TYPE varchar(100);
ALTER TABLE e_invoices
  ALTER COLUMN invoice_no TYPE varchar(20);
ALTER TABLE ocpp_message_log
  ALTER COLUMN unique_id TYPE varchar(36),
  ALTER COLUMN action TYPE varchar(40);
ALTER TABLE charge_point_connections
  ALTER COLUMN remote_address TYPE varchar(64);
ALTER TABLE driver_charge_intents
  DROP CONSTRAINT driver_charge_intents_id_tag_check,
  ALTER COLUMN id_tag TYPE varchar(20),
  ALTER COLUMN idempotency_key TYPE varchar(64),
  ALTER COLUMN request_hash TYPE varchar(64),
  ALTER COLUMN state TYPE varchar(20);
ALTER TABLE driver_stop_intents
  ALTER COLUMN idempotency_key TYPE varchar(64),
  ALTER COLUMN state TYPE varchar(20);
ALTER TABLE driver_stop_attempts
  ALTER COLUMN kind TYPE varchar(20);
ALTER TABLE driver_charge_intent_events
  ALTER COLUMN event TYPE varchar(50);
ALTER TABLE charge_settlement_jobs
  ALTER COLUMN state TYPE varchar(20),
  ALTER COLUMN reason TYPE varchar(50),
  ALTER COLUMN last_error_code TYPE varchar(50);

-- ---- C2: cột kiểm toán ----
ALTER TABLE operators ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sites ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE connectors ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE remote_commands ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE fault_events ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE fault_reports ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE maintenance_tickets ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tariff_periods ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE promotions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE reservations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE vehicles ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE vehicle_models ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE rfid_cards ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE session_pauses ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE session_tariff_segments ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE reconciliation_records ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE top_ups ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE e_invoices ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE driver_stop_intents ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE driver_charge_intents ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE charge_settlement_jobs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

COMMIT;
