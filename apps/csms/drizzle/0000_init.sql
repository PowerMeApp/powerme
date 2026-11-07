-- =============================================================================
-- PowerMe CSMS — migration 0000_init (BE-06 / T11)
--
-- Migration VIẾT TAY (ADR-0008). Nguồn sự thật về cấu trúc DB. Schema Drizzle trong
-- apps/csms/src/db/schema/ phải khớp từng cột với file này.
--
-- Quy ước (ADR-0009):
--   * thời gian: timestamptz, lưu UTC
--   * bảng nhận dữ liệu từ trụ có CẢ cp_timestamp / pillar_timestamp (đồng hồ trụ, không
--     tin cậy) lẫn received_at (đồng hồ CSMS, tin cậy)
--   * điện năng: Wh, bigint · tiền: VND, bigint
--   * định danh kỹ thuật của trụ: serial_number
-- Khoá chính: bigint GENERATED ALWAYS AS IDENTITY (trừ bảng mở rộng dùng user_id).
-- Business key của ERD = UNIQUE riêng.
-- Partition theo tháng (ADR-0007): meter_values, ocpp_message_log.
--
-- Áp dụng: psql "$DATABASE_URL" -f apps/csms/drizzle/0000_init.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. ENUM
-- -----------------------------------------------------------------------------

-- users
CREATE TYPE user_role AS ENUM ('driver', 'operator_staff', 'admin');
CREATE TYPE user_account_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE staff_role AS ENUM ('manager', 'technician');

-- stations
CREATE TYPE operator_status AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE charge_point_lifecycle AS ENUM (
  'registered', 'awaiting_connection', 'in_service', 'offline', 'disabled', 'decommissioned'
);
-- Đủ 9 giá trị ChargePointStatus của OCPP 1.6, giữ nguyên chữ hoa/thường (T13).
CREATE TYPE connector_status AS ENUM (
  'Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV',
  'Finishing', 'Reserved', 'Unavailable', 'Faulted'
);
CREATE TYPE connector_type AS ENUM ('ccs2', 'chademo', 'gbt', 'type2');

-- sessions (T12/T13)
CREATE TYPE session_status AS ENUM (
  'pending', 'active', 'paused', 'stopping', 'closed', 'review', 'reconciled', 'orphaned', 'failed'
);
CREATE TYPE session_origin AS ENUM ('app_qr', 'rfid', 'hmi_password', 'free_vend');
CREATE TYPE payment_mode AS ENUM ('csms_billed', 'station_wallet', 'free');
CREATE TYPE billing_mode AS ENUM ('full', 'timed', 'energy_kwh', 'amount_vnd');
CREATE TYPE pause_cause AS ENUM ('ev', 'evse');
CREATE TYPE rfid_card_kind AS ENUM ('online', 'wallet', 'free_vend');
CREATE TYPE rfid_card_status AS ENUM ('unlinked', 'active', 'blocked');

-- tariffs
CREATE TYPE tariff_band AS ENUM ('off_peak', 'normal', 'peak');
CREATE TYPE discount_type AS ENUM ('percent', 'fixed_vnd');

-- reconciliation
CREATE TYPE reconciliation_record_type AS ENUM (
  'replay', 'duplicate', 'meter_gap', 'orphan_stop', 'unknown_id_tag'
);

-- billing
CREATE TYPE credit_account_status AS ENUM ('active', 'in_shortfall', 'closed');
CREATE TYPE credit_transaction_type AS ENUM ('top_up', 'session_debit', 'refund', 'adjustment');
CREATE TYPE top_up_status AS ENUM ('pending', 'credited', 'failed', 'expired', 'refunded');
CREATE TYPE e_invoice_status AS ENUM ('requested', 'issued', 'failed', 'needs_review');
CREATE TYPE loyalty_transaction_type AS ENUM ('earn', 'redeem', 'expire', 'adjust');

-- ops
CREATE TYPE fault_source AS ENUM ('ocpp', 'driver_report', 'operator');
CREATE TYPE fault_event_status AS ENUM ('raised', 'acknowledged', 'resetting', 'resolved');
CREATE TYPE maintenance_ticket_status AS ENUM ('open', 'in_progress', 'closed');
CREATE TYPE reservation_status AS ENUM (
  'active', 'fulfilled', 'cancelled_free', 'cancelled_late', 'expired_no_show', 'voided'
);
CREATE TYPE reservation_hold_mode AS ENUM ('reserve_now', 'csms_only');

-- ocpp-gateway
CREATE TYPE ocpp_direction AS ENUM ('in', 'out');

-- -----------------------------------------------------------------------------
-- 2. SEQUENCE cho số nghiệp vụ do CSMS cấp
-- -----------------------------------------------------------------------------

-- transactionId trả cho trụ trong StartTransaction.conf — int32 theo OCPP 1.6.
CREATE SEQUENCE sessions_transaction_no_seq AS integer START 1;
-- reservationId gửi xuống trụ trong ReserveNow — int32 theo OCPP 1.6.
CREATE SEQUENCE reservations_reservation_no_seq AS integer START 1;
CREATE SEQUENCE fault_events_event_no_seq AS bigint START 1;
CREATE SEQUENCE fault_reports_report_no_seq AS bigint START 1;
CREATE SEQUENCE maintenance_tickets_ticket_no_seq AS bigint START 1;

