-- =============================================================================
-- PowerMe CSMS — migration 0030_t150-kiem-the-offline (T150, WF-03, BR-P52)
--
-- Migration VIẾT TAY (ADR-0008), áp LÊN DB đã có 0000 … 0029. Schema Drizzle
-- (apps/csms/src/db/schema/stations.ts) phải khớp từng cột với file này.
-- Nhật ký + cách kiểm: docs/NHAT-KY-MIGRATION-0030.md.
--
-- Vì sao: trụ mất mạng mà còn cho authorize offline (Authorization Cache / Local List /
-- AllowOfflineTxForUnknownId) thì thẻ lạ hoặc thẻ đã khoá vẫn sạc được; CSMS chỉ biết khi trụ nối
-- lại, tiền không thu được → shortfall (BR-P20). Sau mỗi BootNotification CSMS đọc
-- (GetConfiguration) và tắt (ChangeConfiguration) các key đó; mỗi lần kiểm là MỘT dòng ở đây.
-- Dòng mới nhất của trụ quyết định cờ offline_card_risk trên dashboard.
--
-- Bảng chỉ ghi thêm (không UPDATE): giữ lịch sử để biết trụ từng "cứng đầu" lúc nào.
-- Không thêm enum, không đụng bảng cũ → một transaction.
-- Áp dụng: node apps/csms/scripts/migrate.mjs (hoặc helper test/helpers/apply-migrations.ts).
-- =============================================================================

BEGIN;

CREATE TABLE charge_point_offline_auth_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_point_id bigint NOT NULL REFERENCES charge_points (id),
  -- Epoch kết nối lúc kiểm (charge_point_connections.epoch).
  epoch integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  -- {key: {value, readonly} | null}; null = trụ trả key trong unknownKey hoặc không trả.
  config_values jsonb,
  -- {key: 'Accepted' | 'Rejected' | 'RebootRequired' | 'NotSupported' | 'timeout' | 'error' | 'skipped'}
  change_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Giá trị SupportedFeatureProfiles nguyên văn (CSL), null nếu trụ không trả.
  supported_feature_profiles text,
  offline_card_risk boolean NOT NULL,
  -- Mã lý do ngắn khi có rủi ro (OfflineCardRiskReason trong src/ocpp-gateway/offline-auth-check.service.ts).
  risk_reason varchar(40),
  -- Giới hạn dự phòng: kết quả SetChargingProfile TxDefaultProfile (Accepted / Rejected / NotSupported /
  -- timeout / error), 'unsupported' = trụ không khai SmartCharging nên không gửi, null = tắt hoặc không rủi ro.
  fallback_profile_status varchar(20),
  CONSTRAINT charge_point_offline_auth_checks_reason_check
    CHECK ((offline_card_risk AND risk_reason IS NOT NULL) OR (NOT offline_card_risk AND risk_reason IS NULL)),
  CONSTRAINT charge_point_offline_auth_checks_time_check CHECK (completed_at >= started_at)
);

CREATE INDEX charge_point_offline_auth_checks_cp_idx
  ON charge_point_offline_auth_checks (charge_point_id, id DESC);

COMMENT ON TABLE charge_point_offline_auth_checks IS
  'T150 / BR-P52: kết quả kiểm cấu hình authorize offline sau mỗi BootNotification; dòng mới nhất của trụ là cờ offline_card_risk.';

COMMIT;
