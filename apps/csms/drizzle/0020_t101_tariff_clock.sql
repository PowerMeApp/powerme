BEGIN;

ALTER TYPE reconciliation_record_type ADD VALUE 'tariff_clock_fallback';

ALTER TABLE sessions
  ADD COLUMN priced_clock text,
  ADD COLUMN priced_ended_at timestamptz,
  ADD CONSTRAINT sessions_priced_clock_check CHECK (
    (priced_clock IS NULL AND priced_ended_at IS NULL)
    OR (priced_clock IS NOT NULL AND priced_clock IN ('cp', 'csms') AND priced_ended_at IS NOT NULL)
  );

COMMENT ON COLUMN sessions.priced_clock IS 'T101: đồng hồ dùng khi đã quyết toán; NULL nếu chưa biết.';
COMMENT ON COLUMN sessions.priced_ended_at IS 'T101/K3: mốc dừng dùng khi tính giá; phiên cũ giữ NULL.';

-- T72 evidence recorded before T101 used the charge-point clock.
ALTER TABLE charge_tariff_boundary_evidence
  ADD COLUMN pricing_clock text NOT NULL DEFAULT 'cp' CHECK (pricing_clock IN ('cp', 'csms')),
  DROP CONSTRAINT charge_tariff_boundary_evidence_pkey,
  ADD PRIMARY KEY (session_id, boundary_at, pricing_clock);

COMMIT;