-- -----------------------------------------------------------------------------
-- 3. MODULE stations — operators, sites (cần trước users vì operator_staff → operators)
-- -----------------------------------------------------------------------------

-- Đơn vị vận hành trạm (Operator trong ERD).
CREATE TABLE operators (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_code    text NOT NULL,
  legal_name  text NOT NULL,
  address     text,
  status      operator_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operators_tax_code_key UNIQUE (tax_code)
);
COMMENT ON TABLE operators IS 'Đơn vị vận hành trạm sạc. BK = tax_code.';

-- Trạm (địa điểm) của một operator.
CREATE TABLE sites (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_code    text NOT NULL,
  operator_id  bigint NOT NULL REFERENCES operators (id),
  site_name    text NOT NULL,
  address      text,
  latitude     numeric(9, 6),
  longitude    numeric(9, 6),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_site_code_key UNIQUE (site_code)
);
CREATE INDEX sites_operator_id_idx ON sites (operator_id);
COMMENT ON TABLE sites IS 'Trạm sạc (địa điểm). BK = site_code.';

-- -----------------------------------------------------------------------------
-- 4. MODULE users — users, drivers, operator_staff
-- -----------------------------------------------------------------------------

-- MỘT bảng users có cột role (T11). Subtype có thuộc tính riêng → bảng mở rộng.
-- Không có bảng admins: admin chỉ là role.
CREATE TABLE users (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           text NOT NULL,
  full_name       text NOT NULL,
  phone_number    text,
  role            user_role NOT NULL,
  account_status  user_account_status NOT NULL DEFAULT 'active',
  -- Băm argon2; null khi tài khoản chưa đặt mật khẩu.
  password_hash   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);
CREATE INDEX users_phone_number_idx ON users (phone_number);
COMMENT ON TABLE users IS 'Người dùng mọi vai trò (driver / operator_staff / admin). BK = email.';

-- Bảng mở rộng của users với role = driver (ERD: Driver).
CREATE TABLE drivers (
  user_id           bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  consent_version   text NOT NULL,
  consent_given_at  timestamptz NOT NULL
);
COMMENT ON TABLE drivers IS 'Tài xế — mở rộng users; lưu phiên bản điều khoản đã đồng ý.';

-- Bảng mở rộng của users với role = operator_staff (ERD: OperatorStaff).
CREATE TABLE operator_staff (
  user_id      bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  operator_id  bigint NOT NULL REFERENCES operators (id),
  staff_role   staff_role NOT NULL
);
CREATE INDEX operator_staff_operator_id_idx ON operator_staff (operator_id);
COMMENT ON TABLE operator_staff IS 'Nhân viên vận hành — mở rộng users; thuộc một operator.';

-- -----------------------------------------------------------------------------
-- 5. MODULE stations — charge_points, connectors, connector_status_events,
--    charge_point_connections
-- -----------------------------------------------------------------------------

-- Trụ sạc (ERD: ChargingPillar). Định danh kỹ thuật = serial_number (ADR-0009).
CREATE TABLE charge_points (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  serial_number             text NOT NULL,
  -- Mã người vận hành đọc: PM-{model}-{tỉnh}-{số thứ tự} (ADR-0009). Null tới khi onboard.
  display_code              text,
  -- Null cho tới khi trụ được gắn vào site.
  site_id                   bigint REFERENCES sites (id),
  model                     text,
  firmware_version          text,
  rated_power_kw            numeric(7, 2),
  warranty_until            date,
  lifecycle                 charge_point_lifecycle NOT NULL DEFAULT 'registered',
  -- idTag trụ gửi khi free vend (ADR-0012). Null = trụ không bật free vend.
  free_vend_tag             text,
  reports_soc               boolean NOT NULL DEFAULT false,
  supports_reservation      boolean NOT NULL DEFAULT false,
  -- Lần kết nối hiện tại; khớp charge_point_connections.epoch.
  current_epoch             integer NOT NULL DEFAULT 0,
  -- Băm argon2 mật khẩu Basic Auth, Security Profile 2 (ADR-0011).
  basic_auth_password_hash  text,
  last_message_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT charge_points_serial_number_key UNIQUE (serial_number),
  CONSTRAINT charge_points_display_code_key UNIQUE (display_code)
);
CREATE INDEX charge_points_site_id_idx ON charge_points (site_id);
COMMENT ON TABLE charge_points IS 'Trụ sạc. BK = serial_number (đuôi URL /ocpp/{serialNumber}).';

-- Súng sạc. connector_no ∈ {1, 2}; 0 là toàn trụ theo OCPP và KHÔNG có dòng ở đây.
CREATE TABLE connectors (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_point_id    bigint NOT NULL REFERENCES charge_points (id),
  connector_no       smallint NOT NULL,
  connector_type     connector_type NOT NULL DEFAULT 'ccs2',
  max_power_kw       numeric(7, 2),
  status             connector_status NOT NULL DEFAULT 'Unavailable',
  status_changed_at  timestamptz,
  CONSTRAINT connectors_charge_point_id_connector_no_key UNIQUE (charge_point_id, connector_no),
  -- Siêu khoá để sessions tham chiếu bộ ba và giữ (connector_id, charge_point_id, connector_no)
  -- luôn nhất quán — khoá ADR-0010 dùng charge_point_id + connector_no.
  CONSTRAINT connectors_id_charge_point_id_connector_no_key UNIQUE (id, charge_point_id, connector_no),
  CONSTRAINT connectors_connector_no_check CHECK (connector_no IN (1, 2))
);
COMMENT ON TABLE connectors IS 'Súng sạc; tối đa 2 mỗi trụ (CHECK connector_no IN (1,2) + UNIQUE).';

