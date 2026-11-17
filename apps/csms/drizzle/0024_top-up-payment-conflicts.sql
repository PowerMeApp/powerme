-- =============================================================================
-- PowerMe CSMS — migration 0024_top-up-payment-conflicts (T32 Phần 8b bổ sung, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0022. Số 0023 để cho T134 (nhánh
-- feat/t134-do-lech-dong-ho-tru, chưa merge lúc viết): migrate.mjs áp mọi file chưa áp theo thứ tự
-- tên, không đòi số liên tiếp, và hai migration độc lập. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts, enums.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0024.md.
--
-- Vì sao (Ân chốt 16/11): kết quả thanh toán mâu thuẫn (conflicting_result của TopUpStateMachine
-- từ PAYMENT_SUCCEEDED) trước đây chỉ log error nên Admin không thấy. Không ghi vào
-- top_ups.exception_kind vì (a) mỗi top-up chỉ có một exception_kind, sẽ đè loyalty_error /
-- unresolved_04/07; (b) late_* đã giữ khoản trễ thứ nhất, không còn chỗ lưu vnp_TransactionNo và
-- số tiền của lần trả mâu thuẫn. Mỗi lần trả mâu thuẫn là một dòng của bảng mới.
--
-- 1. Enum top_up_payment_conflict_reason, payment_result_source.
-- 2. Bảng top_up_payment_conflicts + CHECK + UNIQUE (top_up_id, gateway_transaction_no).
-- 3. Index: reviewed_by (A5), danh sách chưa xem (partial).
-- 4. COMMENT.
--
-- Không tiền kiểm: bảng mới, không có dữ liệu cũ. FK để NO ACTION (C3).
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- 1. Enum.
CREATE TYPE top_up_payment_conflict_reason AS ENUM ('extra_payment', 'amount_differs');
COMMENT ON TYPE top_up_payment_conflict_reason IS
  'Loại lần trả mâu thuẫn (0024): extra_payment = top-up đã có khoản trễ, thêm một lần trả thành công với vnp_TransactionNo khác (khoản thứ ba trở đi); amount_differs = cùng vnp_TransactionNo với giao dịch đã cộng hoặc khoản trễ đã ghi nhưng khác số tiền.';

CREATE TYPE payment_result_source AS ENUM ('ipn', 'querydr', 'recheck');
COMMENT ON TYPE payment_result_source IS
  'Đường nhận kết quả thanh toán VNPay (0024): ipn = IPN có chữ ký hợp lệ; querydr = vòng quét top-up quá hạn (chỉ chạy trên pending, nên không sinh mâu thuẫn); recheck = Admin "Kiểm tra lại".';

-- 2. Bảng.
CREATE TABLE top_up_payment_conflicts (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  top_up_id               bigint NOT NULL REFERENCES top_ups (id),
  gateway_transaction_no  varchar(100) NOT NULL,
  amount_vnd              bigint NOT NULL,
  paid_at                 timestamptz NOT NULL,
  source                  payment_result_source NOT NULL,
  reason                  top_up_payment_conflict_reason NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  reviewed_at             timestamptz,
  reviewed_by             bigint REFERENCES admins (user_id),
  review_note             text,
  CONSTRAINT top_up_payment_conflicts_top_up_txn_key UNIQUE (top_up_id, gateway_transaction_no),
  CONSTRAINT top_up_payment_conflicts_amount_check CHECK (amount_vnd >= 0),
  CONSTRAINT top_up_payment_conflicts_reviewed_check
    CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),
  CONSTRAINT top_up_payment_conflicts_review_note_check
    CHECK (reviewed_at IS NULL OR btrim(coalesce(review_note, '')) <> '')
);

-- 3. Index. top_up_id được phủ bởi UNIQUE (cột đầu) → A5.
CREATE INDEX top_up_payment_conflicts_reviewed_by_idx ON top_up_payment_conflicts (reviewed_by);
CREATE INDEX top_up_payment_conflicts_unreviewed_idx
  ON top_up_payment_conflicts (created_at) WHERE reviewed_at IS NULL;

-- 4. COMMENT.
COMMENT ON TABLE top_up_payment_conflicts IS
  'Lần trả thành công mâu thuẫn với kết quả đã ghi trên top-up (0024, T32 Phần 8b): một dòng mỗi (top-up, vnp_TransactionNo). TopUpService ghi trong cùng transaction với việc khoá top_ups → credit_accounts (nhánh conflicting_result của applyLockedResult), INSERT … ON CONFLICT DO NOTHING; không đụng top_ups (status, late_*, exception_kind). Admin xem ở Billing Exceptions (Phần 10), xử lý ngoài hệ thống: không có nút hoàn. IPN báo lỗi trên top-up đã cộng (PAYMENT_FAILED) không ghi ở đây.';
COMMENT ON COLUMN top_up_payment_conflicts.top_up_id IS 'Top-up mà lần trả này mang vnp_TxnRef.';
COMMENT ON COLUMN top_up_payment_conflicts.gateway_transaction_no IS
  'vnp_TransactionNo của lần trả mâu thuẫn (cùng kiểu top_ups.late_gateway_ref). UNIQUE theo cặp (top_up_id, gateway_transaction_no): VNPay gửi lại cùng giao dịch không thêm dòng; amount_differs mang cùng số với gateway_transaction_no / late_gateway_ref của top-up vẫn ghi được.';
COMMENT ON COLUMN top_up_payment_conflicts.amount_vnd IS
  'Số VNPay thực trừ của lần trả này, VND (vnp_Amount / 100). Lần gửi lại sau với số khác không ghi đè (chỉ log error).';
COMMENT ON COLUMN top_up_payment_conflicts.paid_at IS
  'vnp_PayDate (GMT+7) của lần trả; thiếu thì lúc ghi (now() của DB), như top_ups.late_paid_at.';
COMMENT ON COLUMN top_up_payment_conflicts.source IS
  'Đường nhận kết quả lần đầu ghi dòng: ipn hoặc recheck (querydr không sinh mâu thuẫn vì chỉ chạy trên pending).';
COMMENT ON COLUMN top_up_payment_conflicts.reason IS
  'extra_payment: đã có khoản trễ, thêm lần trả khác giao dịch. amount_differs: cùng giao dịch đã cộng hoặc đã ghi khoản trễ, khác số tiền.';
COMMENT ON COLUMN top_up_payment_conflicts.reviewed_at IS
  'Lúc Admin bấm "Đã xử lý" (Phần 10). NULL = chưa xem. Có ⇔ có reviewed_by; bắt buộc review_note.';
COMMENT ON COLUMN top_up_payment_conflicts.reviewed_by IS
  'admins.user_id của Admin đã xử lý (như refunds.requested_by). NULL ⇔ chưa xem.';
COMMENT ON COLUMN top_up_payment_conflicts.review_note IS
  'Admin ghi đã xử lý thế nào (hoàn tay, tra soát với VNPay…). Bắt buộc, không rỗng, khi reviewed_at có giá trị.';

COMMIT;
