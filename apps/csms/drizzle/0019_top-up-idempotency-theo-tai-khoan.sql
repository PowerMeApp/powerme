-- =============================================================================
-- PowerMe CSMS — migration 0019_top-up-idempotency-theo-tai-khoan (T32 Phần 5, WP5)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0018. Schema Drizzle
-- (apps/csms/src/db/schema/billing.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0019.md.
--
-- Vì sao: Phần 5 mở route tạo top-up cho app tài xế (SD-2a, WF-02 D2).
--   - Idempotency-Key do app sinh, nên chỉ có nghĩa trong phạm vi một tài xế (như
--     driver_charge_intents): hai tài xế trùng key không được chặn nhau. UNIQUE cũ trên riêng
--     idempotency_key (0000) đổi thành UNIQUE (credit_account_id, idempotency_key); vì
--     credit_accounts_driver_id_key (mỗi tài xế một tài khoản) nên tương đương "theo tài xế".
--   - Gửi lại cùng key khác body phải ra 409 idempotency_conflict → cần request_hash.
--   - Luật "mỗi tài khoản chỉ một top-up pending" (D2) do DB giữ bằng partial UNIQUE, không chỉ
--     dựa vào khoá dòng trong TopUpService.
--
-- 1. Tiền kiểm: tài khoản nào đang có > 1 top-up pending → RAISE EXCEPTION liệt kê
--    credit_account_id (kèm số dòng), cả file ROLLBACK, không sửa dòng nào. Người vận hành tra
--    từng top-up trên cổng VNPay rồi chuyển dòng thừa sang trạng thái đúng bằng tay.
-- 2. Bỏ top_ups_idempotency_key_key; idempotency_key → varchar(100) (hợp đồng 8–100 ký tự; nới
--    varchar chỉ đổi metadata, không ghi lại bảng); thêm UNIQUE top_ups_account_idempotency_key_key.
-- 3. Bỏ index một cột top_ups_credit_account_id_idx: UNIQUE mới có cột đầu credit_account_id nên
--    đã phủ FK top_ups_credit_account_id_fkey (test A5).
-- 4. request_hash varchar(64), nullable: NULL = dòng không tạo qua API (seed / trước 0019).
-- 5. Partial UNIQUE top_ups_one_pending_per_account_key ON (credit_account_id) WHERE pending.
--
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

-- 1. Tiền kiểm (trước khi ghi gì).
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('credit_account_id %s (%s dòng)', g.credit_account_id, g.n), '; '
                    ORDER BY g.credit_account_id)
    INTO dup
    FROM (
      SELECT credit_account_id, count(*) AS n
      FROM top_ups
      WHERE status = 'pending'
      GROUP BY credit_account_id
      HAVING count(*) > 1
    ) AS g;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '0019: tài khoản có hơn một top-up pending (%). Không sửa gì; tra từng top-up trên cổng VNPay, chuyển các dòng thừa sang trạng thái đúng bằng tay rồi chạy lại migrate', dup
      USING ERRCODE = 'unique_violation';
  END IF;
END
$$;

-- 2. Idempotency theo tài khoản.
ALTER TABLE top_ups DROP CONSTRAINT top_ups_idempotency_key_key;
ALTER TABLE top_ups ALTER COLUMN idempotency_key TYPE varchar(100);
ALTER TABLE top_ups
  ADD CONSTRAINT top_ups_account_idempotency_key_key UNIQUE (credit_account_id, idempotency_key);

-- 3. FK credit_account_id đã được UNIQUE mới phủ (cột đầu).
DROP INDEX top_ups_credit_account_id_idx;

-- 4. Băm body của request tạo top-up.
ALTER TABLE top_ups ADD COLUMN request_hash varchar(64);

-- 5. Mỗi tài khoản tối đa một top-up pending.
CREATE UNIQUE INDEX top_ups_one_pending_per_account_key
  ON top_ups (credit_account_id) WHERE status = 'pending';

COMMENT ON COLUMN top_ups.idempotency_key IS
  'Header Idempotency-Key của app (8–100 ký tự, 0019). UNIQUE theo tài khoản (credit_account_id, idempotency_key): gửi lại cùng key trả lại cùng top-up, hai tài xế trùng key không chặn nhau.';
COMMENT ON COLUMN top_ups.request_hash IS
  'sha256 hex của JSON [amount_vnd, points_to_redeem] tài xế gửi (0019), cùng cách băm driver_charge_intents.request_hash. Cùng key khác hash → 409 idempotency_conflict. NULL = dòng không tạo qua API (seed / trước 0019).';
COMMENT ON INDEX top_ups_one_pending_per_account_key IS
  'Mỗi tài khoản tối đa một top-up pending (WF-02 D2, 0019). TopUpService khoá credit_accounts trước khi kiểm; index này chặn cả đường ghi ngoài API.';

COMMIT;