-- Nhật ký StatusNotification. CSMS phản chiếu, không từ chối; chuyển trạng thái bất thường
-- so với bảng OCPP được gắn cờ unexpected_transition (T13). connector_no = 0 là sự kiện
-- toàn trụ → connector_id NULL.
CREATE TABLE connector_status_events (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_point_id        bigint NOT NULL REFERENCES charge_points (id),
  connector_no           smallint NOT NULL,
  connector_id           bigint REFERENCES connectors (id),
  status                 connector_status NOT NULL,
  error_code             text NOT NULL DEFAULT 'NoError',
  vendor_error_code      text,
  info                   text,
  -- Đồng hồ trụ — không tin cậy (ADR-0009).
  pillar_timestamp       timestamptz,
  -- Đồng hồ CSMS — tin cậy (ADR-0009).
  received_at            timestamptz NOT NULL DEFAULT now(),
  unexpected_transition  boolean NOT NULL DEFAULT false,
  CONSTRAINT connector_status_events_cp_no_received_key
    UNIQUE (charge_point_id, connector_no, received_at),
  CONSTRAINT connector_status_events_connector_no_check CHECK (connector_no IN (0, 1, 2)),
  CONSTRAINT connector_status_events_connector_id_check
    CHECK ((connector_no = 0) = (connector_id IS NULL))
);
CREATE INDEX connector_status_events_connector_id_received_at_idx
  ON connector_status_events (connector_id, received_at);
COMMENT ON TABLE connector_status_events IS 'Mọi StatusNotification đã nhận, kể cả chuyển trạng thái bất thường (gắn cờ).';

-- Mỗi lần trụ mở WebSocket = một epoch. Nền của phát hiện phát lại (EXP-01).
CREATE TABLE charge_point_connections (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_point_id  bigint NOT NULL REFERENCES charge_points (id),
  epoch            integer NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  -- Mã đóng WebSocket hoặc lý do CSMS tự đóng (ví dụ 1012 superseded).
  close_reason     text,
  remote_address   text,
  CONSTRAINT charge_point_connections_charge_point_id_epoch_key UNIQUE (charge_point_id, epoch)
);
CREATE INDEX charge_point_connections_opened_at_idx
  ON charge_point_connections (charge_point_id, opened_at);
COMMENT ON TABLE charge_point_connections IS 'Lịch sử kết nối WebSocket của trụ; epoch tăng mỗi lần nối lại.';

-- -----------------------------------------------------------------------------
-- 6. MODULE sessions — rfid_cards, vehicle_models, vehicles
-- -----------------------------------------------------------------------------

-- Sổ đăng ký thẻ (ADR-0012 gọi là id_tags; T11 chốt tên rfid_cards).
CREATE TABLE rfid_cards (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Giá trị idTag trên dây; OCPP 1.6 giới hạn 20 ký tự.
  card_identifier  text NOT NULL,
  card_kind        rfid_card_kind NOT NULL,
  driver_id        bigint REFERENCES drivers (user_id),
  status           rfid_card_status NOT NULL DEFAULT 'unlinked',
  issued_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfid_cards_card_identifier_key UNIQUE (card_identifier),
  CONSTRAINT rfid_cards_card_identifier_check CHECK (char_length(card_identifier) <= 20)
);
CREATE INDEX rfid_cards_driver_id_idx ON rfid_cards (driver_id);
COMMENT ON TABLE rfid_cards IS 'Thẻ RFID đã phát hành: online (xác thực) / wallet (thẻ ví) / free_vend. BK = card_identifier.';

-- Mẫu xe điện (ERD: VehicleModel).
CREATE TABLE vehicle_models (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand                 text NOT NULL,
  model_name            text NOT NULL,
  connector_type        connector_type NOT NULL DEFAULT 'ccs2',
  battery_capacity_kwh  numeric(6, 2),
  rated_range_km        integer,
  max_dc_kw             numeric(6, 2),
  is_vinfast            boolean NOT NULL DEFAULT false,
  CONSTRAINT vehicle_models_brand_model_name_key UNIQUE (brand, model_name)
);
COMMENT ON TABLE vehicle_models IS 'Danh mục mẫu xe. BK = (brand, model_name).';

-- Xe của tài xế.
CREATE TABLE vehicles (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plate_number      text NOT NULL,
  driver_id         bigint NOT NULL REFERENCES drivers (user_id),
  vehicle_model_id  bigint NOT NULL REFERENCES vehicle_models (id),
  is_default        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_plate_number_key UNIQUE (plate_number)
);
CREATE INDEX vehicles_driver_id_idx ON vehicles (driver_id);
-- Mỗi tài xế chỉ một xe mặc định.
CREATE UNIQUE INDEX vehicles_one_default_per_driver ON vehicles (driver_id) WHERE is_default;
COMMENT ON TABLE vehicles IS 'Xe của tài xế. BK = plate_number; một xe mặc định mỗi tài xế.';

