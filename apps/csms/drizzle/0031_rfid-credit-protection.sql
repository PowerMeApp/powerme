BEGIN;
CREATE TABLE IF NOT EXISTS rfid_credit_holds (
  session_id bigint PRIMARY KEY REFERENCES sessions(id),
  credit_account_id bigint NOT NULL REFERENCES credit_accounts(id),
  amount_vnd bigint NOT NULL CHECK (amount_vnd >= 0),
  state varchar(16) NOT NULL DEFAULT 'held' CHECK (state IN ('held','released')),
  reason varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK ((state='released') = (released_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rfid_credit_holds_account_idx ON rfid_credit_holds(credit_account_id);
CREATE INDEX IF NOT EXISTS rfid_credit_holds_outstanding_account_idx
  ON rfid_credit_holds(credit_account_id,session_id) WHERE state='held';
CREATE TABLE IF NOT EXISTS rfid_stop_jobs (
  session_id bigint PRIMARY KEY REFERENCES sessions(id),
  reason varchar(64) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','inflight','awaiting_stop','retry','exhausted','completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  attempt_limit integer NOT NULL CHECK (attempt_limit > 0),
  current_command_id bigint REFERENCES remote_commands(id),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  exhausted_at timestamptz,
  last_error varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= attempt_limit),
  CHECK (state <> 'exhausted' OR exhausted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS rfid_stop_jobs_command_idx ON rfid_stop_jobs(current_command_id);
CREATE INDEX IF NOT EXISTS rfid_stop_jobs_due_idx ON rfid_stop_jobs(next_attempt_at,session_id)
  WHERE state NOT IN ('completed','exhausted');
CREATE INDEX IF NOT EXISTS sessions_unpaid_rfid_driver_idx ON sessions(driver_id,id)
  WHERE origin='rfid' AND payment_mode='csms_billed' AND driver_id IS NOT NULL;
-- WP3: historical obligations remain visible through the shared policy; no historical money allocation.
COMMIT;
