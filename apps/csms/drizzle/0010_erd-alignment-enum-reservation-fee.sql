-- =============================================================================
-- PowerMe CSMS — migration 0010_erd-alignment-enum-reservation-fee (BE-16, WP2)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0009. Schema Drizzle
-- (apps/csms/src/db/schema/enums.ts) phải khớp với file này.
--
-- Đồng bộ CSDL với Physical ERD v1.0 (ERD Alignment Decisions 31/10/2026, Ân duyệt) — A1:
-- quyết định 11, BR-P27: phí no-show của đặt chỗ là một dòng sổ cái → credit_transaction_type
-- thêm giá trị `reservation_fee`.
--
-- VÌ SAO MỘT FILE RIÊNG, KHÔNG CÓ BEGIN/COMMIT: PostgreSQL không cho DÙNG một giá trị enum vừa
-- ADD VALUE trong cùng transaction (0001/0003 chỉ thêm giá trị mà không dùng). Migration 0011
-- có CHECK credit_transactions_reservation_fee_check tham chiếu `reservation_fee`, nên giá trị
-- phải được COMMIT trước. scripts/migrate.mjs (và helper test) gửi từng file bằng MỘT lệnh
-- query riêng nên mỗi file là một transaction riêng: file này commit xong rồi 0011 mới chạy.
-- Chỉ MỘT câu lệnh để không phụ thuộc vào cách client bọc transaction. IF NOT EXISTS để chạy
-- lại an toàn (psql thủ công).
-- =============================================================================

ALTER TYPE credit_transaction_type ADD VALUE IF NOT EXISTS 'reservation_fee';
