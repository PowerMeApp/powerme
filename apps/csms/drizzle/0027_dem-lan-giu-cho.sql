-- =============================================================================
-- PowerMe CSMS — migration 0027_dem-lan-giu-cho (T32 Phần 8c, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0025. Số 0026 để cho PR của Sơn (chưa
-- merge lúc viết): migrate.mjs áp mọi file chưa áp theo thứ tự tên, không đòi số liên tiếp. File
-- này KHÔNG dùng gì của 0026. Schema Drizzle (apps/csms/src/db/schema/billing.ts, enums.ts) phải
-- khớp với file này. Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0027.md.
--
-- Vì sao (Khang chốt 19/11, theo review của Trí khi merge 8b): việc nền theo lease (due-rows.ts)
-- không đếm lần giữ chỗ. Dòng làm handle ném lỗi (sập, lỗi lặp ở tx2) giữ lease, hết lease lại
-- được lấy, mãi mãi. Thêm bộ đếm lần giữ chỗ chưa ra kết quả: tx1 tăng, tx2 commit đặt về 0; lần
-- thứ 6 liên tiếp thì bảng chuyển dòng sang trạng thái cần Admin xem. Top-up hết lượt sang
-- expired với exception_kind mới retry_exhausted.
--
-- 1. Enum top_up_exception_kind thêm 'retry_exhausted'.
-- 2. Cột unfinished_claims (integer NOT NULL DEFAULT 0, CHECK >= 0) trên bốn bảng dùng lease:
--    top_ups, e_invoices, invoice_adjustments, refunds. Dòng có sẵn nhận 0.
-- 3. top_ups_exception_kind_status_check: retry_exhausted chỉ đi với expired.
-- 4. COMMENT (gồm top_ups.next_attempt_at: lịch querydr mới 2/15/30/45/60, mốc 75 khi RC 94).
--
-- GHI CHÚ VỀ TRANSACTION: PostgreSQL không cho DÙNG giá trị enum vừa ADD VALUE trong cùng
-- transaction, mà CHECK ở bước 3 tham chiếu 'retry_exhausted'. Tiền lệ 0010/0011 tách hai file;
-- ở đây số migration đã chốt là 0027 nên dùng HAI transaction tường minh trong một file
-- (migrate.mjs và helper test gửi cả file bằng một simple query, COMMIT ở giữa có hiệu lực).
-- Khối 2 lỗi thì giá trị enum đã commit nhưng _migrations không ghi 0027; chạy lại an toàn nhờ
-- IF NOT EXISTS. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

-- 1. Enum (transaction riêng, phải COMMIT trước khi dùng).
BEGIN;
ALTER TYPE top_up_exception_kind ADD VALUE IF NOT EXISTS 'retry_exhausted';
COMMIT;

BEGIN;

-- 2. Bộ đếm trên bốn bảng dùng lease.
ALTER TABLE top_ups
  ADD COLUMN unfinished_claims integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT top_ups_unfinished_claims_check CHECK (unfinished_claims >= 0);
ALTER TABLE e_invoices
  ADD COLUMN unfinished_claims integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT e_invoices_unfinished_claims_check CHECK (unfinished_claims >= 0);
ALTER TABLE invoice_adjustments
  ADD COLUMN unfinished_claims integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT invoice_adjustments_unfinished_claims_check CHECK (unfinished_claims >= 0);
ALTER TABLE refunds
  ADD COLUMN unfinished_claims integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT refunds_unfinished_claims_check CHECK (unfinished_claims >= 0);

-- 3. retry_exhausted chỉ đi với expired (như unresolved_04 / unresolved_07).
ALTER TABLE top_ups DROP CONSTRAINT top_ups_exception_kind_status_check;
ALTER TABLE top_ups
  ADD CONSTRAINT top_ups_exception_kind_status_check
    CHECK (
      exception_kind IS NULL
      OR (exception_kind = 'loyalty_error' AND status IN ('credited', 'refunded'))
      OR (exception_kind IN ('unresolved_04', 'unresolved_07', 'retry_exhausted')
          AND status = 'expired')
    );

-- 4. COMMENT.
COMMENT ON TYPE top_up_exception_kind IS
  'Ngoại lệ top-up cần Admin xem (0021, 0027): unresolved_04 = VNPay báo giao dịch đảo (đã trừ tiền, chưa thành công) tới hạn querydr vẫn chưa rõ, top-up chuyển expired (Phần 8); unresolved_07 = VNPay báo mã 07 (đã trừ tiền, nghi gian lận) tới hạn querydr vẫn chưa rõ, top-up chuyển expired (Phần 8); loyalty_error = sổ điểm hỏng lúc cộng tiền, đã cộng tiền nhưng không trừ điểm (Phần 6); retry_exhausted = vòng quét querydr giữ chỗ quá 5 lần liên tiếp không ra kết quả (lỗi lặp, sập), top-up chuyển expired, chưa biết VNPay đã trừ tiền hay chưa (Phần 8c).';
COMMENT ON COLUMN top_ups.exception_kind IS
  'Ngoại lệ cần Admin xem (Billing Exceptions, 0021, 0027). loyalty_error: IPN/querydr đã cộng tiền nhưng sổ điểm hỏng (LoyaltyLedgerCorrupt) nên không trừ điểm, nền tảng chịu phần giảm giá (chỉ khi credited / refunded; Phần 6 ghi). unresolved_04 / unresolved_07: querydr tới hạn vẫn chưa ngã ngũ, top-up chuyển expired (chỉ khi expired; Phần 8 ghi). retry_exhausted: vòng quét hết lượt giữ chỗ (unfinished_claims), top-up chuyển expired (chỉ khi expired; Phần 8c ghi). NULL = không có ngoại lệ.';
COMMENT ON COLUMN top_ups.next_attempt_at IS
  'Lần querydr kế tiếp của top-up pending (T127, D4/D7; lịch đổi ở 0027, T32 Phần 8c). Lịch: expires_at + 2 phút, rồi + 15, 30, 45, 60 phút khi kết quả chưa ngã ngũ; thêm + 75 phút chỉ khi lần hỏi ở + 60 trả RC 94. Trong lúc giữ chỗ là hạn lease. NULL khi top-up không còn pending.';

COMMENT ON COLUMN top_ups.unfinished_claims IS
  'Số lần vòng quét querydr giữ chỗ dòng liên tiếp mà chưa ra kết quả (0027, D7): tx1 (claimDue) tăng 1, tx2 (lockLeased) commit được thì đặt về 0. Vượt 5 thì không querydr nữa: pending → expired + exception_kind retry_exhausted.';
COMMENT ON COLUMN e_invoices.unfinished_claims IS
  'Số lần việc nền xuất hoá đơn giữ chỗ dòng liên tiếp mà chưa ra kết quả (0027, D7): tx1 tăng 1, tx2 commit được thì đặt về 0; khác attempt_count (số lượt gọi nhà cung cấp đã ghi kết quả). Vượt 5 thì sang needs_review; Admin retry đặt về 0.';
COMMENT ON COLUMN invoice_adjustments.unfinished_claims IS
  'Số lần việc nền giữ chỗ dòng liên tiếp mà chưa ra kết quả (0027, D7): tx1 tăng 1, tx2 commit được thì đặt về 0. Xử lý khi vượt 5: Phần 9.';
COMMENT ON COLUMN refunds.unfinished_claims IS
  'Số lần việc nền giữ chỗ dòng liên tiếp mà chưa ra kết quả (0027, D7): tx1 tăng 1, tx2 commit được thì đặt về 0. Xử lý khi vượt 5: Phần 9.';

COMMIT;