-- -----------------------------------------------------------------------------
-- 7. MODULE tariffs — tariff_periods, promotions (sessions → promotions)
-- -----------------------------------------------------------------------------

-- Khung giá theo giờ trong ngày của một operator. VND/kWh integer (ADR-0009).
CREATE TABLE tariff_periods (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_id        bigint NOT NULL REFERENCES operators (id),
  band               tariff_band NOT NULL,
  -- Giờ địa phương Asia/Ho_Chi_Minh; khung qua nửa đêm tách thành hai dòng.
  time_start         time NOT NULL,
  time_end           time NOT NULL,
  price_per_kwh_vnd  bigint NOT NULL,
  effective_from     date NOT NULL,
  effective_to       date,
  CONSTRAINT tariff_periods_operator_band_range_key
    UNIQUE (operator_id, band, time_start, time_end, effective_from),
  CONSTRAINT tariff_periods_price_check CHECK (price_per_kwh_vnd >= 0),
  CONSTRAINT tariff_periods_effective_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
COMMENT ON TABLE tariff_periods IS 'Biểu giá theo khung giờ (off_peak / normal / peak) của operator.';

-- Mã khuyến mãi của operator.
CREATE TABLE promotions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_code  text NOT NULL,
  operator_id     bigint NOT NULL REFERENCES operators (id),
  discount_type   discount_type NOT NULL,
  -- percent: 0..100 · fixed_vnd: số VND.
  discount_value  bigint NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz NOT NULL,
  CONSTRAINT promotions_promotion_code_key UNIQUE (promotion_code),
  CONSTRAINT promotions_discount_value_check
    CHECK (discount_value >= 0 AND (discount_type <> 'percent' OR discount_value <= 100)),
  CONSTRAINT promotions_valid_check CHECK (valid_to > valid_from)
);
CREATE INDEX promotions_operator_id_idx ON promotions (operator_id);
COMMENT ON TABLE promotions IS 'Khuyến mãi. BK = promotion_code.';

-- -----------------------------------------------------------------------------
-- 8. MODULE sessions — sessions, session_pauses, meter_values (partition)
-- -----------------------------------------------------------------------------

-- Phiên sạc = một giao dịch OCPP (ERD: ChargingSession).
CREATE TABLE sessions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- transactionId CSMS cấp cho trụ (int32 OCPP).
  transaction_no       integer NOT NULL DEFAULT nextval('sessions_transaction_no_seq'),
  connector_id         bigint NOT NULL,
  charge_point_id      bigint NOT NULL REFERENCES charge_points (id),
  connector_no         smallint NOT NULL,
  -- idTag nguyên văn trong StartTransaction, kể cả khi không tra được thẻ (ADR-0010, ADR-0012).
  id_tag               text NOT NULL,
  driver_id            bigint REFERENCES drivers (user_id),
  vehicle_id           bigint REFERENCES vehicles (id),
  rfid_card_id         bigint REFERENCES rfid_cards (id),
  promotion_id         bigint REFERENCES promotions (id),
  origin               session_origin NOT NULL,
  payment_mode         payment_mode NOT NULL,
  billing_mode         billing_mode NOT NULL DEFAULT 'full',
  -- Theo billing_mode: phút (timed) · Wh (energy_kwh) · VND (amount_vnd). Null khi full.
  limit_value          bigint,
  status               session_status NOT NULL DEFAULT 'pending',
  -- Đồng hồ trụ lúc StartTransaction — không tin cậy.
  cp_started_at        timestamptz NOT NULL,
  -- Đồng hồ CSMS lúc nhận StartTransaction — tin cậy.
  received_started_at  timestamptz NOT NULL DEFAULT now(),
  cp_stopped_at        timestamptz,
  received_stopped_at  timestamptz,
  meter_start_wh       bigint NOT NULL,
  meter_stop_wh        bigint,
  -- Reason của StopTransaction, nguyên văn.
  stop_reason          text,
  -- Do engine đối soát gán: phiên được trụ gửi bù sau khi nối lại (ADR-0009).
  delivered_offline    boolean NOT NULL DEFAULT false,
  -- Dẫn xuất = meter_stop_wh - meter_start_wh; cập nhật cùng transaction lúc đóng phiên.
  energy_wh            bigint,
  -- Dẫn xuất = SUM(session_tariff_segments.amount_vnd) trừ khuyến mãi; cập nhật cùng transaction với ledger.
  total_cost_vnd       bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_transaction_no_key UNIQUE (transaction_no),
  -- ADR-0010: khoá tự nhiên chống StartTransaction phát lại.
  CONSTRAINT sessions_start_tx_natural_key
    UNIQUE (charge_point_id, connector_no, id_tag, meter_start_wh, cp_started_at),
  CONSTRAINT sessions_connector_fk
    FOREIGN KEY (connector_id, charge_point_id, connector_no)
    REFERENCES connectors (id, charge_point_id, connector_no),
  CONSTRAINT sessions_meter_check CHECK (meter_stop_wh IS NULL OR meter_stop_wh >= meter_start_wh),
  CONSTRAINT sessions_limit_value_check CHECK (limit_value IS NULL OR limit_value > 0)
);
CREATE INDEX sessions_connector_id_received_started_at_idx ON sessions (connector_id, received_started_at);
CREATE INDEX sessions_driver_id_idx ON sessions (driver_id);
CREATE INDEX sessions_status_idx ON sessions (status);
COMMENT ON TABLE sessions IS 'Phiên sạc / giao dịch OCPP. BK = transaction_no; khoá chống trùng ADR-0010.';

