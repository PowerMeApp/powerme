-- =============================================================================
-- PowerMe CSMS — migration 0011_erd-alignment-additive (BE-16, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0010. Schema Drizzle phải khớp file này.
-- Tham chiếu: 0009_erd-alignment-additive.sql của Ân (WP1) — danh sách A2–A6 và 20 index theo
-- đúng file đó; số file ở repo khác vì repo đã có 0009 riêng (bỏ payment_mode free).
--
--   A2  bảng admins (ISA: một bảng cho mỗi subtype) + backfill từ users.role = 'admin'
--   A3  sessions.reservation_id → reservations, UNIQUE (BR-P29)
--   A4  credit_transactions.reservation_id → reservations, UNIQUE + CHECK (BR-P27)
--   A5  index cho mọi FK chưa có index (20 index; xem bảng đối chiếu trong docs/NHAT-KY-ERD-ALIGNMENT.md)
--   A6  bỏ FK dư sessions_charge_point_id_fkey (FK tổng hợp sessions_connector_fk đã phủ)
--
-- Phụ thuộc 0010: CHECK ở A4 dùng giá trị enum `reservation_fee`, đã COMMIT ở 0010.
-- Cả file là MỘT transaction. Không đổi hành vi nghiệp vụ.
-- =============================================================================

BEGIN;

-- A2. ISA: users → drivers / operator_staff / admins. Backfill: mọi user role admin có một dòng.
CREATE TABLE admins (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO admins (user_id) SELECT id FROM users WHERE role = 'admin';
COMMENT ON TABLE admins IS
  'ISA subtype: quản trị viên nền tảng PowerMe (users.role = admin). PK = FK tới users. Mọi nơi tạo user admin phải chèn thêm dòng ở đây.';

-- A3. Quyết định 10: Reservation được hoàn tất bởi tối đa MỘT ChargingSession (0..1 : 0..1, BR-P29).
-- Chỉ cột + ràng buộc; code gán giá trị lúc bắt đầu phiên thuộc tính năng đặt chỗ (Should).
ALTER TABLE sessions
  ADD COLUMN reservation_id bigint REFERENCES reservations(id),
  ADD CONSTRAINT sessions_reservation_id_key UNIQUE (reservation_id);

-- A4. Quyết định 11: Reservation phát sinh tối đa MỘT CreditTransaction phí (0..1 : 0..1, BR-P27).
-- Có phí ⇔ có reservation_id. Giá trị 'reservation_fee' đã commit ở 0010.
ALTER TABLE credit_transactions
  ADD COLUMN reservation_id bigint REFERENCES reservations(id),
  ADD CONSTRAINT credit_transactions_reservation_id_key UNIQUE (reservation_id),
  ADD CONSTRAINT credit_transactions_reservation_fee_check
    CHECK ((transaction_type = 'reservation_fee') = (reservation_id IS NOT NULL));

-- A5. Mọi FK có index bắt đầu bằng các cột của FK (hướng dẫn ERD của giảng viên, checklist Physical).
-- 20 index theo danh sách của Ân; kiểm bằng truy vấn pg_constraint/pg_index (test
-- fk-index-coverage.integration.test.ts). credit_transactions.reservation_id đã có UNIQUE;
-- sessions_connector_fk, charging_statements_driver_id_fkey và top_ups_refunded_by_fkey là ngoại lệ
-- có lý do (xem test).
CREATE INDEX fault_events_connector_id_idx            ON fault_events(connector_id);
CREATE INDEX fault_events_acknowledged_by_idx         ON fault_events(acknowledged_by);
CREATE INDEX fault_events_reset_command_id_idx        ON fault_events(reset_command_id);
CREATE INDEX fault_reports_driver_id_idx              ON fault_reports(driver_id);
CREATE INDEX fault_reports_cleared_by_idx             ON fault_reports(cleared_by);
CREATE INDEX maintenance_tickets_assigned_to_idx      ON maintenance_tickets(assigned_to);
CREATE INDEX policy_templates_created_by_idx          ON policy_templates(created_by);
CREATE INDEX reconciliation_records_reviewed_by_idx   ON reconciliation_records(reviewed_by);
CREATE INDEX remote_commands_requested_by_idx         ON remote_commands(requested_by);
CREATE INDEX session_tariff_segments_tariff_period_id_idx ON session_tariff_segments(tariff_period_id);
CREATE INDEX sessions_vehicle_id_idx                  ON sessions(vehicle_id);
CREATE INDEX sessions_promotion_id_idx                ON sessions(promotion_id);
CREATE INDEX sessions_rfid_card_id_idx                ON sessions(rfid_card_id);
CREATE INDEX vehicles_vehicle_model_id_idx            ON vehicles(vehicle_model_id);
-- bảng kỹ thuật (WP3; không có trong schema Drizzle — chỉ SQL)
CREATE INDEX charge_tariff_boundary_evidence_recorded_by_idx ON charge_tariff_boundary_evidence(recorded_by);
CREATE INDEX driver_charge_intent_events_intent_id_idx ON driver_charge_intent_events(intent_id);
CREATE INDEX driver_charge_intent_events_actor_id_idx  ON driver_charge_intent_events(actor_id);
CREATE INDEX driver_charge_intents_vehicle_id_idx      ON driver_charge_intents(vehicle_id);
CREATE INDEX driver_start_recoveries_operator_user_id_idx ON driver_start_recoveries(operator_user_id);
CREATE INDEX driver_stop_attempts_operator_user_id_idx ON driver_stop_attempts(operator_user_id);

-- A6. Quy tắc "không FK dư": sessions.charge_point_id → charge_points đã được suy ra từ FK tổng hợp
-- sessions(connector_id, charge_point_id, connector_no) → connectors(id, charge_point_id, connector_no),
-- mà connectors.charge_point_id tham chiếu charge_points. Cột giữ nguyên (khoá chống trùng ADR-0010
-- và JOIN vẫn dùng nó). KIỂM TRƯỚC khi bỏ: FK tổng hợp phải tồn tại và phủ charge_point_id; không thì
-- migration dừng, KHÔNG bỏ FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conname = 'sessions_connector_fk'
      AND c.conrelid = 'sessions'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'connectors'::regclass
      AND a.attname = 'charge_point_id'
  ) THEN
    RAISE EXCEPTION '0011/A6: FK tổng hợp sessions_connector_fk không phủ sessions.charge_point_id — không bỏ sessions_charge_point_id_fkey';
  END IF;
END $$;
ALTER TABLE sessions DROP CONSTRAINT sessions_charge_point_id_fkey;

COMMIT;
