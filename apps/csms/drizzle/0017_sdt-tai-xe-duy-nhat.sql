-- =============================================================================
-- PowerMe CSMS — migration 0017_sdt-tai-xe-duy-nhat (BE-30, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0016. Schema Drizzle
-- (apps/csms/src/db/schema/users.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0017.md.
--
-- Vì sao: BE-30 cho tài xế đăng nhập bằng số điện thoại + mật khẩu. Một số phải trỏ đúng MỘT
-- tài khoản, nên `users.phone_number` cần UNIQUE; và UNIQUE chỉ có nghĩa khi mọi số cùng một dạng
-- (E.164), nên dữ liệu cũ được chuẩn hoá trước.
--
-- 1. Chuẩn hoá dữ liệu cũ về E.164 — CÙNG quy tắc với `normalizePhoneNumber`
--    (src/driver/phone-number.ts), viết lại bằng SQL trong hàm TẠM `pg_temp.be30_normalize_phone`
--    (chỉ sống trong phiên chạy migration, không để lại gì trong schema). Test migration-0017 chạy
--    cùng bảng ca với unit test qua hàm này để hai bản không lệch nhau.
--    Số không nhận ra (vd chữ, quá ngắn) GIỮ NGUYÊN, không đụng: không đăng nhập bằng số đó được
--    nhưng cũng không mất dữ liệu. NOTICE in số dòng mỗi loại.
-- 2. Nếu sau chuẩn hoá còn hai người dùng cùng một số → RAISE EXCEPTION liệt kê id từng nhóm (không
--    in số điện thoại), cả file ROLLBACK, không sửa hay xoá dòng nào. Người vận hành tự quyết số
--    thuộc ai (UPDATE tay) rồi chạy lại migrate.
-- 3. UNIQUE thường `users_phone_number_key` (không partial): PostgreSQL coi các NULL là khác nhau
--    (NULLS DISTINCT, mặc định) nên mọi tài khoản không có số vẫn cùng tồn tại — y như một partial
--    index `WHERE phone_number IS NOT NULL`, nhưng là CONSTRAINT nên Drizzle khai được bằng
--    `unique()`, `ON CONFLICT ON CONSTRAINT` dùng được và lỗi 23505 mang đúng tên để API trả
--    409 `phone_taken`. Index thường `users_phone_number_idx` (0000) bị bỏ vì UNIQUE đã tạo index
--    btree trên đúng cột đó.
--
-- Không thêm CHECK định dạng: dòng cũ không chuẩn hoá được vẫn phải hợp lệ; định dạng do API giữ.
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- Bỏ dấu cách / . / - / ( ); `+` chỉ ở đầu; VN: 0|84|+84|+840 + NSN 9–10 chữ số (không bắt đầu
-- bằng 0) → +84NSN; nước khác: + mã nước khác 84, tổng 7–15 chữ số, chữ số đầu khác 0; còn lại NULL.
CREATE FUNCTION pg_temp.be30_normalize_phone(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT CASE
    WHEN length(raw) > 32 THEN NULL
    WHEN c !~ '^\+?[0-9]+$' THEN NULL
    WHEN c ~ '^\+84' THEN
      CASE WHEN regexp_replace(substr(c, 4), '^0', '') ~ '^[1-9][0-9]{8,9}$'
           THEN '+84' || regexp_replace(substr(c, 4), '^0', '') END
    WHEN c ~ '^\+' THEN
      CASE WHEN substr(c, 2) ~ '^[1-9][0-9]{6,14}$' THEN c END
    WHEN c ~ '^0' THEN
      CASE WHEN substr(c, 2) ~ '^[1-9][0-9]{8,9}$' THEN '+84' || substr(c, 2) END
    WHEN c ~ '^84' THEN
      CASE WHEN substr(c, 3) ~ '^[1-9][0-9]{8,9}$' THEN '+84' || substr(c, 3) END
  END
  FROM (SELECT regexp_replace(raw, '[[:space:].()-]', '', 'g') AS c) AS s
$fn$;

-- 0 + 2. Đếm, rồi dừng nếu còn trùng (tính trên giá trị SAU chuẩn hoá, trước khi ghi gì).
DO $$
DECLARE
  n_total bigint;
  n_change bigint;
  n_unknown bigint;
  dup text;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE pg_temp.be30_normalize_phone(phone_number) IS DISTINCT FROM phone_number
                            AND pg_temp.be30_normalize_phone(phone_number) IS NOT NULL),
         count(*) FILTER (WHERE pg_temp.be30_normalize_phone(phone_number) IS NULL)
    INTO n_total, n_change, n_unknown
    FROM users WHERE phone_number IS NOT NULL;
  RAISE NOTICE '0017: % số điện thoại; % dòng chuẩn hoá về E.164; % dòng không nhận ra (giữ nguyên)',
    n_total, n_change, n_unknown;

  SELECT string_agg(g.ids, '; ' ORDER BY g.first_id) INTO dup
  FROM (
    SELECT min(id) AS first_id, 'id ' || string_agg(id::text, ', ' ORDER BY id) AS ids
    FROM users
    WHERE phone_number IS NOT NULL
    GROUP BY coalesce(pg_temp.be30_normalize_phone(phone_number), phone_number)
    HAVING count(*) > 1
  ) AS g;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '0017: số điện thoại trùng sau chuẩn hoá (%). Không sửa gì; tự quyết mỗi số thuộc tài khoản nào (UPDATE users SET phone_number = ...) rồi chạy lại migrate', dup
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- 1. Ghi giá trị đã chuẩn hoá (quy ước C2 của 0014: SQL thô tự ghi updated_at).
UPDATE users
SET phone_number = pg_temp.be30_normalize_phone(phone_number), updated_at = now()
WHERE phone_number IS NOT NULL
  AND pg_temp.be30_normalize_phone(phone_number) IS NOT NULL
  AND pg_temp.be30_normalize_phone(phone_number) <> phone_number;

-- 3. UNIQUE thay cho index thường.
DROP INDEX users_phone_number_idx;
ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);

COMMENT ON COLUMN users.phone_number IS
  'E.164 (vd +84901234567), chuẩn hoá bởi Driver API (BE-30); UNIQUE, NULL = chưa có số. Dòng trước 0017 không chuẩn hoá được giữ nguyên.';

DROP FUNCTION pg_temp.be30_normalize_phone(text);

COMMIT;
