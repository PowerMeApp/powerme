-- =============================================================================
-- PowerMe CSMS — migration 0032_refund-ghi-nhan-thu-cong (T32 hoàn tiền thủ công, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0031. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts) phải khớp với file này. Nhật ký từng thay đổi + cách kiểm:
-- docs/NHAT-KY-MIGRATION-0032.md.
--
-- Vì sao (D-AC, SRS BR-P51, STM-10 v2.0, chốt 26/11): hoàn tiền làm thủ công. CSKH hoàn trên cổng
-- merchant VNPay, Admin ghi nhận trong PowerMe: requested → done (nhập mã hoàn của cổng), requested →
-- failed (kèm lý do), failed → requested (làm lại). Không còn worker gửi refund, nên:
--
-- 1. refunds.failure_reason text: lý do Admin ghi khi đánh dấu thất bại. Bắt buộc khi failed; làm
--    lại (failed → requested) giữ lý do cũ, lần thất bại sau ghi đè (Khang chốt 27/11). 1–1000 ký tự.
--    Dòng failed có sẵn (worker #208; staging dự kiến 0 dòng vì chưa có route tạo hoàn) được điền từ
--    last_error_message để không vi phạm CHECK; không đổi updated_at (sửa dữ liệu của migration).
-- 2. Bỏ refunds_next_attempt_check (requested ⇒ next_attempt_at NOT NULL) và DEFAULT now() của
--    next_attempt_at: không còn worker quét refunds, code mới không ghi cột này.
-- 3. Không xoá cột: attempt_count, next_attempt_at, last_error_*, last_attempt_at, unfinished_claims,
--    confirmed_via_query giữ cho dữ liệu cũ, code mới không ghi. Giữ refunds_last_error_check,
--    refunds_gateway_refund_no_check / refunds_confirmed_via_query_check (0028) và index
--    (status, next_attempt_at) (cột đầu status vẫn phục vụ danh sách chờ CSKH).
-- 4. COMMENT theo luồng thủ công.
--
-- Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

ALTER TABLE refunds ADD COLUMN failure_reason text;

UPDATE refunds
   SET failure_reason = left('Luồng gửi tự động cũ: ' || COALESCE(last_error_message, 'không rõ'), 1000)
 WHERE status = 'failed';

ALTER TABLE refunds
  ADD CONSTRAINT refunds_failure_reason_length_check
    CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 1000),
  ADD CONSTRAINT refunds_failure_reason_check
    CHECK (status <> 'failed' OR failure_reason IS NOT NULL);

ALTER TABLE refunds DROP CONSTRAINT refunds_next_attempt_check;
ALTER TABLE refunds ALTER COLUMN next_attempt_at DROP DEFAULT;

COMMENT ON TABLE refunds IS
  'Hoàn tiền về nguồn thanh toán, làm thủ công (STM-10 v2.0, D-AC / BR-P51): requested → done | failed; failed → requested khi Admin làm lại. Tạo cùng transaction với quyết định hoàn; CSKH hoàn trên cổng merchant VNPay, Admin ghi nhận (0032). PowerMe không gọi VNPay refund.';
COMMENT ON COLUMN refunds.status IS
  'requested (chờ CSKH hoàn trên cổng) · done (Admin đã nhập mã hoàn) · failed (cổng từ chối, có failure_reason). Không có failed → done (STM-10 v2.0).';
COMMENT ON COLUMN refunds.failure_reason IS
  'Lý do Admin ghi khi đánh dấu thất bại (1–1000 ký tự). Bắt buộc khi failed; làm lại giữ lý do cũ, lần thất bại sau ghi đè (0032).';
COMMENT ON COLUMN refunds.gateway_refund_no IS
  'Mã giao dịch hoàn trên cổng merchant VNPay do Admin nhập khi ghi nhận done (UNIQUE: một mã chỉ ghi một lần, BR-P51). Dòng done của luồng tự động cũ có thể NULL khi confirmed_via_query = true (0028).';
COMMENT ON COLUMN refunds.completed_at IS
  'Lúc Admin ghi nhận hoàn xong (done). Có giá trị ⇔ status = done. Không có nghĩa tiền đã về tài khoản tài xế.';
COMMENT ON COLUMN refunds.confirmed_via_query IS
  'Luồng gửi tự động cũ (#208, 0028): done nhờ querydr. Không dùng từ 0032, dòng mới luôn false.';
COMMENT ON COLUMN refunds.attempt_count IS
  'Luồng gửi tự động cũ (#208): số lần gọi VNPay refund. Không dùng từ 0032 (hoàn thủ công).';
COMMENT ON COLUMN refunds.last_error_kind IS
  'Luồng gửi tự động cũ (#208): loại lỗi lần gọi VNPay gần nhất. Không dùng từ 0032; lý do thất bại ở failure_reason.';
COMMENT ON COLUMN refunds.last_error_message IS
  'Luồng gửi tự động cũ (#208): thông điệp lỗi VNPay gần nhất. Không dùng từ 0032.';
COMMENT ON COLUMN refunds.last_attempt_at IS
  'Luồng gửi tự động cũ (#208): lần gọi VNPay refund gần nhất. Không dùng từ 0032.';
COMMENT ON COLUMN refunds.next_attempt_at IS
  'Luồng gửi tự động cũ (#208): lịch worker refund-send. Không dùng từ 0032 (không còn worker, không DEFAULT, không CHECK).';
COMMENT ON COLUMN refunds.unfinished_claims IS
  'Luồng gửi tự động cũ (#208, 0027): bộ đếm lease của worker refund-send. Không dùng từ 0032.';
COMMENT ON COLUMN top_ups.late_refunded_at IS
  'Lúc Admin ghi nhận refund late_payment của top-up là done (= refunds.completed_at, 0032).';
COMMENT ON COLUMN credit_accounts.closure_refunded_at IS
  'Lúc tài khoản closed không còn refund account_closure nào chưa done: Admin ghi nhận refund closure cuối cùng (0032), hoặc = closed_at khi lúc đóng không tạo refund nào. NULL = chưa hoàn xong.';

COMMIT;
