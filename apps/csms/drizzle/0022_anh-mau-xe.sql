-- =============================================================================
-- PowerMe CSMS — migration 0022_anh-mau-xe (BE-38, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0021. Schema Drizzle
-- (apps/csms/src/db/schema/sessions.ts, bảng vehicle_models) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0022.md.
--
-- Vì sao: app tài xế (WP3) hiển thị danh mục mẫu xe và "Xe của tôi" nhưng không có ảnh, chỉ có ô
-- vuông trống. Driver API cần trả đường dẫn ảnh của mẫu xe.
--
-- 1. `vehicle_models.image_url text` — URL https của ảnh mẫu xe; NULL = chưa có ảnh (app hiện ảnh
--    mặc định). CHECK: bắt đầu bằng `https://`, không có khoảng trắng, dài ≤ 500.
-- 2. `vehicle_models.image_credit text` — dòng ghi công (tác giả + giấy phép) của ảnh; ảnh giấy
--    phép CC BY / CC BY-SA bắt buộc ghi công khi hiển thị. CHECK: chỉ có khi có `image_url`, ≤ 200.
--
-- Không đổi dòng nào: cả hai cột NULL cho mọi mẫu xe đang có; ảnh do seed (demo/seed-app.sql) điền.
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

ALTER TABLE vehicle_models
  ADD COLUMN image_url text,
  ADD COLUMN image_credit text,
  ADD CONSTRAINT vehicle_models_image_url_check
    CHECK (image_url IS NULL OR (image_url ~ '^https://[^[:space:]]+$' AND char_length(image_url) <= 500)),
  ADD CONSTRAINT vehicle_models_image_credit_check
    CHECK (
      image_credit IS NULL
      OR (image_url IS NOT NULL AND char_length(image_credit) BETWEEN 1 AND 200)
    );

COMMENT ON COLUMN vehicle_models.image_url IS
  'URL https của ảnh mẫu xe cho app tài xế (0022). NULL = chưa có ảnh, app hiện ảnh mặc định.';
COMMENT ON COLUMN vehicle_models.image_credit IS
  'Ghi công của ảnh: tác giả + giấy phép (0022). Ảnh CC BY / CC BY-SA phải hiện dòng này cạnh ảnh. Chỉ có khi có image_url.';

COMMIT;
