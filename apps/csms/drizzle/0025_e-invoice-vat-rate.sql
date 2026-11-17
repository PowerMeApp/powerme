-- =============================================================================
-- PowerMe CSMS — migration 0025_e-invoice-vat-rate (T32 Phần 7, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0024. Số 0023 để cho T134 (nhánh của Trí,
-- chưa merge lúc viết): migrate.mjs áp mọi file chưa áp theo thứ tự tên, không đòi số liên tiếp.
-- Schema Drizzle (apps/csms/src/db/schema/billing.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0025.md.
--
-- Vì sao (Khang chốt 17/11): hoá đơn điều chỉnh khi hoàn tiền (Phần 9, adjustForRefund) phải dùng
-- đúng thuế suất của hoá đơn gốc. Suy ngược từ vat_amount_vnd / amount_vnd không chắc đúng vì phép
-- tách VAT làm tròn mất thông tin, và thuế suất đổi theo thời điểm thu tiền (8% tới hết 31/12/2026,
-- 10% từ 01/01/2027 giờ Việt Nam). Nên lưu thuế suất đã dùng trên dòng.
--
-- 1. Cột e_invoices.vat_rate smallint (phần trăm).
-- 2. Backfill dòng có sẵn theo cùng quy tắc với vatRateAt (apps/csms/src/billing/e-invoice.ts),
--    tính trên thời điểm thu tiền top_ups.completed_at (thiếu thì e_invoices.created_at).
-- 3. NOT NULL, KHÔNG DEFAULT: code quên truyền thuế suất thì DB chặn, không âm thầm ghi một mức.
-- 4. CHECK miền giá trị: các mức thuế suất GTGT hiện hành (0, 5, 8, 10).
-- 5. COMMENT.
--
-- Không tiền kiểm: dòng có sẵn được backfill (trên main trước 0025 chưa có code nào ghi e_invoices;
-- chỉ test nâng cấp có dòng). Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- 1. Cột.
ALTER TABLE e_invoices ADD COLUMN vat_rate smallint;

-- 2. Backfill theo thời điểm thu tiền. Mốc 2027-01-01 00:00 giờ Việt Nam (+07).
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE e_invoices e
     SET vat_rate = CASE
           WHEN COALESCE(t.completed_at, e.created_at) < timestamptz '2027-01-01 00:00:00+07'
             THEN 8
           ELSE 10
         END
    FROM top_ups t
   WHERE t.id = e.top_up_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0025: backfill vat_rate cho % dòng e_invoices', n;
END $$;

-- 3, 4. NOT NULL (FK top_up_id NOT NULL nên mọi dòng đã được backfill), CHECK.
ALTER TABLE e_invoices
  ALTER COLUMN vat_rate SET NOT NULL,
  ADD CONSTRAINT e_invoices_vat_rate_check CHECK (vat_rate IN (0, 5, 8, 10));

-- 5. COMMENT.
COMMENT ON COLUMN e_invoices.vat_rate IS
  'Thuế suất GTGT đã dùng, phần trăm (0025, T32 Phần 7). Theo thời điểm thu tiền (top_ups.completed_at), không theo lúc gọi nhà cung cấp: 8 trước 2027-01-01 00:00 giờ Việt Nam, 10 từ mốc đó (vatRateAt). amount_vnd đã gồm VAT; vat_amount_vnd = round(amount_vnd × vat_rate / (100 + vat_rate)). Hoá đơn điều chỉnh (adjustForRefund) dùng cột này, không suy ngược từ vat_amount_vnd.';

COMMIT;
