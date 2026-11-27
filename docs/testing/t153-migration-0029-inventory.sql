-- T153: seven executed inventory SELECTs; queue/age/pair summaries were captured separately.
-- Run only on the approved clone; the wrapper below is added for read-only reuse.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Người chạy xác nhận powerme_t153 và READ ONLY; chạy cùng snapshot, kết thúc bằng ROLLBACK ở client.
-- Tiền là số đã ghi nhận, không phải nợ dự kiến; NULL từng session vẫn là chưa biết.
SELECT current_database() AS database, current_user AS role,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,
  transaction_timestamp() AS snapshot_at,
  current_database()='powerme_t153' AS database_matches_target;

SELECT name, applied_at,
  (name ~ '^0028.*(t148|rfid)' OR name='0030_rfid-credit-protection') AS legacy_local_name
FROM _migrations ORDER BY name;

-- R1: giữ nguyên predicate 0029, không age cap; account join theo driver đã chụp trên session.
WITH candidate_ids AS (
SELECT s.id FROM sessions s
LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
WHERE s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL
  AND s.status IN ('closed','review','reconciled')
  AND s.received_stopped_at <= transaction_timestamp()
  AND (j.session_id IS NULL OR j.state='ineligible')
  AND NOT EXISTS(SELECT 1 FROM charging_statements st WHERE st.session_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM credit_transactions ct
    WHERE ct.session_id=s.id AND ct.transaction_type='session_debit')
)
SELECT s.id::text AS session_id, s.driver_id::text AS captured_driver_id,
  ca.id::text AS credit_account_id, ca.status AS account_status, s.status AS session_status,
  s.cp_started_at, s.received_started_at, s.received_stopped_at,
  (transaction_timestamp()-s.received_started_at)::text AS age_from_received_start,
  (transaction_timestamp()-s.received_stopped_at)::text AS age_from_received_stop,
  s.energy_wh::text, s.total_cost_vnd::text AS recorded_session_total_cost_vnd,
  s.total_cost_vnd IS NOT NULL AS recorded_amount_known,
  j.state AS job_state, j.reason AS job_reason, j.attempts::text AS job_attempts,
  j.next_attempt_at, j.updated_at AS job_updated_at,
  false AS has_statement, false AS has_session_debit
FROM candidate_ids c JOIN sessions s ON s.id=c.id
LEFT JOIN credit_accounts ca ON ca.driver_id=s.driver_id
LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
ORDER BY s.id;

-- R1 tổng và per-account: subtotal phần biết có thể 0; unknown count không bị bỏ.
WITH candidate_ids AS (
SELECT s.id FROM sessions s
LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
WHERE s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL
  AND s.status IN ('closed','review','reconciled')
  AND s.received_stopped_at <= transaction_timestamp()
  AND (j.session_id IS NULL OR j.state='ineligible')
  AND NOT EXISTS(SELECT 1 FROM charging_statements st WHERE st.session_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM credit_transactions ct
    WHERE ct.session_id=s.id AND ct.transaction_type='session_debit')
)
SELECT CASE WHEN GROUPING(s.driver_id)=1 THEN 'all_candidates' ELSE 'per_account' END AS scope,
  s.driver_id::text AS captured_driver_id, ca.id::text AS credit_account_id, ca.status AS account_status,
  count(*)::text AS candidate_sessions, count(DISTINCT ca.id)::text AS credit_accounts,
  count(*) FILTER(WHERE ca.id IS NULL)::text AS missing_account_sessions,
  count(s.total_cost_vnd)::text AS known_recorded_amount_sessions,
  count(*) FILTER(WHERE s.total_cost_vnd IS NULL)::text AS unknown_amount_sessions,
  COALESCE(sum(s.total_cost_vnd) FILTER(WHERE s.total_cost_vnd IS NOT NULL),0)::text AS known_recorded_subtotal_vnd,
  count(*) FILTER(WHERE s.total_cost_vnd<0)::text AS negative_recorded_amount_sessions
FROM candidate_ids c JOIN sessions s ON s.id=c.id
LEFT JOIN credit_accounts ca ON ca.driver_id=s.driver_id
GROUP BY GROUPING SETS ((),(s.driver_id,ca.id,ca.status))
ORDER BY scope,ca.id NULLS LAST,s.driver_id;