-- Khoảng tạm dừng trong phiên (SuspendedEV / SuspendedEVSE). Bảng thật, không JSON (T11).
CREATE TABLE session_pauses (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   bigint NOT NULL REFERENCES sessions (id),
  paused_at    timestamptz NOT NULL,
  resumed_at   timestamptz,
  pause_cause  pause_cause NOT NULL,
  CONSTRAINT session_pauses_session_id_paused_at_key UNIQUE (session_id, paused_at),
  CONSTRAINT session_pauses_resumed_check CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);
COMMENT ON TABLE session_pauses IS 'Khoảng tạm dừng trong phiên; cause = ev (xe) hoặc evse (trụ).';

-- Một SampledValue của MeterValues = một dòng. PARTITION theo tháng trên received_at (ADR-0007).
-- Postgres bắt PK/UNIQUE của bảng partition phải chứa khoá partition → PK (id, received_at).
-- BK (session_id, cp_timestamp, measurand) của ERD vì thế KHÔNG là UNIQUE; dedupe là việc của
-- engine đối soát (reconciliation_records.record_type = duplicate).
CREATE TABLE meter_values (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  session_id    bigint NOT NULL REFERENCES sessions (id),
  -- Đồng hồ trụ (timestamp của MeterValue) — không tin cậy.
  cp_timestamp  timestamptz NOT NULL,
  -- Đồng hồ CSMS — tin cậy; khoá partition.
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- Measurand OCPP nguyên văn: Energy.Active.Import.Register, Power.Active.Import, SoC, Voltage, Current.Import...
  measurand     text NOT NULL,
  value         numeric(14, 3) NOT NULL,
  unit          text,
  context       text,
  phase         text,
  CONSTRAINT meter_values_pkey PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX meter_values_session_id_cp_timestamp_idx ON meter_values (session_id, cp_timestamp, measurand);
COMMENT ON TABLE meter_values IS 'Chuỗi đo MeterValues (SoC, V, A, Wh). Partition theo tháng; job BullMQ tạo partition tháng kế.';

CREATE TABLE meter_values_2026_10 PARTITION OF meter_values
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE meter_values_2026_11 PARTITION OF meter_values
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE meter_values_2026_12 PARTITION OF meter_values
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE meter_values_2027_01 PARTITION OF meter_values
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
-- Lưới an toàn: dữ liệu ngoài các tháng trên không bị từ chối; job tạo partition sẽ tách ra sau.
CREATE TABLE meter_values_default PARTITION OF meter_values DEFAULT;

-- -----------------------------------------------------------------------------
-- 9. MODULE tariffs — session_tariff_segments (cần sessions)
-- -----------------------------------------------------------------------------

-- Phiên cắt theo khung giá: một phiên qua nhiều khung giờ thì có nhiều segment.
CREATE TABLE session_tariff_segments (
  session_id        bigint NOT NULL REFERENCES sessions (id),
  tariff_period_id  bigint NOT NULL REFERENCES tariff_periods (id),
  segment_start     timestamptz NOT NULL,
  segment_end       timestamptz NOT NULL,
  energy_wh         bigint NOT NULL,
  amount_vnd        bigint NOT NULL,
  CONSTRAINT session_tariff_segments_pkey PRIMARY KEY (session_id, tariff_period_id),
  CONSTRAINT session_tariff_segments_range_check CHECK (segment_end >= segment_start),
  CONSTRAINT session_tariff_segments_nonneg_check CHECK (energy_wh >= 0 AND amount_vnd >= 0)
);
COMMENT ON TABLE session_tariff_segments IS 'Bản tính giá của phiên theo từng khung giá; tổng amount_vnd = sessions.total_cost_vnd trước khuyến mãi.';

-- -----------------------------------------------------------------------------
-- 10. MODULE reconciliation — reconciliation_records
-- -----------------------------------------------------------------------------

-- Kết quả engine đối soát (BE-07): replay, duplicate, meter_gap, orphan_stop, unknown_id_tag.
CREATE TABLE reconciliation_records (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id            bigint NOT NULL REFERENCES sessions (id),
  -- Số thứ tự trong phiên, từ 1.
  record_no             smallint NOT NULL,
  record_type           reconciliation_record_type NOT NULL,
  gap_start             timestamptz,
  gap_end               timestamptz,
  -- Chênh lệch Wh giữa chuỗi meter và meter_stop - meter_start.
  energy_difference_wh  bigint,
  -- users.id (operator_staff / admin) đã xử lý; null = chưa.
  reviewed_by           bigint REFERENCES users (id),
  reviewed_at           timestamptz,
  resolution            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_records_session_id_record_no_key UNIQUE (session_id, record_no),
  CONSTRAINT reconciliation_records_record_no_check CHECK (record_no >= 1),
  CONSTRAINT reconciliation_records_reviewed_check CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX reconciliation_records_unreviewed_idx
  ON reconciliation_records (record_type, created_at) WHERE reviewed_at IS NULL;
COMMENT ON TABLE reconciliation_records IS 'Bản ghi đối soát của phiên; sessions.status = review khi còn bản ghi chưa xử lý.';

-- -----------------------------------------------------------------------------
-- 11. MODULE billing — credit_accounts, top_ups, credit_transactions, e_invoices,
--     invoice_adjustments, loyalty_accounts, loyalty_transactions
-- -----------------------------------------------------------------------------

-- Ví tín dụng — đúng một ví cho mỗi tài xế.
CREATE TABLE credit_accounts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id    bigint NOT NULL REFERENCES drivers (user_id),
  status       credit_account_status NOT NULL DEFAULT 'active',
  -- Dẫn xuất = SUM(credit_transactions.amount_vnd); cập nhật cùng transaction với dòng ledger.
  balance_vnd  bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_accounts_driver_id_key UNIQUE (driver_id)
);
COMMENT ON TABLE credit_accounts IS 'Ví tín dụng của tài xế (1-1). balance_vnd là snapshot của sổ cái.';

-- Nạp tiền qua cổng thanh toán (VNPay sandbox).
CREATE TABLE top_ups (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Mã giao dịch phía cổng (vnp_TransactionNo). Null tới khi cổng trả về.
  gateway_reference    text,
  credit_account_id    bigint NOT NULL REFERENCES credit_accounts (id),
  amount_vnd           bigint NOT NULL,
  points_discount_vnd  bigint NOT NULL DEFAULT 0,
  -- Dẫn xuất = amount_vnd - points_discount_vnd.
  amount_paid_vnd      bigint NOT NULL,
  status               top_up_status NOT NULL DEFAULT 'pending',
  -- Chống tạo trùng khi app retry.
  idempotency_key      text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  CONSTRAINT top_ups_gateway_reference_key UNIQUE (gateway_reference),
  CONSTRAINT top_ups_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT top_ups_amount_check
    CHECK (amount_vnd > 0 AND points_discount_vnd >= 0 AND amount_paid_vnd = amount_vnd - points_discount_vnd)
);
CREATE INDEX top_ups_credit_account_id_idx ON top_ups (credit_account_id);
COMMENT ON TABLE top_ups IS 'Giao dịch nạp ví. BK = gateway_reference; idempotency_key chống trùng.';

-- Sổ cái ví tín dụng, append-only.
CREATE TABLE credit_transactions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_account_id  bigint NOT NULL REFERENCES credit_accounts (id),
  entry_no           bigint NOT NULL,
  transaction_type   credit_transaction_type NOT NULL,
  -- Dương = cộng ví, âm = trừ ví.
  amount_vnd         bigint NOT NULL,
  -- Dẫn xuất = số dư sau dòng này; cập nhật cùng transaction với credit_accounts.balance_vnd.
  balance_after_vnd  bigint NOT NULL,
  session_id         bigint REFERENCES sessions (id),
  top_up_id          bigint REFERENCES top_ups (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_transactions_account_entry_no_key UNIQUE (credit_account_id, entry_no),
  CONSTRAINT credit_transactions_session_debit_check
    CHECK (transaction_type <> 'session_debit' OR session_id IS NOT NULL),
  CONSTRAINT credit_transactions_top_up_check
    CHECK (transaction_type <> 'top_up' OR top_up_id IS NOT NULL)
);
-- Một phiên tối đa một dòng trừ tiền.
CREATE UNIQUE INDEX credit_transactions_one_debit_per_session
  ON credit_transactions (session_id) WHERE transaction_type = 'session_debit';
-- Một top-up tối đa một dòng ledger.
CREATE UNIQUE INDEX credit_transactions_one_per_top_up
  ON credit_transactions (top_up_id) WHERE top_up_id IS NOT NULL;
COMMENT ON TABLE credit_transactions IS 'Sổ cái ví: nạp, trừ phiên, hoàn, điều chỉnh. BK = (credit_account_id, entry_no).';

-- Hoá đơn điện tử cho top-up đã credited — một hoá đơn cho mỗi top-up.
CREATE TABLE e_invoices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Số hoá đơn do nhà cung cấp HĐĐT cấp; null khi còn requested/failed.
  invoice_no      text,
  top_up_id       bigint NOT NULL REFERENCES top_ups (id),
  status          e_invoice_status NOT NULL DEFAULT 'requested',
  amount_vnd      bigint NOT NULL,
  vat_amount_vnd  bigint NOT NULL,
  issued_at       timestamptz,
  attempt_count   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT e_invoices_invoice_no_key UNIQUE (invoice_no),
  CONSTRAINT e_invoices_top_up_id_key UNIQUE (top_up_id),
  CONSTRAINT e_invoices_issued_check
    CHECK (status <> 'issued' OR (invoice_no IS NOT NULL AND issued_at IS NOT NULL))
);
COMMENT ON TABLE e_invoices IS 'Hoá đơn VAT cho lần nạp ví. BK = invoice_no; UNIQUE top_up_id.';

