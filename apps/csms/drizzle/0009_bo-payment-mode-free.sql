-- =============================================================================
-- PowerMe CSMS — migration 0009_bo-payment-mode-free (BE-11, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0008. Schema Drizzle
-- (apps/csms/src/db/schema/enums.ts) phải khớp với file này.
--
-- Vì sao: payment_mode có bốn giá trị từ 0001 (csms_billed · station_wallet · free ·
-- unattributed). ADR-0012 quyết định 3 và ADR-0009 ghi phiên free vend → unattributed; code và
-- 0000 lại dùng `free`. Trí chốt 01/11/2026: bỏ `free`. Phiên free vend (idTag trùng
-- charge_points.free_vend_tag hoặc thẻ card_kind = free_vend) từ nay payment_mode = unattributed,
-- vẫn phân biệt được với thẻ lạ qua origin = free_vend và việc KHÔNG có bản ghi unknown_id_tag.
--
-- PostgreSQL không có DROP VALUE cho enum → tạo kiểu mới, đổi kiểu cột, bỏ kiểu cũ. Chỉ một cột
-- dùng kiểu này (sessions.payment_mode), không có index hay CHECK nào trên cột.
--
-- Cả file nằm trong MỘT transaction: không ADD VALUE, chỉ CREATE TYPE / ALTER COLUMN / DROP TYPE,
-- đều transactional. Giá trị `unattributed` đã COMMIT ở 0001 nên UPDATE dùng được ngay.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

-- 1. Dữ liệu cũ: phiên free vend đang mang `free` → `unattributed`. origin giữ nguyên.
UPDATE sessions SET payment_mode = 'unattributed' WHERE payment_mode = 'free';

-- 2. Thay kiểu enum (giữ thứ tự csms_billed · station_wallet · unattributed).
ALTER TYPE payment_mode RENAME TO payment_mode_truoc_0009;
CREATE TYPE payment_mode AS ENUM ('csms_billed', 'station_wallet', 'unattributed');
ALTER TABLE sessions
  ALTER COLUMN payment_mode TYPE payment_mode
  USING payment_mode::text::payment_mode;
DROP TYPE payment_mode_truoc_0009;

COMMENT ON COLUMN sessions.payment_mode IS
  'Ai thu tiền (ADR-0012): csms_billed (thẻ online / app) · station_wallet (thẻ ví, trụ tự thu) · unattributed (free vend, thẻ lạ, thẻ không active — không thu qua CSMS; thẻ lạ có thêm reconciliation_records.unknown_id_tag). Giá trị free bỏ ở 0009.';

COMMIT;