-- Context loại trừ tài chính: các bucket có thể giao nhau, không phải tổng candidate.
WITH stopped AS (
  SELECT j.state AS job_state,
    EXISTS(SELECT 1 FROM charging_statements st WHERE st.session_id=s.id) AS has_statement,
    EXISTS(SELECT 1 FROM credit_transactions ct
      WHERE ct.session_id=s.id AND ct.transaction_type='session_debit') AS has_debit
  FROM sessions s LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
  WHERE s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL
    AND s.status IN ('closed','review','reconciled') AND s.received_stopped_at<=transaction_timestamp()
)
SELECT count(*)::text AS owned_billed_stopped_rfid_sessions,
  count(*) FILTER(WHERE has_statement)::text AS with_statement,
  count(*) FILTER(WHERE has_debit)::text AS with_session_debit,
  count(*) FILTER(WHERE has_statement AND has_debit)::text AS with_both,
  count(*) FILTER(WHERE has_statement AND NOT has_debit)::text AS statement_only,
  count(*) FILTER(WHERE has_debit AND NOT has_statement)::text AS debit_only,
  count(*) FILTER(WHERE has_statement OR has_debit)::text AS excluded_by_any_financial_evidence,
  count(*) FILTER(WHERE job_state IS NOT NULL AND job_state<>'ineligible')::text AS job_state_outside_selector
FROM stopped;

-- R5: mọi job của account đóng, cộng pending/account_closed ở mọi account; một snapshot không chứng minh churn.
WITH jobs AS (
  SELECT j.session_id::text, s.driver_id::text AS captured_driver_id, ca.id::text AS credit_account_id,
    ca.status AS account_status, s.origin, s.payment_mode, s.status AS session_status,
    j.state AS job_state, j.reason AS job_reason, j.attempts::text AS attempts,
    j.next_attempt_at, j.updated_at, j.last_error_code,
    s.received_stopped_at, s.meter_stop_wh::text, s.energy_wh::text,
    s.promotion_id IS NOT NULL AS has_promotion,
    EXISTS(SELECT 1 FROM driver_charge_intents i WHERE i.session_id=s.id AND i.billing_review_required) AS billing_review_required,
    EXISTS(SELECT 1 FROM charging_statements st WHERE st.session_id=s.id) AS has_statement,
    EXISTS(SELECT 1 FROM credit_transactions ct WHERE ct.session_id=s.id AND ct.transaction_type='session_debit') AS has_session_debit
  FROM charge_settlement_jobs j JOIN sessions s ON s.id=j.session_id
  LEFT JOIN credit_accounts ca ON ca.driver_id=s.driver_id
  WHERE ca.status='closed' OR (j.state='pending' AND j.reason='account_closed')
)
SELECT count(*) FILTER(WHERE account_status='closed')::text AS all_jobs_on_closed_accounts,
  count(*) FILTER(WHERE account_status='closed' AND job_state='pending')::text AS pending_on_closed_accounts,
  count(*) FILTER(WHERE job_state='pending' AND job_reason='account_closed')::text AS pending_account_closed_jobs,
  COALESCE(sum(attempts::numeric) FILTER(WHERE job_state='pending' AND job_reason='account_closed'),0)::text AS pending_account_closed_attempts_total,
  max(attempts::numeric) FILTER(WHERE job_state='pending' AND job_reason='account_closed')::text AS pending_account_closed_attempts_max,
  COALESCE(jsonb_agg(to_jsonb(jobs) ORDER BY session_id::bigint),'[]'::jsonb) AS details
FROM jobs;

-- Context toàn DB, tách khỏi tác động migration; debit giữ dấu gốc của ledger.
SELECT (SELECT count(*)::text FROM sessions) AS all_sessions,
  (SELECT count(*)::text FROM sessions WHERE origin='rfid') AS rfid_sessions,
  (SELECT count(*)::text FROM credit_accounts) AS credit_accounts,
  (SELECT count(*)::text FROM credit_accounts WHERE status='closed') AS closed_accounts,
  (SELECT COALESCE(sum(balance_vnd),0)::text FROM credit_accounts) AS credit_balance_total_vnd,
  (SELECT COALESCE(sum(amount_vnd),0)::text FROM credit_transactions WHERE transaction_type='session_debit') AS posted_debit_signed_total_vnd,
  (SELECT COALESCE(sum(amount_vnd),0)::text FROM charging_statements) AS statement_total_vnd;

ROLLBACK;