-- Điều chỉnh hoá đơn đã phát hành.
CREATE TABLE invoice_adjustments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  e_invoice_id   bigint NOT NULL REFERENCES e_invoices (id),
  adjustment_no  smallint NOT NULL,
  reason         text NOT NULL,
  -- Dương = tăng, âm = giảm.
  amount_vnd     bigint NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_adjustments_invoice_adjustment_no_key UNIQUE (e_invoice_id, adjustment_no),
  CONSTRAINT invoice_adjustments_adjustment_no_check CHECK (adjustment_no >= 1)
);
COMMENT ON TABLE invoice_adjustments IS 'Điều chỉnh hoá đơn. BK = (e_invoice_id, adjustment_no).';

-- Tài khoản điểm thưởng — đúng một cho mỗi tài xế.
CREATE TABLE loyalty_accounts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id       bigint NOT NULL REFERENCES drivers (user_id),
  -- Dẫn xuất = SUM(loyalty_transactions.points); cập nhật cùng transaction với ledger.
  points_balance  bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_accounts_driver_id_key UNIQUE (driver_id)
);
COMMENT ON TABLE loyalty_accounts IS 'Tài khoản điểm thưởng của tài xế (1-1).';

-- Sổ cái điểm thưởng.
CREATE TABLE loyalty_transactions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loyalty_account_id  bigint NOT NULL REFERENCES loyalty_accounts (id),
  entry_no            bigint NOT NULL,
  transaction_type    loyalty_transaction_type NOT NULL,
  -- Dương = cộng điểm, âm = trừ điểm.
  points              bigint NOT NULL,
  expires_at          timestamptz,
  session_id          bigint REFERENCES sessions (id),
  top_up_id           bigint REFERENCES top_ups (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_transactions_account_entry_no_key UNIQUE (loyalty_account_id, entry_no)
);
CREATE INDEX loyalty_transactions_session_id_idx ON loyalty_transactions (session_id);
CREATE INDEX loyalty_transactions_top_up_id_idx ON loyalty_transactions (top_up_id);
COMMENT ON TABLE loyalty_transactions IS 'Sổ cái điểm: earn / redeem / expire / adjust. BK = (loyalty_account_id, entry_no).';

