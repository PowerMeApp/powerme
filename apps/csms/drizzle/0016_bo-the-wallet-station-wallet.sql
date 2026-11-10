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
--     thẻ cũ.
--   * CHẶN TRỪ TIỀN HAI LẦN: sau 0016 phiên này nằm trong nhóm unattributed của console (BE-24 /
--     T102, unattributed-session.service.ts), và thẻ của nó đã là `online` nên chặn
--     `wallet_card_not_billable` không còn bắt được. Vì vậy, với mọi phiên station_wallet ĐÃ có
--     StopTransaction (received_stopped_at khác null), 0016 ghi sẵn quyết định "đã đóng" đúng như
--     BE-24 ghi khi operator đóng: một dòng session_status_history event `UNATTRIBUTED_CLOSED`,
--     from = to = trạng thái hiện tại, actor `system`, note `legacy_station_wallet: …` (phần trước
--     dấu `:` là mã lý do, như close()). Gán tài xế sau đó → 409 `already_resolved`; đóng lại →
--     `already_resolved = true`; phiên không còn trong hàng đợi.
--     Phiên station_wallet CHƯA dừng KHÔNG được ghi dòng này (BE-24 chỉ quyết định phiên đã dừng;
--     một dòng trên phiên orphaned còn chen vào lịch sử trước khi phiên kết thúc). Giới hạn: phiên
--     như vậy khi dừng sẽ vào hàng đợi như phiên unattributed thường — NOTICE in số phiên này để
--     người chạy đóng tay (UNATTRIBUTED_CLOSED) trước khi mở console; DB demo: 0.
--   * Thẻ `wallet` → `online`, giữ driver_id và status. Thẻ chưa gắn tài xế (như DEMO-WALLET-0001
--     của seed cũ) từ nay Authorize trả Invalid theo quy tắc BE-19 (#93, BR-P23).
--   * updated_at = now() cho các dòng bị đổi (quy ước C2 của 0014: SQL thô tự ghi updated_at).
-- Số dòng bị đổi / được ghi quyết định được in bằng RAISE NOTICE khi chạy và ghi vào nhật ký.
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
  n_stopped bigint;
  n_cards bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE received_stopped_at IS NOT NULL)
    INTO n_sessions, n_stopped
    FROM sessions WHERE payment_mode::text = 'station_wallet';
  SELECT count(*) INTO n_cards FROM rfid_cards WHERE card_kind::text = 'wallet';
  RAISE NOTICE '0016: % phiên station_wallet → unattributed, % thẻ wallet → online',
    n_sessions, n_cards;
  RAISE NOTICE '0016: ghi UNATTRIBUTED_CLOSED cho % phiên đã dừng; % phiên chưa dừng không được ghi (đóng tay sau khi dừng)',
    n_stopped, n_sessions - n_stopped;
END
$$;

-- 1. Chặn trừ tiền hai lần: quyết định "đã đóng" cho phiên station_wallet đã dừng (cột và giá trị
--    như UnattributedSessionService.close() của BE-24, actor `system` thay users.id operator).
--    Phiên đã có quyết định BE-24 (không xảy ra trước 0016, phòng chạy lại tay) thì bỏ qua.
INSERT INTO session_status_history (session_id, from_status, to_status, event, actor, note)
SELECT s.id, s.status, s.status, 'UNATTRIBUTED_CLOSED', 'system',
       'legacy_station_wallet: đã trả tại trụ bằng thẻ ví (T110, migration 0016), không được tính tiền lại'
FROM sessions s
WHERE s.payment_mode::text = 'station_wallet'
  AND s.received_stopped_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM session_status_history h
    WHERE h.session_id = s.id AND h.event IN ('UNATTRIBUTED_ASSIGNED', 'UNATTRIBUTED_CLOSED')
  )
ORDER BY s.id;

-- 2. Dữ liệu cũ.
UPDATE sessions SET payment_mode = 'unattributed', updated_at = now()
WHERE payment_mode = 'station_wallet';
UPDATE rfid_cards SET card_kind = 'online', updated_at = now()
WHERE card_kind = 'wallet';

-- 3. payment_mode: csms_billed · unattributed.
ALTER TYPE payment_mode RENAME TO payment_mode_truoc_0016;
CREATE TYPE payment_mode AS ENUM ('csms_billed', 'unattributed');
ALTER TABLE sessions
  ALTER COLUMN payment_mode TYPE payment_mode
  USING payment_mode::text::payment_mode;
DROP TYPE payment_mode_truoc_0016;

-- 4. rfid_card_kind: online · free_vend.
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
