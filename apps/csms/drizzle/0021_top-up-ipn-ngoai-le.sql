-- =============================================================================
-- PowerMe CSMS — migration 0021_top-up-ipn-ngoai-le (T32 Phần 6, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0020. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts, enums.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0021.md.
--
-- Vì sao: Phần 6 mở IPN VNPay (SD-2b, WF-02 D3/D4/D8).
--   - Khoản trễ (thanh toán thành công có vnp_TransactionNo khác khoản đã ghi) nhận trên MỌI
--     trạng thái trừ pending (T116, Ân 12/11): gồm cả lần trả thứ hai cho top-up đã credited /
--     refunded. CHECK của 0003 chỉ cho expired.
--   - Lịch querydr lại (T127, D4 ⊕ ĐIỀU KIỆN) cần lưu lần hỏi kế tiếp cho từng top-up pending.
--   - Ngoại lệ top-up cho Billing Exceptions: sổ điểm hỏng lúc cộng tiền (Phần 6), ca 04/07 chưa
--     ngã ngũ tới hạn (Phần 8); Admin đánh dấu đã xem (Phần 10).
--   - Mỗi top-up tối đa một dòng loyalty adjust (điểm hết hạn trước lúc cộng tiền, D3 ⊕).
--
-- 1. Tiền kiểm: top_up_id nào có > 1 dòng loyalty adjust → RAISE EXCEPTION liệt kê top_up_id
--    (kèm số dòng), cả file ROLLBACK, không sửa dòng nào.
-- 2. top_ups_late_payment_status_check: late_gateway_ref IS NULL OR status <> 'pending'.
-- 3. COMMENT late_gateway_ref / late_paid_at / late_amount_vnd (bỏ cửa sổ 1 giờ của 0003).
-- 4. top_ups.next_attempt_at (nullable) + backfill pending = expires_at + 2 phút + partial index
--    cho vòng quét Phần 8 (đề xuất, Trí review).
-- 5. Enum top_up_exception_kind + top_ups.exception_kind / exception_reviewed_at + hai CHECK.
-- 6. Partial UNIQUE loyalty_transactions_one_adjust_per_top_up.
-- 7. COMMENT credit_accounts.closure_refunded_at (D1, chốt 09/11) và top_ups.completed_at.
--
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- 1. Tiền kiểm (trước khi ghi gì).
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('top_up_id %s (%s dòng)', g.top_up_id, g.n), '; ' ORDER BY g.top_up_id)
    INTO dup
    FROM (
      SELECT top_up_id, count(*) AS n
      FROM loyalty_transactions
      WHERE transaction_type = 'adjust' AND top_up_id IS NOT NULL
      GROUP BY top_up_id
      HAVING count(*) > 1
    ) AS g;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '0021: top-up có hơn một dòng loyalty adjust (%). Không sửa gì; đối chiếu sổ điểm của từng top-up, xoá / gộp dòng thừa bằng tay rồi chạy lại migrate', dup
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- 2. Khoản trễ trên mọi trạng thái trừ pending (T116).
ALTER TABLE top_ups DROP CONSTRAINT top_ups_late_payment_status_check;
ALTER TABLE top_ups
  ADD CONSTRAINT top_ups_late_payment_status_check
    CHECK (late_gateway_ref IS NULL OR status <> 'pending');

-- 3. Nghĩa mới của late_*.
COMMENT ON COLUMN top_ups.late_gateway_ref IS
  'vnp_TransactionNo của khoản trễ (0021): khoản thanh toán thành công có vnp_TransactionNo khác khoản đã ghi, tới khi top-up không còn pending (expired, failed, và cả lần trả thứ hai cho top-up đã credited / refunded, T116). Không cộng ví, chờ Admin hoàn (refund late_payment gửi số này). UNIQUE — IPN lặp không ghi lần hai. Không có cửa sổ thời gian (bỏ ở T117).';
COMMENT ON COLUMN top_ups.late_paid_at IS
  'Lúc thanh toán của khoản trễ: vnp_PayDate (GMT+7); thiếu thì thời điểm CSMS nhận IPN (đồng hồ DB).';
COMMENT ON COLUMN top_ups.late_amount_vnd IS
  'Số tiền của khoản trễ (VND) = vnp_Amount / 100.';

-- 4. Lịch querydr (T127).
ALTER TABLE top_ups ADD COLUMN next_attempt_at timestamptz;
UPDATE top_ups SET next_attempt_at = expires_at + interval '2 minutes' WHERE status = 'pending';
CREATE INDEX top_ups_pending_next_attempt_idx
  ON top_ups (next_attempt_at) WHERE status = 'pending';

