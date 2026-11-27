-- =============================================================================
-- PowerMe CSMS — migration 0033_driver-token-version (BE-49, UC-ACC-05 Log Out)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0031 (0032 của PR hoàn tiền thủ công có
-- thể áp trước hoặc sau: hai file không đụng cùng bảng). Schema Drizzle
-- (apps/csms/src/db/schema/users.ts) phải khớp cột này.
--
-- Vì sao: Driver API không lưu refresh token (BE-21), nên đăng xuất trước đây chỉ là app xoá token;
-- token lọt ra ngoài (mất điện thoại) còn dùng được tới 30 ngày. Mỗi token giờ mang claim `ver`;
-- CSMS so với users.token_version ở MỌI request và mọi lần refresh. POST /auth/logout tăng số này
-- → mọi access + refresh token cũ của tài xế đó bị từ chối ngay (đăng xuất mọi thiết bị).
-- Token phát trước migration không có `ver` → coi là 0, khớp DEFAULT 0, nên không ai bị văng ra.
--
-- Chỉ THÊM một cột có DEFAULT hằng số (PostgreSQL 11+ không viết lại bảng) → một transaction.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN token_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_token_version_check CHECK (token_version >= 0);

COMMENT ON COLUMN users.token_version IS
  'BE-49: tăng 1 mỗi lần tài xế đăng xuất; token Driver API có claim ver khác số này bị từ chối.';

COMMIT;
