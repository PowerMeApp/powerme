-- =============================================================================
-- PowerMe CSMS — migration 0012_billing-refunds-wf02 (T32, WP5 — hoàn tiền và lịch quét billing)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0009. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts, enums.ts, relations.ts) phải khớp từng cột với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0012.md.
--
-- Nguồn: diagram WF-02 v2.0 (diagrams/wf02/CD-2, SD-2c, SD-2e, SD-2f, 01/11/2026)
--        · docs/spec/WF-02_decisions.md D1 (Refund, STM-10), D5 (InvoiceAdjustment), D7 (việc nền
--        chạy bằng quét DB), D8 (số migration 0012). Số 0012 giữ theo CD-2; 0010/0011 chưa có —
--        migrate.mjs áp theo thứ tự tên file nên vẫn chạy được.
--
-- Nội dung:
--   0. Tiền kiểm: invoice_adjustments phải rỗng (cột trạng thái mới không suy ra được cho hàng cũ).
--   A. Enum mới refund_kind, refund_status.
--   B. Bảng refunds (STM-10): ghi quyết định hoàn trong cùng transaction với sổ cái, worker gửi
--      VNPay sau (D1). last_error_kind dùng lại e_invoice_error_kind (cùng nghĩa transient/data,
--      một helper retry dùng chung — D7).
--   C. invoice_adjustments: refund_id, trạng thái theo STM-7 (dùng lại e_invoice_status), bộ đếm,
--      lỗi gần nhất, lịch quét, provider_adjustment_no; issued_at thành nullable (chỉ có khi issued).
--   D. e_invoices.next_attempt_at: backfill now() cho hoá đơn requested/failed để worker bắt lại.
--   E. top_ups: index (status, expires_at) cho vòng quét timeout 15 phút (SD-2d).
--   F. COMMENT mới cho credit_accounts.closure_refunded_at và top_ups.late_refunded_at (D1: hoàn
--      về nguồn là việc của refund, không còn là thao tác tay của Admin).
--
-- next_attempt_at có DEFAULT now(): dòng mới tạo đến hạn ngay, worker nhặt ở vòng quét kế tiếp;
-- Scheduler trong process chỉ để chạy sớm (D7). CHECK chặn để NULL khi dòng còn chờ xử lý.
--
-- GHI CHÚ VỀ TRANSACTION: chỉ CREATE TYPE (không ALTER TYPE … ADD VALUE), CREATE TABLE, ALTER
-- TABLE, CREATE INDEX — đều transactional, nên cả file nằm trong MỘT transaction.
--
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. TIỀN KIỂM — chưa có code nào ghi invoice_adjustments (demo/seed.sql cũng không). Hàng cũ (nếu
--    có, do ghi tay) không có trạng thái, số điều chỉnh của nhà cung cấp hay refund gốc; không tự
--    bịa: báo rõ và dừng (cả file là một transaction, không áp gì).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM invoice_adjustments;
  IF n > 0 THEN
    RAISE EXCEPTION '0012: % invoice_adjustments đã có — trạng thái/số điều chỉnh/refund gốc của hàng cũ không suy ra được. Xử lý tay (xoá hoặc ghi lại sau 0012) rồi chạy lại.', n;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- A. Enum
-- -----------------------------------------------------------------------------

CREATE TYPE refund_kind AS ENUM ('top_up', 'late_payment', 'account_closure');
CREATE TYPE refund_status AS ENUM ('requested', 'done', 'failed');

-- -----------------------------------------------------------------------------
-- B. refunds — hoàn tiền về nguồn thanh toán (STM-10, SD-2e, SD-2f)
-- -----------------------------------------------------------------------------

CREATE TABLE refunds (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  top_up_id           bigint NOT NULL REFERENCES top_ups (id),
  kind                refund_kind NOT NULL,
  amount_vnd          bigint NOT NULL,
  status              refund_status NOT NULL DEFAULT 'requested',
  attempt_count       integer NOT NULL DEFAULT 0,
  requested_by        bigint REFERENCES users (id),
  last_error_kind     e_invoice_error_kind,
  last_error_message  text,
  last_attempt_at     timestamptz,
  gateway_refund_no   text,
  next_attempt_at     timestamptz DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT refunds_gateway_refund_no_key UNIQUE (gateway_refund_no),
  CONSTRAINT refunds_amount_check CHECK (amount_vnd > 0),
  CONSTRAINT refunds_attempt_count_check CHECK (attempt_count >= 0),
  -- Hoàn top-up và hoàn khoản trễ là quyết định của Admin (SD-2e); hoàn khi đóng tài khoản do hệ
  -- thống tạo (SD-2f, requested_by = NULL).
  CONSTRAINT refunds_requested_by_check
    CHECK (kind = 'account_closure' OR requested_by IS NOT NULL),
  -- done là trạng thái cuối, có thời điểm hoàn tất và mã hoàn VNPay trả về.
  CONSTRAINT refunds_completed_check CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT refunds_gateway_refund_no_check
    CHECK (status <> 'done' OR gateway_refund_no IS NOT NULL),
  CONSTRAINT refunds_last_error_check CHECK (last_error_kind IS NULL OR last_attempt_at IS NOT NULL),
  -- Refund đang chờ gửi phải có lịch để worker quét thấy (D7).
  CONSTRAINT refunds_next_attempt_check CHECK (status <> 'requested' OR next_attempt_at IS NOT NULL)
);