COMMENT ON COLUMN top_ups.next_attempt_at IS
  'Lần querydr kế tiếp của top-up pending (T127, D4/D7). Lịch: expires_at + 2 phút, rồi + 5, 10, 20, 40, 60 phút khi kết quả chưa ngã ngũ. NULL khi top-up không còn pending. Dòng pending trước 0021: expires_at + 2 phút.';
COMMENT ON INDEX top_ups_pending_next_attempt_idx IS
  'Vòng quét querydr của Phần 8: status = pending AND next_attempt_at <= now() (D7, 0021).';

-- 5. Ngoại lệ top-up cho Billing Exceptions.
CREATE TYPE top_up_exception_kind AS ENUM ('unresolved_04', 'unresolved_07', 'loyalty_error');
COMMENT ON TYPE top_up_exception_kind IS
  'Ngoại lệ top-up cần Admin xem (0021): unresolved_04 = VNPay báo giao dịch đảo (đã trừ tiền, chưa thành công) tới hạn querydr vẫn chưa rõ, top-up chuyển expired (Phần 8); unresolved_07 = VNPay báo mã 07 (đã trừ tiền, nghi gian lận) tới hạn querydr vẫn chưa rõ, top-up chuyển expired (Phần 8); loyalty_error = sổ điểm hỏng lúc cộng tiền, đã cộng tiền nhưng không trừ điểm (Phần 6).';

ALTER TABLE top_ups
  ADD COLUMN exception_kind top_up_exception_kind,
  ADD COLUMN exception_reviewed_at timestamptz,
  ADD CONSTRAINT top_ups_exception_reviewed_check
    CHECK (exception_reviewed_at IS NULL OR exception_kind IS NOT NULL),
  ADD CONSTRAINT top_ups_exception_kind_status_check
    CHECK (
      exception_kind IS NULL
      OR (exception_kind = 'loyalty_error' AND status IN ('credited', 'refunded'))
      OR (exception_kind IN ('unresolved_04', 'unresolved_07') AND status = 'expired')
    );

COMMENT ON COLUMN top_ups.exception_kind IS
  'Ngoại lệ cần Admin xem (Billing Exceptions, 0021). loyalty_error: IPN/querydr đã cộng tiền nhưng sổ điểm hỏng (LoyaltyLedgerCorrupt) nên không trừ điểm, nền tảng chịu phần giảm giá (chỉ khi credited / refunded; Phần 6 ghi). unresolved_04 / unresolved_07: querydr tới hạn vẫn chưa ngã ngũ, top-up chuyển expired (chỉ khi expired; Phần 8 ghi). NULL = không có ngoại lệ.';
COMMENT ON COLUMN top_ups.exception_reviewed_at IS
  'Lúc Admin đánh dấu đã xem ngoại lệ (Phần 10). Chỉ có khi exception_kind có giá trị. NULL = chưa xem.';

-- 6. Một dòng adjust mỗi top-up.
CREATE UNIQUE INDEX loyalty_transactions_one_adjust_per_top_up
  ON loyalty_transactions (top_up_id)
  WHERE transaction_type = 'adjust' AND top_up_id IS NOT NULL;
COMMENT ON INDEX loyalty_transactions_one_adjust_per_top_up IS
  'Mỗi top-up tối đa một dòng adjust (0021). Từ T32 Phần 6, adjust gắn top-up chỉ có nghĩa "điểm đã dùng hết hạn trước lúc cộng tiền", points = 0 (D3 ⊕). Sổ điểm hỏng ghi ở top_ups.exception_kind, không bằng dòng adjust.';

-- 7. COMMENT sửa theo D1 / chốt 13/11.
COMMENT ON COLUMN credit_accounts.closure_refunded_at IS
  'Lúc ví closed không còn refund account_closure nào chưa done (BR-P21, SD-2f, D1 chốt 09/11): refund account_closure cuối cùng chuyển done; hoặc = closed_at khi lúc đóng không tạo refund nào (số dư 0, hoặc toàn bộ là phần dư không hoàn được). NULL chỉ có nghĩa là chưa hoàn xong. Hệ thống tự hoàn, Admin không thao tác.';
COMMENT ON COLUMN top_ups.completed_at IS
  'Lúc top-up rời pending (0021): pending → credited / failed (IPN, querydr) hoặc pending → expired (vòng quét). Không đổi khi credited → refunded (đã có refunded_at) và khi ghi khoản trễ. NULL khi còn pending.';

COMMIT;
