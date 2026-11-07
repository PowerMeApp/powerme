-- =============================================================================
-- PowerMe CSMS — migration 0001_quyet-dinh-be-11 (BE-11, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000_init. Schema Drizzle trong
-- apps/csms/src/db/schema/ phải khớp từng cột với 0000 + file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0001.md.
--
-- Nội dung:
--   A. Enum: payment_mode += unattributed · reconciliation_record_type += conflict, late_sample
--            · enum mới remote_command_status                      (ADR-0012, BM02 F10)
--   B. Đổi tên connector_status_events.pillar_timestamp → cp_timestamp  (ADR-0009)
--   C. Cột mới: sessions.orphaned_at · meter_values.replayed/epoch · ocpp_message_log.replayed (F09)
--   D. Bảng mới: remote_commands (F08) · session_status_history (F13, append-only)
--
-- GHI CHÚ VỀ TRANSACTION: từ PostgreSQL 12 `ALTER TYPE … ADD VALUE` chạy được trong khối
-- BEGIN/COMMIT, với điều kiện giá trị mới KHÔNG được dùng trước khi COMMIT. File này chỉ THÊM
-- giá trị, không INSERT/CHECK/DEFAULT nào dùng chúng → cả file nằm trong MỘT transaction
-- (đã chạy thật trên PostgreSQL 16 và 17). Muốn dùng giá trị mới trong DDL/DML thì phải để ở
-- migration sau.
-- 11 enum tự đặt giá trị ở 0000 giữ nguyên (đã duyệt bởi Trí 25/10/2026) — không đụng ở đây.
--
-- Áp dụng: node apps/csms/demo/migrate.mjs  (hoặc helper test/helpers/apply-migrations.ts);
-- dùng psql thuần thì phải tự ghi bảng _migrations.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. ENUM
-- -----------------------------------------------------------------------------

-- Phiên mở bằng idTag lạ: chưa biết ai thu tiền (ADR-0012). Trước đây tạm gán station_wallet.
ALTER TYPE payment_mode ADD VALUE 'unattributed';

-- Engine đối soát ghi conflict / mẫu muộn bằng loại riêng thay vì meter_gap + tiền tố resolution.
ALTER TYPE reconciliation_record_type ADD VALUE 'conflict';
ALTER TYPE reconciliation_record_type ADD VALUE 'late_sample';

-- Vòng đời lệnh CSMS → trụ (bất đồng bộ: 202 + commandId).
CREATE TYPE remote_command_status AS ENUM (
  'pending', 'sent', 'accepted', 'rejected', 'timeout', 'failed'
);

-- -----------------------------------------------------------------------------
-- B. Đổi tên cột đồng hồ trụ cho thống nhất với các bảng khác (cp_timestamp)
-- -----------------------------------------------------------------------------

ALTER TABLE connector_status_events RENAME COLUMN pillar_timestamp TO cp_timestamp;

-- -----------------------------------------------------------------------------
-- C. Cột còn thiếu (BM02 F09)
-- -----------------------------------------------------------------------------

-- Lần ĐẦU phiên bị chuyển sang orphaned (đồng hồ CSMS). Giữ nguyên khi orphaned → active để
-- biết phiên từng orphaned; null = chưa bao giờ orphaned.
ALTER TABLE sessions ADD COLUMN orphaned_at timestamptz;
COMMENT ON COLUMN sessions.orphaned_at IS
  'Lần đầu phiên sang orphaned (đồng hồ CSMS). Giữ nguyên khi orphaned → active; null = chưa từng orphaned.';

-- ALTER TABLE trên bảng cha partition tự lan xuống mọi partition con.
-- replayed: ReplayDetector phán frame chứa mẫu này là phát lại. Dòng có trước 0001 nhận false
-- (không biết) — chỉ dòng ghi sau 0001 đáng tin.
ALTER TABLE meter_values ADD COLUMN replayed boolean NOT NULL DEFAULT false;
ALTER TABLE meter_values ADD COLUMN epoch integer;
COMMENT ON COLUMN meter_values.replayed IS
  'ReplayDetector phán frame MeterValues/StopTransaction chứa mẫu là phát lại. Dòng trước migration 0001 mặc định false (chưa phân loại).';
COMMENT ON COLUMN meter_values.epoch IS
  'charge_point_connections.epoch lúc frame tới; null với dòng trước migration 0001.';

-- null = không phân loại được (frame không có cp_timestamp, hoặc CALLRESULT/CALLERROR/chiều ra).
-- Truyền ngay lúc INSERT: bảng append-only, trigger chặn UPDATE.
ALTER TABLE ocpp_message_log ADD COLUMN replayed boolean;
COMMENT ON COLUMN ocpp_message_log.replayed IS
  'Phán quyết ReplayDetector lúc ghi. null = không phân loại được (không có cp_timestamp / không phải CALL chiều vào).';

-- -----------------------------------------------------------------------------
-- D1. remote_commands — lệnh CSMS → trụ (BM02 F08)
-- -----------------------------------------------------------------------------

-- API trả 202 + commandId; kết quả (CALLRESULT / timeout) cập nhật dòng này. Chỉ có bảng ở
-- migration này; code gửi lệnh là việc của BE-04.
CREATE TABLE remote_commands (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_point_id  bigint NOT NULL REFERENCES charge_points (id),
  -- Null = lệnh cho cả trụ (Reset, ChangeConfiguration…); 0 = connector 0 của OCPP.
  connector_no     smallint,
  -- Tên action OCPP nguyên văn: RemoteStartTransaction, RemoteStopTransaction, Reset,
  -- UnlockConnector, ChangeAvailability, ChangeConfiguration, GetConfiguration,
  -- TriggerMessage, DataTransfer…
  action           text NOT NULL,
  payload          jsonb,
  status           remote_command_status NOT NULL DEFAULT 'pending',
  -- users.id của người/hệ thống yêu cầu; null = CSMS tự phát sinh.
  requested_by     bigint REFERENCES users (id),
  -- Chống tạo trùng khi app/dashboard retry.
  idempotency_key  text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  responded_at     timestamptz,
  -- Payload CALLRESULT của trụ.
  response         jsonb,
  error            text,
  CONSTRAINT remote_commands_connector_no_check
    CHECK (connector_no IS NULL OR connector_no IN (0, 1, 2)),
  CONSTRAINT remote_commands_sent_check
    CHECK (sent_at IS NULL OR sent_at >= requested_at),
  -- Có phản hồi thì phải đã gửi, và phản hồi không đi trước lúc gửi.
  CONSTRAINT remote_commands_responded_check
    CHECK (responded_at IS NULL OR (sent_at IS NOT NULL AND responded_at >= sent_at))
);
CREATE INDEX remote_commands_cp_requested_at_idx
  ON remote_commands (charge_point_id, requested_at DESC);
-- Chỉ lệnh còn dang dở: worker quét timeout đọc tập nhỏ này.
CREATE INDEX remote_commands_in_flight_idx
  ON remote_commands (status) WHERE status IN ('pending', 'sent');
CREATE UNIQUE INDEX remote_commands_idempotency_key_key
  ON remote_commands (idempotency_key) WHERE idempotency_key IS NOT NULL;
COMMENT ON TABLE remote_commands IS
  'Lệnh CSMS → trụ, bất đồng bộ (202 + commandId): pending → sent → accepted/rejected/timeout/failed.';

-- -----------------------------------------------------------------------------
-- D2. session_status_history — lịch sử chuyển trạng thái phiên (BM02 F13)
-- -----------------------------------------------------------------------------

-- Mỗi chuyển được state machine chấp nhận (T13 mục 1.2) = một dòng, ghi cùng transaction với
-- UPDATE sessions.status. Append-only như ocpp_message_log.
--
-- FK ON DELETE RESTRICT (không CASCADE): CASCADE xoá dòng con bằng DELETE nên sẽ đụng trigger
-- chặn DELETE bên dưới và báo lỗi khó hiểu; RESTRICT nói thẳng "không xoá phiên còn lịch sử".
-- Muốn xoá phiên (ví dụ dọn dữ liệu thử) phải DISABLE TRIGGER có chủ ý.
CREATE TABLE session_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   bigint NOT NULL REFERENCES sessions (id) ON DELETE RESTRICT,
  -- Null cho chuyển từ INITIAL ● (T13 #1, #2: chưa có dòng sessions).
  from_status  session_status,
  to_status    session_status NOT NULL,
  -- Tên event của state machine: START_TRANSACTION, STATION_OFFLINE, RECONCILE_OK…
  event        text NOT NULL,
  -- station = frame của trụ gây ra · system = CSMS tự quyết (đối soát, offline) · hoặc users.id.
  actor        text NOT NULL DEFAULT 'system',
  note         text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_status_history_session_id_occurred_at_idx
  ON session_status_history (session_id, occurred_at);
COMMENT ON TABLE session_status_history IS
  'Lịch sử chuyển trạng thái phiên (append-only). occurred_at = đồng hồ CSMS; cùng giây thì xếp theo id.';

CREATE FUNCTION session_status_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session_status_history là append-only: không % được', TG_OP;
END;
$$;
CREATE TRIGGER session_status_history_no_update_delete
  BEFORE UPDATE OR DELETE ON session_status_history
  FOR EACH ROW EXECUTE FUNCTION session_status_history_append_only();

COMMIT;