-- -----------------------------------------------------------------------------
-- 12. MODULE stations/users (LERD-2 Ops) — fault_events, fault_reports,
--     maintenance_tickets «Should», policy_templates «Should», reservations «Should»
-- -----------------------------------------------------------------------------

-- Sự cố trên trụ/súng.
CREATE TABLE fault_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_no         bigint NOT NULL DEFAULT nextval('fault_events_event_no_seq'),
  charge_point_id  bigint NOT NULL REFERENCES charge_points (id),
  connector_id     bigint REFERENCES connectors (id),
  source           fault_source NOT NULL,
  -- ChargePointErrorCode OCPP 1.6 hoặc mã của nguồn khác, nguyên văn.
  error_code       text,
  status           fault_event_status NOT NULL DEFAULT 'raised',
  raised_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  bigint REFERENCES operator_staff (user_id),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  CONSTRAINT fault_events_event_no_key UNIQUE (event_no)
);
CREATE INDEX fault_events_charge_point_id_raised_at_idx ON fault_events (charge_point_id, raised_at);
CREATE INDEX fault_events_open_idx ON fault_events (status) WHERE status <> 'resolved';
COMMENT ON TABLE fault_events IS 'Sự cố: từ StatusNotification Faulted, báo cáo tài xế hoặc operator. BK = event_no.';

-- Tài xế báo lỗi từ app.
CREATE TABLE fault_reports (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_no       bigint NOT NULL DEFAULT nextval('fault_reports_report_no_seq'),
  driver_id       bigint NOT NULL REFERENCES drivers (user_id),
  connector_id    bigint NOT NULL REFERENCES connectors (id),
  description     text NOT NULL,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  fault_event_id  bigint REFERENCES fault_events (id),
  cleared_at      timestamptz,
  cleared_by      bigint REFERENCES operator_staff (user_id),
  CONSTRAINT fault_reports_report_no_key UNIQUE (report_no)
);
CREATE INDEX fault_reports_connector_id_idx ON fault_reports (connector_id);
CREATE INDEX fault_reports_fault_event_id_idx ON fault_reports (fault_event_id);
COMMENT ON TABLE fault_reports IS 'Báo lỗi của tài xế; có thể gắn vào một fault_event. BK = report_no.';

-- «Should» — phiếu bảo trì mở từ một fault_event.
CREATE TABLE maintenance_tickets (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_no       bigint NOT NULL DEFAULT nextval('maintenance_tickets_ticket_no_seq'),
  fault_event_id  bigint NOT NULL REFERENCES fault_events (id),
  -- Null khi phiếu mở mà chưa giao.
  assigned_to     bigint REFERENCES operator_staff (user_id),
  status          maintenance_ticket_status NOT NULL DEFAULT 'open',
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CONSTRAINT maintenance_tickets_ticket_no_key UNIQUE (ticket_no),
  CONSTRAINT maintenance_tickets_closed_check CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX maintenance_tickets_fault_event_id_idx ON maintenance_tickets (fault_event_id);
COMMENT ON TABLE maintenance_tickets IS '«Should» — phiếu bảo trì. BK = ticket_no.';

-- «Should» — mẫu chính sách do admin soạn.
CREATE TABLE policy_templates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_code  text NOT NULL,
  -- users.id với role = admin (không có bảng admins).
  created_by     bigint NOT NULL REFERENCES users (id),
  template_type  text NOT NULL,
  content        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_templates_template_code_key UNIQUE (template_code)
);
COMMENT ON TABLE policy_templates IS '«Should» — mẫu chính sách/điều khoản. BK = template_code.';