-- Mỗi top-up hoàn tối đa một lần theo từng loại do Admin quyết; account_closure có thể chia nhiều
-- phần trên cùng top-up qua các lần đóng tài khoản khác nhau nên không chặn.
CREATE UNIQUE INDEX refunds_one_per_top_up_and_kind
  ON refunds (top_up_id, kind) WHERE kind IN ('top_up', 'late_payment');
CREATE INDEX refunds_top_up_id_idx ON refunds (top_up_id);
CREATE INDEX refunds_status_next_attempt_at_idx ON refunds (status, next_attempt_at);

COMMENT ON TABLE refunds IS
  'Hoàn tiền về nguồn thanh toán (STM-10): requested → done | failed; failed → requested khi Admin retry. Tạo cùng transaction với quyết định hoàn, gửi VNPay bằng worker quét DB.';
COMMENT ON COLUMN refunds.top_up_id IS 'Top-up gốc có giao dịch VNPay để hoàn về (TopUp 1 – 0..* Refund).';
COMMENT ON COLUMN refunds.kind IS
  'top_up (Admin hoàn top-up, SD-2e) · late_payment (Admin hoàn khoản trả trễ, không ghi sổ cái) · account_closure (hệ thống hoàn số dư khi đóng tài khoản, SD-2f).';
COMMENT ON COLUMN refunds.amount_vnd IS 'Số tiền hoàn về nguồn, VND > 0. Không vượt số đã trả của top-up — RefundService kiểm.';
COMMENT ON COLUMN refunds.status IS 'requested · done · failed (STM-10). Không có failed → done.';
COMMENT ON COLUMN refunds.attempt_count IS 'Số lần đã gọi VNPay refund. Tối đa 4 lượt; Admin retry không reset.';
COMMENT ON COLUMN refunds.requested_by IS 'users.id của Admin ra quyết định hoàn. NULL = hệ thống tạo (account_closure).';
COMMENT ON COLUMN refunds.last_error_kind IS
  'Loại lỗi lần gọi VNPay gần nhất: transient (hẹn thử lại) · data (bị từ chối → failed). Dùng chung enum với e_invoices.';
COMMENT ON COLUMN refunds.last_error_message IS 'Thông điệp lỗi gần nhất của VNPay.';
COMMENT ON COLUMN refunds.last_attempt_at IS 'Lần gần nhất gọi VNPay refund (đồng hồ CSMS).';
COMMENT ON COLUMN refunds.gateway_refund_no IS 'Mã giao dịch hoàn VNPay trả về khi xác nhận. Bắt buộc khi done.';
COMMENT ON COLUMN refunds.next_attempt_at IS
  'Lúc worker được xử lý dòng này (D7): now() khi tạo, rồi +5 phút / 30 phút / 2 giờ sau mỗi lỗi tạm thời.';
COMMENT ON COLUMN refunds.completed_at IS 'Lúc VNPay xác nhận hoàn xong. Có giá trị ⇔ status = done.';

-- -----------------------------------------------------------------------------
-- C. invoice_adjustments — điều chỉnh hoá đơn sau khi refund done (D5, STM-7)
-- -----------------------------------------------------------------------------

