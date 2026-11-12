-- =============================================================================
-- PowerMe CSMS — migration 0018_go-xe-tai-xe (BE-34, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0017. Schema Drizzle
-- (apps/csms/src/db/schema/sessions.ts, bảng vehicles) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0018.md.
--
-- Vì sao: Driver API thêm route thêm / gỡ xe (F-01, UC-ACC-03). Xe đã sạc thì có
-- `sessions.vehicle_id` và `driver_charge_intents.vehicle_id` trỏ tới (BR-P17) — xoá cứng vấp FK,
-- và xoá lịch sử để gỡ xe là sai. Nên gỡ xe = XOÁ MỀM:
--
-- 1. `vehicles.removed_at timestamptz` — NULL = đang dùng; có giá trị = tài xế đã gỡ lúc đó. Dòng
--    và mọi FK tới nó giữ nguyên, lịch sử phiên vẫn JOIN ra biển số.
-- 2. Biển số chỉ duy nhất trong các xe ĐANG DÙNG, và so theo khoá chữ + số in hoa (bỏ `-`, `.`,
--    khoảng trắng): `51K-901.01`, `51k 901.01`, `51K90101` là một biển. Thay UNIQUE
--    `vehicles_plate_number_key` bằng unique index biểu thức có điều kiện
--    `vehicles_plate_key_active ... WHERE removed_at IS NULL` — biển đã gỡ đăng ký lại được (bán xe,
--    người mua đăng ký). Biểu thức PHẢI giống `PLATE_KEY_SQL` (src/driver/vehicles.http.ts).
--    Trước khi đổi, nếu dữ liệu cũ có hai xe cùng khoá → RAISE EXCEPTION liệt kê id (không in biển),
--    cả file ROLLBACK; người vận hành tự sửa rồi chạy lại migrate (giống 0017).
-- 3. CHECK `vehicles_removed_not_default`: xe đã gỡ không thể là xe mặc định — index
--    `vehicles_one_default_per_driver` giữ nguyên, nhờ CHECK này nó chỉ còn tính xe đang dùng.
--
-- Hệ quả cho SQL khác: `ON CONFLICT ON CONSTRAINT vehicles_plate_number_key` / `ON CONFLICT
-- (plate_number)` không dùng được nữa (seed-app.sql và scripts/driver-local-token.mjs đã sửa cùng PR).
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- 1. Cột xoá mềm.
ALTER TABLE vehicles ADD COLUMN removed_at timestamptz;

-- 2a. Dừng nếu dữ liệu cũ có hai xe cùng khoá biển số (tất cả xe cũ đều đang dùng).
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(g.ids, '; ' ORDER BY g.first_id) INTO dup
  FROM (
    SELECT min(id) AS first_id, 'id ' || string_agg(id::text, ', ' ORDER BY id) AS ids
    FROM vehicles
    GROUP BY upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))
    HAVING count(*) > 1
  ) AS g;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '0018: biển số trùng khi bỏ dấu và khoảng trắng (%). Không sửa gì; tự quyết biển đúng của từng xe (UPDATE vehicles SET plate_number = ...) rồi chạy lại migrate', dup
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- 2b. UNIQUE toàn bảng → unique index trên khoá, chỉ xe đang dùng.
ALTER TABLE vehicles DROP CONSTRAINT vehicles_plate_number_key;
CREATE UNIQUE INDEX vehicles_plate_key_active
  ON vehicles ((upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))))
  WHERE removed_at IS NULL;

-- 3. Xe đã gỡ không là xe mặc định.
ALTER TABLE vehicles ADD CONSTRAINT vehicles_removed_not_default
  CHECK (removed_at IS NULL OR NOT is_default);

COMMENT ON COLUMN vehicles.removed_at IS
  'Thời điểm tài xế gỡ xe (BE-34, xoá mềm). NULL = đang dùng. Xe đã gỡ giữ dòng cho lịch sử phiên, ẩn khỏi Driver API, không giữ biển số.';
COMMENT ON INDEX vehicles_plate_key_active IS
  'Biển số duy nhất trong xe đang dùng, so theo chữ + số in hoa (bỏ - . khoảng trắng). BE-34.';
COMMENT ON TABLE vehicles IS
  'Xe của tài xế. BK = biển số (khoá chữ + số) trong xe chưa gỡ; một xe mặc định mỗi tài xế; gỡ = removed_at (0018).';

COMMIT;