-- «Should» — đặt chỗ súng sạc. EXP-02: tính duy nhất phải ở DB, không ở thư viện.
CREATE TABLE reservations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- reservationId gửi xuống trụ (int32 OCPP).
  reservation_no  integer NOT NULL DEFAULT nextval('reservations_reservation_no_seq'),
  driver_id       bigint NOT NULL REFERENCES drivers (user_id),
  connector_id    bigint NOT NULL REFERENCES connectors (id),
  status          reservation_status NOT NULL DEFAULT 'active',
  -- reserve_now: gửi ReserveNow xuống trụ · csms_only: chỉ giữ chỗ phía CSMS.
  hold_mode       reservation_hold_mode NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT reservations_reservation_no_key UNIQUE (reservation_no),
  CONSTRAINT reservations_expires_check CHECK (expires_at > created_at)
);
-- Một đặt chỗ active cho mỗi connector và mỗi driver.
CREATE UNIQUE INDEX reservations_one_active_per_connector ON reservations (connector_id) WHERE status = 'active';
CREATE UNIQUE INDEX reservations_one_active_per_driver ON reservations (driver_id) WHERE status = 'active';
COMMENT ON TABLE reservations IS '«Should» — đặt chỗ súng. BK = reservation_no; partial UNIQUE giữ một active/connector và /driver.';

-- -----------------------------------------------------------------------------
-- 13. MODULE ocpp-gateway — ocpp_message_log (partition, append-only)
-- -----------------------------------------------------------------------------

-- Mọi frame OCPP hai chiều, ghi TRƯỚC khi gọi handler (ADR-0005). Chỉ INSERT.
-- Cột khớp định dạng trace của lab: received_at, cp, dir, type, id, action, cp_timestamp, epoch, raw.
CREATE TABLE ocpp_message_log (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  charge_point_id  bigint NOT NULL REFERENCES charge_points (id),
  -- charge_point_connections.epoch lúc frame đi qua.
  epoch            integer NOT NULL,
  direction        ocpp_direction NOT NULL,
  -- 2 = CALL · 3 = CALLRESULT · 4 = CALLERROR.
  message_type     smallint NOT NULL,
  -- MessageId OCPP-J; ghép CALL với CALLRESULT/CALLERROR.
  unique_id        text NOT NULL,
  -- Chỉ có ở CALL.
  action           text,
  -- Trường timestamp trong payload nếu có — đồng hồ trụ.
  cp_timestamp     timestamptz,
  -- Đồng hồ CSMS; khoá partition.
  received_at      timestamptz NOT NULL DEFAULT now(),
  -- Frame nguyên văn đã parse JSON.
  raw              jsonb NOT NULL,
  CONSTRAINT ocpp_message_log_pkey PRIMARY KEY (id, received_at),
  CONSTRAINT ocpp_message_log_message_type_check CHECK (message_type IN (2, 3, 4)),
  CONSTRAINT ocpp_message_log_action_check CHECK ((message_type = 2) = (action IS NOT NULL))
) PARTITION BY RANGE (received_at);
CREATE INDEX ocpp_message_log_cp_received_at_idx ON ocpp_message_log (charge_point_id, received_at);
CREATE INDEX ocpp_message_log_cp_unique_id_idx ON ocpp_message_log (charge_point_id, unique_id);
CREATE INDEX ocpp_message_log_action_idx ON ocpp_message_log (action, received_at);
COMMENT ON TABLE ocpp_message_log IS 'Nhật ký frame OCPP append-only (ADR-0005). Partition theo tháng; xoá partition cũ theo chính sách lưu trữ.';

CREATE TABLE ocpp_message_log_2026_10 PARTITION OF ocpp_message_log
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE ocpp_message_log_2026_11 PARTITION OF ocpp_message_log
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE ocpp_message_log_2026_12 PARTITION OF ocpp_message_log
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE ocpp_message_log_2027_01 PARTITION OF ocpp_message_log
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE ocpp_message_log_default PARTITION OF ocpp_message_log DEFAULT;

-- Append-only ở mức DB: chặn UPDATE/DELETE trên nhật ký (trừ xoá partition bằng DROP TABLE,
-- vốn không qua trigger). Người vận hành muốn sửa thì phải DISABLE TRIGGER có chủ ý.
CREATE FUNCTION ocpp_message_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ocpp_message_log là append-only (ADR-0005): không % được', TG_OP;
END;
$$;
CREATE TRIGGER ocpp_message_log_no_update_delete
  BEFORE UPDATE OR DELETE ON ocpp_message_log
  FOR EACH ROW EXECUTE FUNCTION ocpp_message_log_append_only();

COMMIT;