ALTER TABLE invoice_adjustments
  ADD COLUMN refund_id bigint REFERENCES refunds (id),
  ADD COLUMN status e_invoice_status NOT NULL DEFAULT 'requested',
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error_kind e_invoice_error_kind,
  ADD COLUMN last_error_message text,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz DEFAULT now(),
  ADD COLUMN provider_adjustment_no text,
  ALTER COLUMN issued_at DROP NOT NULL,
  ALTER COLUMN issued_at DROP DEFAULT,
  -- Refund 1 – 0..1 InvoiceAdjustment.
  ADD CONSTRAINT invoice_adjustments_refund_id_key UNIQUE (refund_id),
  ADD CONSTRAINT invoice_adjustments_provider_adjustment_no_key UNIQUE (provider_adjustment_no),
  ADD CONSTRAINT invoice_adjustments_attempt_count_check CHECK (attempt_count >= 0),
  ADD CONSTRAINT invoice_adjustments_issued_check
    CHECK (status <> 'issued' OR (issued_at IS NOT NULL AND provider_adjustment_no IS NOT NULL)),
  ADD CONSTRAINT invoice_adjustments_last_error_check
    CHECK (last_error_kind IS NULL OR last_attempt_at IS NOT NULL),
  ADD CONSTRAINT invoice_adjustments_next_attempt_check
    CHECK (status NOT IN ('requested', 'failed') OR next_attempt_at IS NOT NULL);

CREATE INDEX invoice_adjustments_status_next_attempt_at_idx
  ON invoice_adjustments (status, next_attempt_at);

COMMENT ON COLUMN invoice_adjustments.refund_id IS 'Refund đã done sinh ra điều chỉnh này (UNIQUE). Hoàn khoản trễ không có điều chỉnh.';
COMMENT ON COLUMN invoice_adjustments.status IS 'requested · issued · failed · needs_review (STM-7, giống e_invoices).';
COMMENT ON COLUMN invoice_adjustments.attempt_count IS 'Số lần đã gọi nhà cung cấp HĐĐT. Tối đa 4 lượt; Admin retry không reset.';
COMMENT ON COLUMN invoice_adjustments.last_error_kind IS
  'Loại lỗi lần gọi gần nhất: transient (tự thử lại) · data (từ chối → needs_review). NULL = chưa lỗi.';
COMMENT ON COLUMN invoice_adjustments.last_error_message IS 'Thông điệp lỗi gần nhất của nhà cung cấp HĐĐT.';
COMMENT ON COLUMN invoice_adjustments.last_attempt_at IS 'Lần gần nhất gọi nhà cung cấp HĐĐT (đồng hồ CSMS).';
COMMENT ON COLUMN invoice_adjustments.next_attempt_at IS 'Lúc worker được xử lý dòng này (D7). Bắt buộc khi requested/failed.';
COMMENT ON COLUMN invoice_adjustments.provider_adjustment_no IS 'Số điều chỉnh do nhà cung cấp HĐĐT cấp. Bắt buộc khi issued.';
COMMENT ON COLUMN invoice_adjustments.issued_at IS 'Lúc nhà cung cấp phát hành điều chỉnh. Từ 0012: NULL tới khi issued.';

-- -----------------------------------------------------------------------------
-- D. e_invoices — lịch quét (D7)
-- -----------------------------------------------------------------------------

ALTER TABLE e_invoices ADD COLUMN next_attempt_at timestamptz;

-- Hoá đơn còn chờ xuất: đến hạn ngay để worker bắt lại. issued / needs_review giữ NULL.
UPDATE e_invoices SET next_attempt_at = now() WHERE status IN ('requested', 'failed');

ALTER TABLE e_invoices
  ALTER COLUMN next_attempt_at SET DEFAULT now(),
  ADD CONSTRAINT e_invoices_next_attempt_check
    CHECK (status NOT IN ('requested', 'failed') OR next_attempt_at IS NOT NULL);

CREATE INDEX e_invoices_status_next_attempt_at_idx ON e_invoices (status, next_attempt_at);

COMMENT ON COLUMN e_invoices.next_attempt_at IS
  'Lúc worker được xử lý dòng này (D7): now() khi tạo, rồi +5 phút / 30 phút / 2 giờ sau mỗi lỗi tạm thời. Bắt buộc khi requested/failed.';

-- -----------------------------------------------------------------------------
-- E. top_ups — quét top-up pending quá hạn (SD-2d)
-- -----------------------------------------------------------------------------

CREATE INDEX top_ups_status_expires_at_idx ON top_ups (status, expires_at);

-- -----------------------------------------------------------------------------
-- F. Nghĩa mới của cột đã có (D1)
-- -----------------------------------------------------------------------------

COMMENT ON COLUMN credit_accounts.closure_refunded_at IS
  'Lúc mọi refund account_closure của ví đã done (BR-P21, SD-2f; hệ thống tự hoàn, Admin không cần thao tác). NULL = chưa xong / không có gì để hoàn.';
COMMENT ON COLUMN top_ups.late_refunded_at IS
  'Lúc refund late_payment của top-up chuyển done (SD-2e).';

COMMIT;
