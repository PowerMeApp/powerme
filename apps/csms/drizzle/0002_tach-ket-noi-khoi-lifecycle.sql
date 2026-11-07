-- =============================================================================
-- PowerMe CSMS — migration 0002_tach-ket-noi-khoi-lifecycle (T61, ADR-0016 D-C, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000_init + 0001. Schema Drizzle
-- (apps/csms/src/db/schema/stations.ts) phải khớp từng cột với file này.
--
-- Vì sao: STM-3 v0.3 chỉ giữ `lifecycle` là vòng đời HÀNH CHÍNH
-- (registered → awaiting_connection → in_service ⇄ disabled → decommissioned). Trạng thái kết nối
-- online/offline là thuộc tính riêng, do ocpp-gateway đặt khi mở/đóng socket. Trước đây registry
-- ghi `lifecycle = 'offline'` khi socket đóng và đè `disabled` thành `in_service` khi socket mở.
--
-- Nội dung:
--   A. charge_points.is_online (boolean not null default false) — socket OCPP đang mở?
--   B. charge_points.online_changed_at (timestamptz null)       — lần cuối is_online đổi.
--   (last_message_at đã có từ 0000 và đóng vai `last_seen_at` — KHÔNG thêm cột trùng.)
--   C. Backfill: hàng lifecycle = 'offline' (legacy) → lifecycle = 'in_service', is_online = false.
--
-- Giá trị 'offline' của enum charge_point_lifecycle KHÔNG bị xoá (Postgres không có DROP VALUE an
-- toàn); nó chỉ là legacy, code không còn ghi. PillarLifecyclePolicy vẫn coi nó như in_service.
-- Không thêm giá trị enum mới nên cả file nằm trong một transaction.
--
-- Áp dụng: node apps/csms/demo/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

ALTER TABLE charge_points
  ADD COLUMN is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN online_changed_at timestamptz;

COMMENT ON COLUMN charge_points.is_online IS
  'Socket OCPP đang mở? Do ocpp-gateway đặt (ADR-0016 D-C); độc lập với lifecycle.';
COMMENT ON COLUMN charge_points.online_changed_at IS
  'Lần cuối is_online đổi giá trị (CSMS clock). NULL nếu trụ chưa từng kết nối.';
COMMENT ON COLUMN charge_points.last_message_at IS
  'Lần cuối nhận tin từ trụ (CSMS clock) — chính là last_seen_at của ADR-0016 D-C.';

-- Hàng cũ: trụ từng in_service rồi socket đóng → lifecycle = offline. Tách thành hai thuộc tính.
-- Mọi hàng cũ đều is_online = false (DEFAULT); backfill chỉ cần sửa lifecycle.
UPDATE charge_points
   SET lifecycle = 'in_service',
       is_online = false
 WHERE lifecycle = 'offline';

COMMIT;
