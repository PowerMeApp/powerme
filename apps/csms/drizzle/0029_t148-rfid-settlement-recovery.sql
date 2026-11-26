-- WP3/T148: revive only stopped, owned RFID debt skipped by the former eligibility gate.
BEGIN;
INSERT INTO charge_settlement_jobs(session_id,state,reason,next_attempt_at)
SELECT s.id,'pending','t148_rfid_recovered',now()
FROM sessions s
LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
WHERE s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL
  AND s.status IN ('closed','review','reconciled')
  AND s.received_stopped_at <= transaction_timestamp()
  AND (j.session_id IS NULL OR j.state='ineligible')
  AND NOT EXISTS(SELECT 1 FROM charging_statements st WHERE st.session_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM credit_transactions ct
    WHERE ct.session_id=s.id AND ct.transaction_type='session_debit')
ORDER BY s.id
FOR UPDATE OF s
ON CONFLICT(session_id) DO UPDATE
SET state='pending',reason='t148_rfid_recovered',last_error_code=NULL,
    next_attempt_at=now(),updated_at=now()
WHERE charge_settlement_jobs.state='ineligible';
COMMIT;
