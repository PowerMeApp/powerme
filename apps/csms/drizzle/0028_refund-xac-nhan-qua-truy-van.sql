-- =============================================================================
-- PowerMe CSMS — migration 0028_refund-xac-nhan-qua-truy-van (T32 Phần 9a, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0027. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts) phải khớp với file này. Nhật ký từng thay đổi + cách kiểm:
-- docs/NHAT-KY-MIGRATION-0028.md.
--
-- Vì sao (Khang chốt 23/11): trước khi gửi lại refund, worker hỏi querydr (STM-10, D1). querydr của
-- giao dịch gốc không có trường riêng cho mã lệnh hoàn, nên refund xác nhận qua đường này không có
-- gateway_refund_no, trong khi 0015 bắt buộc cột đó khi done. Không ghi mã giả hay mã giao dịch gốc
-- vào cột "mã hoàn": thêm cờ confirmed_via_query.
--
-- 1. refunds.confirmed_via_query boolean NOT NULL DEFAULT false.
-- 2. refunds_gateway_refund_no_check: done phải có gateway_refund_no HOẶC confirmed_via_query.
-- 3. refunds_confirmed_via_query_check: cờ chỉ có trên dòng done và khi đó gateway_refund_no NULL.
-- 4. COMMENT.
--
-- Dòng có sẵn nhận false; dòng done cũ đã có gateway_refund_no nên không vi phạm CHECK mới.
-- Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

ALTER TABLE refunds
  ADD COLUMN confirmed_via_query boolean NOT NULL DEFAULT false;

ALTER TABLE refunds DROP CONSTRAINT refunds_gateway_refund_no_check;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_gateway_refund_no_check
    CHECK (status <> 'done' OR gateway_refund_no IS NOT NULL OR confirmed_via_query),
  ADD CONSTRAINT refunds_confirmed_via_query_check
    CHECK (NOT confirmed_via_query OR (status = 'done' AND gateway_refund_no IS NULL));

COMMENT ON COLUMN refunds.confirmed_via_query IS
  'true = refund done nhờ querydr thấy lệnh hoàn (loại 02/03, TS 00/05/06), không có mã lệnh hoàn nên gateway_refund_no NULL (0028, D1). false = chưa done, hoặc done theo response của lệnh refund.';
COMMENT ON COLUMN refunds.gateway_refund_no IS
  'Mã giao dịch hoàn VNPay trả trong response của lệnh refund. Khi done: có giá trị, trừ khi confirmed_via_query = true (khi đó NULL, 0028).';
COMMENT ON COLUMN refunds.unfinished_claims IS
  'Số lần việc nền giữ chỗ dòng liên tiếp mà chưa ra kết quả (0027, D7): tx1 tăng 1, tx2 commit được thì đặt về 0. Lớn hơn 1 nghĩa là lượt trước có thể đã gửi VNPay, phải querydr trước (Phần 9a). Vượt 5 thì sang failed; Admin retry đặt về 0.';

COMMIT;
