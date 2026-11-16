-- =============================================================================
-- PowerMe CSMS — migration 0023_t134-do-lech-dong-ho-tru (T134, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0022. Schema Drizzle
-- (apps/csms/src/db/schema/enums.ts, sessions.ts) phải khớp với file này.
-- Nhật ký từng thay đổi + cách kiểm: docs/NHAT-KY-MIGRATION-0023.md.
--
-- Vì sao: quyết định D-I ngày 14/11 (BR-P02). Đồng hồ trụ lệch quá dung sai thì CSMS cộng độ lệch đo
-- được vào mọi mốc giờ trụ của phiên rồi mới chia khung giá, và ghi lại lần chỉnh cho operator. Trước
-- 0023 chỉ có hai kết quả: `cp` (giờ trụ) và `csms` (giờ nhận của CSMS).
--
-- 1. `reconciliation_record_type` thêm `tariff_clock_offset` — bản ghi "đã cộng độ lệch N giây".
--    Giá trị enum mới KHÔNG được dùng trong cùng transaction (PostgreSQL cấm): file này chỉ thêm,
--    không ghi dòng nào mang giá trị đó.
-- 2. `sessions.priced_clock` nhận thêm `cp_offset` (CHECK `sessions_priced_clock_check` viết lại).
-- 3. `charge_tariff_boundary_evidence.pricing_clock` nhận thêm `cp_offset`: số đo tại biên do operator
--    xác nhận cho phiên đã chỉnh giờ nằm trên trục giờ đã chỉnh, không lẫn với trục `cp`.
--
-- Không đổi dòng nào: phiên, bản ghi đối soát và bằng chứng biên đang có giữ nguyên giá trị.
-- Cả file trong MỘT transaction. Áp dụng: node apps/csms/scripts/migrate.mjs.
-- =============================================================================

BEGIN;

ALTER TYPE reconciliation_record_type ADD VALUE 'tariff_clock_offset';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_priced_clock_check,
  ADD CONSTRAINT sessions_priced_clock_check CHECK (
    (priced_clock IS NULL AND priced_ended_at IS NULL)
    OR (
      priced_clock IS NOT NULL
      AND priced_clock IN ('cp', 'cp_offset', 'csms')
      AND priced_ended_at IS NOT NULL
    )
  );

ALTER TABLE charge_tariff_boundary_evidence
  DROP CONSTRAINT charge_tariff_boundary_evidence_pricing_clock_check,
  ADD CONSTRAINT charge_tariff_boundary_evidence_pricing_clock_check
    CHECK (pricing_clock IN ('cp', 'cp_offset', 'csms'));

COMMENT ON COLUMN sessions.priced_clock IS
  'Đồng hồ dùng khi quyết toán (T101, T134): cp = giờ trụ; cp_offset = giờ trụ cộng độ lệch đo được; csms = giờ nhận của CSMS, cả phiên một khung giá. NULL nếu chưa quyết toán hoặc quyết toán trước 0020.';
COMMENT ON COLUMN sessions.priced_ended_at IS
  'T101/K3: mốc dừng dùng khi tính giá (cp_offset: giờ dừng của trụ đã cộng độ lệch); phiên cũ giữ NULL.';
COMMENT ON COLUMN charge_tariff_boundary_evidence.pricing_clock IS
  'Trục giờ của boundary_at: cp, cp_offset (đã cộng độ lệch, 0023) hoặc csms (chỉ còn ở dòng trước 0023).';

COMMIT;
