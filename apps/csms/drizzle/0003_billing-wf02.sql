-- =============================================================================
-- PowerMe CSMS — migration 0003_billing-wf02 (T73, WP2 — thuộc tính billing WF-02 của LERD-1 v0.4)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000_init + 0001 + 0002. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts, enums.ts, relations.ts) phải khớp từng cột với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0003.md.
--
-- Nguồn: LERD-1 v0.4 (thuộc tính WF-02 do Khang thêm ở v0.3) · CD-2 / SD-2a/b/c (PR #47)
--        · SRS BR-P13, BR-P14, BR-P21, BR-P22, BR-P37, BR-P44 · quyết định của Trí 26/10/2026.
--
-- Nội dung:
--   0. Tiền kiểm dữ liệu cũ — dừng cả migration nếu có hàng không thoả ràng buộc mới.
--   A. Enum: loyalty_transaction_type += restore · enum mới e_invoice_error_kind.
--   B. top_ups: gateway_reference đổi nghĩa (vnp_TxnRef, NOT NULL) · gateway_transaction_no ·
--      points_redeemed · expires_at (backfill created_at + 15 min rồi NOT NULL) · refunded_at /
--      refunded_by · late_gateway_ref (UNIQUE) / late_paid_at / late_amount_vnd / late_refunded_at
--      · CHECK/UNIQUE (bổ sung theo quyết định của Trí 27/10/2026 trên PR #60: late_* chỉ khi
--      expired, points_redeemed = 0 ⇔ points_discount_vnd = 0, gateway_transaction_no UNIQUE,
--      refunded ⇒ refunded_by).
--      KHÔNG làm ở DB: late_paid_at > expires_at + 1 giờ (LATE_WINDOW là tham số cấu hình — service
--      kiểm); refund_status (SD-2c "not modelled yet") — Planned.
--   C. credit_transactions: UNIQUE (top_up_id) → UNIQUE (top_up_id, transaction_type).
--   D. e_invoices: last_error_kind / last_error_message / last_attempt_at.
--   E. credit_accounts: closed_at / closure_refunded_at.
--
-- GHI CHÚ VỀ TRANSACTION (như 0001): từ PostgreSQL 12 `ALTER TYPE … ADD VALUE` chạy được trong
-- khối BEGIN/COMMIT, với điều kiện giá trị mới KHÔNG được dùng trước khi COMMIT. File này chỉ
-- THÊM giá trị `restore`, không INSERT/CHECK/DEFAULT nào dùng nó → cả file nằm trong MỘT
-- transaction. `e_invoice_error_kind` là TYPE MỚI (CREATE TYPE), dùng được ngay trong cùng
-- transaction. Sau migration này KHÔNG lùi ảnh được an toàn (Postgres không có DROP VALUE) —
-- xem infra/staging/README.md mục Rollback.
--
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. TIỀN KIỂM — ràng buộc mới cần dữ liệu cũ thoả. Không tự bịa giá trị: nếu có hàng vi phạm,
--    báo rõ và dừng (cả file là một transaction, không áp gì). Trên main chưa có code billing
--    nào ghi các bảng này; dữ liệu duy nhất là demo/seed.sql (một top-up credited có
--    gateway_reference, points_discount_vnd = 0, một ví active) nên các điều kiện dưới đều thoả.
--    Ràng buộc trên cột MỚI (late_* chỉ khi expired, gateway_transaction_no UNIQUE) không cần
--    kiểm: các cột đó chưa tồn tại trước 0003, hàng cũ nhận NULL nên luôn thoả.
--    `status = 'refunded'` bị chặn ở đây cho cả hai CHECK refunded ⇔ refunded_at và
--    refunded ⇒ refunded_by (hàng cũ không có cả hai giá trị).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM top_ups WHERE gateway_reference IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0003: % top_ups có gateway_reference NULL — cột thành NOT NULL (vnp_TxnRef). Gán mã cho các hàng này rồi chạy lại.', n;
  END IF;
  SELECT count(*) INTO n FROM top_ups WHERE status = 'refunded';
  IF n > 0 THEN
    RAISE EXCEPTION '0003: % top_ups status = refunded nhưng chưa có refunded_at — CHECK mới bắt buộc. Xử lý tay rồi chạy lại.', n;
  END IF;
  -- points_redeemed mới nhận 0 cho hàng cũ → hàng đã có giảm giá điểm sẽ vi phạm
  -- (points_redeemed = 0) = (points_discount_vnd = 0); số điểm thật không suy ra được.
  SELECT count(*) INTO n FROM top_ups WHERE points_discount_vnd <> 0;
  IF n > 0 THEN
    RAISE EXCEPTION '0003: % top_ups có points_discount_vnd <> 0 nhưng chưa có points_redeemed — CHECK mới bắt buộc. Xử lý tay rồi chạy lại.', n;
  END IF;
  SELECT count(*) INTO n FROM credit_accounts WHERE status = 'closed';
  IF n > 0 THEN
    RAISE EXCEPTION '0003: % credit_accounts status = closed nhưng chưa có closed_at — CHECK mới bắt buộc. Xử lý tay rồi chạy lại.', n;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- A. ENUM
-- -----------------------------------------------------------------------------

-- BR-P37: điểm đã dùng cho một top-up bị hoàn thì được trả lại (SD-2c E, LoyaltyService
-- .restoreForTopUp). Quyết định 26/10/2026: giữ earn/redeem/expire/adjust của 0000 (adjust lo
-- bút toán bù cho phiên bị sửa/hoàn), chỉ THÊM restore; KHÔNG dùng tên earned/redeemed/… của ERD.
ALTER TYPE loyalty_transaction_type ADD VALUE 'restore';

-- BR-P44, SD-2b: lỗi tạm thời (lỗi nhà cung cấp / timeout → tự thử lại) hay lỗi dữ liệu/cấu hình
-- (bị từ chối → needs_review, Admin xử lý). Enum theo quy ước của repo (THIET-KE-CSDL-VAT-LY §1).
CREATE TYPE e_invoice_error_kind AS ENUM ('transient', 'data');

-- -----------------------------------------------------------------------------
-- B. top_ups
-- -----------------------------------------------------------------------------

-- gateway_reference ĐỔI NGHĨA: trước là vnp_TransactionNo (do cổng cấp, có sau); nay là
-- vnp_TxnRef do CSMS sinh lúc tạo top-up (SD-2a), là BK của ERD → NOT NULL. UNIQUE
-- top_ups_gateway_reference_key giữ nguyên. Giá trị cũ (chỉ có của seed demo) giữ nguyên, không
-- chuyển sang gateway_transaction_no vì chưa từng có code nào ghi vnp_TransactionNo vào đây.
ALTER TABLE top_ups ALTER COLUMN gateway_reference SET NOT NULL;
COMMENT ON COLUMN top_ups.gateway_reference IS
  'vnp_TxnRef — mã tham chiếu do CSMS sinh lúc tạo top-up, gửi cho VNPay; BK, UNIQUE. (Trước migration 0003 cột này mô tả là vnp_TransactionNo.)';

ALTER TABLE top_ups
  ADD COLUMN gateway_transaction_no text,
  ADD COLUMN points_redeemed integer NOT NULL DEFAULT 0,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN refunded_at timestamptz,
  ADD COLUMN refunded_by bigint REFERENCES users (id),
  ADD COLUMN late_gateway_ref text,
  ADD COLUMN late_paid_at timestamptz,
  ADD COLUMN late_amount_vnd bigint,
  ADD COLUMN late_refunded_at timestamptz;

-- BR-P13: top-up chưa trả hết hạn sau 15 phút. Hàng cũ không có expires_at → suy từ created_at.
UPDATE top_ups SET expires_at = created_at + interval '15 minutes' WHERE expires_at IS NULL;
-- Không DEFAULT: TopUpService đặt expiresAt = now + 15 min lúc tạo (SD-2a); DB chỉ bắt có giá trị.
ALTER TABLE top_ups ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE top_ups
  ADD CONSTRAINT top_ups_late_gateway_ref_key UNIQUE (late_gateway_ref),
  ADD CONSTRAINT top_ups_points_redeemed_check CHECK (points_redeemed >= 0),
  -- Có điểm ⇔ có giảm giá (BR-P35, UC-PAY-03). Không ghi cứng tỉ lệ 100 điểm = 1.000 VND (Admin
  -- cấu hình). Chặn lỗi "giảm tiền mà không trừ điểm" và để hoàn (STM-4 #7) trả đúng số điểm.
  ADD CONSTRAINT top_ups_points_check
    CHECK ((points_redeemed = 0) = (points_discount_vnd = 0)),
  ADD CONSTRAINT top_ups_expires_at_check CHECK (expires_at > created_at),
  -- refunded là trạng thái cuối (STM-4 #7): có refunded_at ⇔ status = refunded.
  ADD CONSTRAINT top_ups_refunded_check
    CHECK ((status = 'refunded') = (refunded_at IS NOT NULL)),
  ADD CONSTRAINT top_ups_refunded_by_check
    CHECK (refunded_by IS NULL OR refunded_at IS NOT NULL),
  -- Hoàn top-up là thao tác tay của Admin (STM-4 #7, UC-ADM-08): sổ kiểm toán phải biết ai hoàn.
  -- Hoàn khi đóng ví ghi ở credit_accounts.closure_refunded_at, không ở đây.
  ADD CONSTRAINT top_ups_refunded_by_required_check
    CHECK (status <> 'refunded' OR refunded_by IS NOT NULL),
  -- SD-2c D: thanh toán muộn ghi ba cột cùng lúc (late_gateway_ref, late_paid_at, late_amount_vnd).
  ADD CONSTRAINT top_ups_late_payment_check
    CHECK (
      (late_gateway_ref IS NULL AND late_paid_at IS NULL AND late_amount_vnd IS NULL)
      OR (late_gateway_ref IS NOT NULL AND late_paid_at IS NOT NULL AND late_amount_vnd IS NOT NULL
          AND late_amount_vnd >= 0)
    ),
  -- Chỉ hoàn được khoản muộn đã ghi nhận, và không hoàn trước lúc nhận.
  ADD CONSTRAINT top_ups_late_refunded_check
    CHECK (late_refunded_at IS NULL OR (late_paid_at IS NOT NULL AND late_refunded_at >= late_paid_at)),
  -- SD-2c D: chỉ top-up expired nhận khoản muộn và nó vẫn expired; IPN cũ cho top-up
  -- failed/credited trả RspCode 02, không ghi gì. Chặn ghi khoản muộn lên top-up credited
  -- (tiền nhận hai lần). Cửa sổ 1 giờ (LATE_WINDOW, BR-P13) KHÔNG kiểm ở đây: tham số cấu hình,
  -- service kiểm.
  ADD CONSTRAINT top_ups_late_payment_status_check
    CHECK (late_gateway_ref IS NULL OR status = 'expired');

-- Một giao dịch VNPay chỉ cộng cho đúng một top-up (BR-P13): IPN phát lại / lỗi code gắn cùng
-- vnp_TransactionNo vào top-up thứ hai bị từ chối. Partial vì cột NULL tới khi cổng báo đã trả.
CREATE UNIQUE INDEX top_ups_gateway_transaction_no_key
  ON top_ups (gateway_transaction_no) WHERE gateway_transaction_no IS NOT NULL;

COMMENT ON COLUMN top_ups.gateway_transaction_no IS
  'vnp_TransactionNo — mã giao dịch phía VNPay, ghi khi IPN/querydr báo đã trả (SD-2b). NULL tới lúc đó; UNIQUE khi có.';
COMMENT ON COLUMN top_ups.points_redeemed IS
  'Số điểm thưởng dùng cho top-up này (BR-P35); points_discount_vnd là số tiền giảm tương ứng.';
COMMENT ON COLUMN top_ups.expires_at IS
  'Hết hạn thanh toán (BR-P13: tạo + 15 phút; vnp_ExpireDate). Hàng trước migration 0003: created_at + 15 phút.';
COMMENT ON COLUMN top_ups.refunded_at IS
  'Lúc Admin hoàn top-up (STM-4 #7, UC-ADM-08). Có giá trị ⇔ status = refunded.';
COMMENT ON COLUMN top_ups.refunded_by IS
  'users.id của Admin thực hiện hoàn (UC-ADM-08). Bắt buộc khi status = refunded. DB không kiểm role.';
COMMENT ON COLUMN top_ups.late_gateway_ref IS
  'Mã giao dịch của khoản thanh toán tới SAU cửa sổ 1 giờ (BR-P13, SD-2c D): không cộng ví, chờ Admin hoàn. UNIQUE — IPN lặp không ghi lần hai. Chỉ khi status = expired; cửa sổ 1 giờ do service kiểm.';
COMMENT ON COLUMN top_ups.late_paid_at IS 'Lúc nhận khoản thanh toán muộn (đồng hồ CSMS).';
COMMENT ON COLUMN top_ups.late_amount_vnd IS 'Số tiền của khoản thanh toán muộn (VND).';
COMMENT ON COLUMN top_ups.late_refunded_at IS 'Lúc Admin hoàn khoản thanh toán muộn về nguồn.';
COMMENT ON TABLE top_ups IS
  'Giao dịch nạp ví. BK = gateway_reference (vnp_TxnRef); idempotency_key chống trùng; late_* = thanh toán muộn chờ hoàn.';

-- -----------------------------------------------------------------------------
-- C. credit_transactions — một top-up có tối đa MỘT dòng mỗi loại
-- -----------------------------------------------------------------------------

-- Trước: một top-up tối đa một dòng ledger → top-up đã hoàn không ghi được dòng `refund`.
-- Nay: (top_up_id, transaction_type) — một `top_up` (credited once, BR-P13) + một `refund`
-- (SD-2c E; BR-P21 hoàn trọn một lần). credit_transactions_one_debit_per_session giữ nguyên.
DROP INDEX credit_transactions_one_per_top_up;
CREATE UNIQUE INDEX credit_transactions_one_per_top_up_and_type
  ON credit_transactions (top_up_id, transaction_type) WHERE top_up_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- D. e_invoices — lỗi lần gọi gần nhất (BR-P44, SD-2b, STM-7 #3)
-- -----------------------------------------------------------------------------

ALTER TABLE e_invoices
  ADD COLUMN last_error_kind e_invoice_error_kind,
  ADD COLUMN last_error_message text,
  ADD COLUMN last_attempt_at timestamptz,
  -- Lỗi chỉ có sau một lần gọi nhà cung cấp.
  ADD CONSTRAINT e_invoices_last_error_check
    CHECK (last_error_kind IS NULL OR last_attempt_at IS NOT NULL);

COMMENT ON COLUMN e_invoices.last_error_kind IS
  'Loại lỗi lần gọi gần nhất: transient (tự thử lại) · data (từ chối → needs_review). NULL = chưa lỗi.';
COMMENT ON COLUMN e_invoices.last_error_message IS 'Thông điệp lỗi gần nhất của nhà cung cấp HĐĐT.';
COMMENT ON COLUMN e_invoices.last_attempt_at IS 'Lần gần nhất gọi nhà cung cấp HĐĐT (đồng hồ CSMS).';

-- -----------------------------------------------------------------------------
-- E. credit_accounts — đóng ví (UC-ACC-02, BR-P21)
-- -----------------------------------------------------------------------------

ALTER TABLE credit_accounts
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closure_refunded_at timestamptz,
  -- closed là trạng thái cuối (STM-5): có closed_at ⇔ status = closed.
  ADD CONSTRAINT credit_accounts_closed_check
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- Hoàn số dư khi đóng ví chỉ sau khi ví đã đóng.
  ADD CONSTRAINT credit_accounts_closure_refunded_check
    CHECK (closure_refunded_at IS NULL OR (closed_at IS NOT NULL AND closure_refunded_at >= closed_at));

COMMENT ON COLUMN credit_accounts.closed_at IS
  'Lúc ví đóng theo yêu cầu đóng tài khoản (UC-ACC-02). Có giá trị ⇔ status = closed.';
COMMENT ON COLUMN credit_accounts.closure_refunded_at IS
  'Lúc Admin hoàn xong số dư chưa dùng về nguồn khi đóng ví (BR-P21, UC-ADM-08). NULL = chưa hoàn / không có gì để hoàn.';

COMMIT;
