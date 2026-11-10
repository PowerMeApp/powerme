-- =============================================================================
-- PowerMe CSMS — migration 0016_bo-the-wallet-station-wallet (BE-23 / T110, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0015. Schema Drizzle
-- (apps/csms/src/db/schema/enums.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0016.md.
--
-- Vì sao: quyết định T109 (Ân, 09/11/2026) bỏ thẻ RFID ví — thẻ trả trước mà trụ tự trừ tiền
-- (BM04 mục 5: "RFID wallet cards… out of scope"). Thẻ RFID chỉ còn `online` (gắn tài xế, trả
-- bằng Charging Credit qua CSMS) và `free_vend`; ai thu tiền chỉ còn `csms_billed` hoặc
-- `unattributed`. Hai giá trị bị bỏ: rfid_card_kind `wallet`, payment_mode `station_wallet`.
-- session_origin KHÔNG đổi: 0000 đã gộp mọi lần quẹt thẻ thành `rfid` (T12/T13), không có
-- `rfid_wallet` trong DB (giá trị đó chỉ có ở ADR-0009 / BR-P08 bản cũ).
--
-- Dữ liệu cũ (không xoá dòng nào, chỉ đổi giá trị enum):
--   * Phiên `station_wallet` → `unattributed`: đúng nghĩa "CSMS không thu tiền phiên này"
--     (phiên đó trụ đã tự trừ trên thẻ). Giữ nguyên origin (`rfid`), id_tag, rfid_card_id,
--     driver_id, meter, trạng thái và bản ghi đối soát — từ id_tag / rfid_card_id vẫn truy được
--     thẻ cũ. Phiên này rơi vào nhóm unattributed mà console xử lý (gán / đóng, T102).
--   * Thẻ `wallet` → `online`, giữ driver_id và status. Thẻ chưa gắn tài xế (như DEMO-WALLET-0001
--     của seed cũ) từ nay Authorize trả Invalid theo quy tắc BE-19 (#93, BR-P23).
--   * updated_at = now() cho các dòng bị đổi (quy ước C2 của 0014: SQL thô tự ghi updated_at).
-- Không ghi thêm dòng session_status_history: bảng đó là lịch sử CHUYỂN TRẠNG THÁI do state
-- machine chấp nhận (0001), đổi payment_mode không phải một chuyển; một dòng giả orphaned →
-- orphaned còn làm lệch mốc hard cap (session-timers orphanedSinceSql). Số dòng bị đổi được in
-- bằng RAISE NOTICE khi chạy và ghi vào nhật ký.
--
-- PostgreSQL không có DROP VALUE cho enum → làm như 0009: đổi tên kiểu cũ, tạo kiểu mới, đổi kiểu
-- cột, bỏ kiểu cũ. Mỗi kiểu chỉ có MỘT cột dùng (sessions.payment_mode, rfid_cards.card_kind);
-- không có DEFAULT, CHECK, index, view hay hàm nào phụ thuộc (đã kiểm pg_depend trên DB demo ở
-- 0015, xem nhật ký mục 2).
--
-- Cả file nằm trong MỘT transaction: chỉ UPDATE / CREATE TYPE / ALTER COLUMN / DROP TYPE, đều
-- transactional; giá trị đích (`unattributed`, `online`) đã COMMIT từ 0000/0001.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

-- 0. Đếm trước để người chạy migration thấy số dòng sẽ đổi.
DO $$
DECLARE
  n_sessions bigint;
  n_cards bigint;
BEGIN
  SELECT count(*) INTO n_sessions FROM sessions WHERE payment_mode::text = 'station_wallet';
  SELECT count(*) INTO n_cards FROM rfid_cards WHERE card_kind::text = 'wallet';
  RAISE NOTICE '0016: % phiên station_wallet → unattributed, % thẻ wallet → online',
    n_sessions, n_cards;
END
$$;

-- 1. Dữ liệu cũ.
UPDATE sessions SET payment_mode = 'unattributed', updated_at = now()
WHERE payment_mode = 'station_wallet';
UPDATE rfid_cards SET card_kind = 'online', updated_at = now()
WHERE card_kind = 'wallet';

-- 2. payment_mode: csms_billed · unattributed.
ALTER TYPE payment_mode RENAME TO payment_mode_truoc_0016;
CREATE TYPE payment_mode AS ENUM ('csms_billed', 'unattributed');
ALTER TABLE sessions
  ALTER COLUMN payment_mode TYPE payment_mode
  USING payment_mode::text::payment_mode;
DROP TYPE payment_mode_truoc_0016;

-- 3. rfid_card_kind: online · free_vend.
ALTER TYPE rfid_card_kind RENAME TO rfid_card_kind_truoc_0016;
CREATE TYPE rfid_card_kind AS ENUM ('online', 'free_vend');
ALTER TABLE rfid_cards
  ALTER COLUMN card_kind TYPE rfid_card_kind
  USING card_kind::text::rfid_card_kind;
DROP TYPE rfid_card_kind_truoc_0016;

COMMENT ON COLUMN sessions.payment_mode IS
  'Ai thu tiền (ADR-0012): csms_billed (thẻ online / app, trừ Charging Credit) · unattributed (free vend, thẻ lạ, thẻ không active hoặc không đạt BR-P23/P18 — không thu qua CSMS). free bỏ ở 0009, station_wallet bỏ ở 0016 (T109: không còn thẻ ví).';
COMMENT ON TABLE rfid_cards IS
  'Thẻ RFID đã phát hành: online (gắn tài xế, trả bằng Charging Credit) / free_vend. wallet bỏ ở 0016 (T109). BK = card_identifier.';

COMMIT;
