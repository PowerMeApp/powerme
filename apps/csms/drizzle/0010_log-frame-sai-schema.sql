-- =============================================================================
-- PowerMe CSMS — migration 0010_log-frame-sai-schema (BE-07, WP2; G12 / BM02 F42)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0009. Schema Drizzle
-- (apps/csms/src/db/schema/ocpp-log.ts) phải khớp với file này.
--
-- Vì sao: ocpp-rpc ở strict mode loại frame sai schema TRƯỚC handler, nên ocpp_message_log không
-- có chúng — trái với tuyên bố "mọi frame nhận được đều được ghi". Gateway nay móc sự kiện
-- `strictValidationFailure` (CALL chiều vào sai schema) và `badMessage` (frame hỏng cấu trúc) của
-- ocpp-rpc để ghi một dòng đánh dấu lỗi.
--
--   A. Cột mới `validation_error` (text, null được): lý do ocpp-rpc từ chối frame. NULL = frame
--      được chấp nhận bình thường. Phải truyền lúc INSERT — trigger append-only chặn UPDATE.
--   B. `message_type` được phép NULL, nhưng CHỈ khi `validation_error` có giá trị: frame không
--      phải JSON / không phải mảng / MessageTypeId lạ thì không có loại để điền. Hai CHECK cũ
--      được viết lại cho khớp; với dòng bình thường (validation_error NULL) ràng buộc y như cũ.
--
-- ALTER TABLE trên bảng cha partition tự lan xuống mọi partition con. Cả file trong một
-- transaction (không ADD VALUE enum).
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

ALTER TABLE ocpp_message_log ADD COLUMN validation_error text;
COMMENT ON COLUMN ocpp_message_log.validation_error IS
  'Lý do ocpp-rpc từ chối frame chiều vào (schema sai: strictValidationFailure, hoặc frame hỏng: badMessage). NULL = frame hợp lệ. G12 / BM02 F42.';

ALTER TABLE ocpp_message_log ALTER COLUMN message_type DROP NOT NULL;

ALTER TABLE ocpp_message_log DROP CONSTRAINT ocpp_message_log_message_type_check;
ALTER TABLE ocpp_message_log ADD CONSTRAINT ocpp_message_log_message_type_check
  CHECK (
    (message_type IS NOT NULL AND message_type IN (2, 3, 4))
    OR (message_type IS NULL AND validation_error IS NOT NULL)
  );

-- Dòng bình thường: CALL <=> có action (như cũ). Frame bị từ chối: tuỳ ý (action null nếu không
-- parse được; CALL sai schema vẫn có action).
ALTER TABLE ocpp_message_log DROP CONSTRAINT ocpp_message_log_action_check;
ALTER TABLE ocpp_message_log ADD CONSTRAINT ocpp_message_log_action_check
  CHECK (
    validation_error IS NOT NULL
    OR (message_type = 2) = (action IS NOT NULL)
  );

COMMIT;
