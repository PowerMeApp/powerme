-- =============================================================================
-- PowerMe CSMS — migration 0033_driver-token-version (BE-49, UC-ACC-05 Log Out)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0031 (0032 của PR hoàn tiền thủ công có
-- thể áp trước hoặc sau: hai file không đụng cùng bảng). Schema Drizzle
-- (apps/csms/src/db/schema/users.ts) phải khớp cột này.
--
-- Vì sao: Driver API không lưu refresh token (BE-21), nên đăng xuất trước đây chỉ là app xoá token;
-- token lọt ra ngoài (mất điện thoại) còn dùng được tới 30 ngày. Hai mức đăng xuất:
--   1. Thiết bị này (POST /auth/logout): ghi jti của refresh token vào driver_refresh_revocations;
--      refresh token đó và access token mang `sid` = jti đó bị từ chối. Máy khác không ảnh hưởng.
--   2. Mọi thiết bị (POST /me/logout-all, Cài đặt → Bảo mật): tăng users.token_version; mọi token
--      mang claim `ver` cũ bị từ chối.
-- CSMS kiểm cả hai ở MỌI request và mọi lần refresh. Token phát trước migration không có `ver`
-- → coi là 0, khớp DEFAULT 0, nên deploy không đăng xuất ai.
--
-- Chỉ THÊM một cột có DEFAULT hằng số (PostgreSQL 11+ không viết lại bảng) và một bảng mới
-- → một transaction.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN token_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_token_version_check CHECK (token_version >= 0);

COMMENT ON COLUMN users.token_version IS
  'BE-49: tăng 1 mỗi lần tài xế đăng xuất mọi thiết bị; token Driver API có claim ver khác số này bị từ chối.';

-- Mỗi dòng = một refresh token bị thu hồi khi tài xế "đăng xuất thiết bị này". Chỉ ghi thêm.
-- expires_at = exp của refresh token: quá mốc này token đã tự chết, dòng có thể dọn.
CREATE TABLE driver_refresh_revocations (
  jti uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES drivers (user_id),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX driver_refresh_revocations_user_id_idx ON driver_refresh_revocations (user_id);

COMMENT ON TABLE driver_refresh_revocations IS
  'BE-49: refresh token (jti = sid của access token) đã thu hồi khi tài xế đăng xuất một thiết bị.';

COMMIT;
