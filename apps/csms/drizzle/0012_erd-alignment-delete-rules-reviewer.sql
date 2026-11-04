-- =============================================================================
-- PowerMe CSMS — migration 0012_erd-alignment-delete-rules-reviewer (BE-16, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0011. Schema Drizzle phải khớp file này.
-- Tham chiếu: 0011 (C3) và 0010 (B2) của Ân (WP1) trong bộ file ERD alignment.
--
--   C3  quy tắc xoá theo loại quan hệ (hướng dẫn ERD 8.1 quy tắc 5–6, 9.1):
--       · thành phần cấu thành → ON DELETE CASCADE:
--           connectors (theo charge_points), connector_status_events (theo charge_points),
--           tariff_periods (theo operators), session_pauses (theo sessions)
--       · cấu thành mà giữ tiền / pháp lý / kiểm toán → ON DELETE RESTRICT (không bao giờ xoá,
--         cha đóng bằng trạng thái):
--           credit_transactions → credit_accounts, loyalty_transactions → loyalty_accounts,
--           invoice_adjustments → e_invoices, meter_values → sessions (bảng partition: DROP/ADD
--           trên bảng cha lan xuống mọi partition), reconciliation_records → sessions,
--           session_tariff_segments → sessions
--       · FK còn lại giữ FK thường (NO ACTION). session_status_history đã RESTRICT từ 0001
--         (trigger append-only), không đổi.
--   B2  reconciliation_records.reviewed_by → operator_staff(user_id) (D14: chỉ nhân viên vận hành
--       duyệt), trước đây → users.
--
-- Không đổi hành vi ứng dụng, nhưng mọi thao tác xoá cha-trước-con (test, seed dọn dẹp) có thể
-- bị RESTRICT chặn: xoá con trước hoặc TRUNCATE … CASCADE.
-- Cả file là MỘT transaction.
-- =============================================================================

BEGIN;

-- ---- B2: kiểm trước, dừng rõ ràng thay vì sửa lặng lẽ dữ liệu kiểm toán ----
-- Bản ghi đối soát đã duyệt bởi người KHÔNG phải operator_staff (vd admin, đã có thể xảy ra vì
-- trước đây FK trỏ users) không thể chuyển sang FK mới mà không đổi lịch sử "ai duyệt". Nên
-- migration thất bại và nêu rõ các dòng; người vận hành xử lý tay (gán lại người duyệt hợp lệ
-- hoặc thêm dòng operator_staff) rồi chạy lại.
DO $$
DECLARE
  bad bigint;
  ids text;
BEGIN
  SELECT count(*), string_agg(r.id::text, ', ' ORDER BY r.id)
    INTO bad, ids
  FROM reconciliation_records r
  WHERE r.reviewed_by IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM operator_staff s WHERE s.user_id = r.reviewed_by);
  IF bad > 0 THEN
    RAISE EXCEPTION '0012/B2: % reconciliation_records có reviewed_by không thuộc operator_staff (id: %). Xử lý tay rồi chạy lại.', bad, ids;
  END IF;
END $$;

ALTER TABLE reconciliation_records
  DROP CONSTRAINT reconciliation_records_reviewed_by_fkey,
  ADD CONSTRAINT reconciliation_records_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES operator_staff(user_id);

-- ---- C3: CASCADE (thành phần cấu thành) ----
ALTER TABLE connectors
  DROP CONSTRAINT connectors_charge_point_id_fkey,
  ADD CONSTRAINT connectors_charge_point_id_fkey
    FOREIGN KEY (charge_point_id) REFERENCES charge_points(id) ON DELETE CASCADE;
ALTER TABLE connector_status_events
  DROP CONSTRAINT connector_status_events_charge_point_id_fkey,
  ADD CONSTRAINT connector_status_events_charge_point_id_fkey
    FOREIGN KEY (charge_point_id) REFERENCES charge_points(id) ON DELETE CASCADE;
ALTER TABLE tariff_periods
  DROP CONSTRAINT tariff_periods_operator_id_fkey,
  ADD CONSTRAINT tariff_periods_operator_id_fkey
    FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE;
ALTER TABLE session_pauses
  DROP CONSTRAINT session_pauses_session_id_fkey,
  ADD CONSTRAINT session_pauses_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

-- ---- C3: RESTRICT (tiền / pháp lý / kiểm toán) ----
ALTER TABLE credit_transactions
  DROP CONSTRAINT credit_transactions_credit_account_id_fkey,
  ADD CONSTRAINT credit_transactions_credit_account_id_fkey
    FOREIGN KEY (credit_account_id) REFERENCES credit_accounts(id) ON DELETE RESTRICT;
ALTER TABLE loyalty_transactions
  DROP CONSTRAINT loyalty_transactions_loyalty_account_id_fkey,
  ADD CONSTRAINT loyalty_transactions_loyalty_account_id_fkey
    FOREIGN KEY (loyalty_account_id) REFERENCES loyalty_accounts(id) ON DELETE RESTRICT;
ALTER TABLE invoice_adjustments
  DROP CONSTRAINT invoice_adjustments_e_invoice_id_fkey,
  ADD CONSTRAINT invoice_adjustments_e_invoice_id_fkey
    FOREIGN KEY (e_invoice_id) REFERENCES e_invoices(id) ON DELETE RESTRICT;
ALTER TABLE meter_values
  DROP CONSTRAINT meter_values_session_id_fkey,
  ADD CONSTRAINT meter_values_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT;
ALTER TABLE reconciliation_records
  DROP CONSTRAINT reconciliation_records_session_id_fkey,
  ADD CONSTRAINT reconciliation_records_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT;
ALTER TABLE session_tariff_segments
  DROP CONSTRAINT session_tariff_segments_session_id_fkey,
  ADD CONSTRAINT session_tariff_segments_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT;

COMMIT;
