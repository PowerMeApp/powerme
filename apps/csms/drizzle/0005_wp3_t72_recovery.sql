-- WP3/T72: persist billing work in the same transaction as stop evidence.
BEGIN;
ALTER TABLE session_tariff_segments ADD COLUMN exact_amount_milli_vnd numeric(40,0);
ALTER TABLE session_tariff_segments DROP CONSTRAINT session_tariff_segments_pkey;
ALTER TABLE session_tariff_segments ADD PRIMARY KEY(session_id,tariff_period_id,segment_start);
CREATE TABLE charge_settlement_jobs (
  session_id bigint PRIMARY KEY REFERENCES sessions(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','posted','ineligible')),
  reason text NOT NULL DEFAULT 'stop_observed',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charge_settlement_jobs_due ON charge_settlement_jobs(next_attempt_at) WHERE state='pending';
CREATE TABLE charge_tariff_boundary_evidence (
  session_id bigint NOT NULL REFERENCES sessions(id),
  boundary_at timestamptz NOT NULL,
  meter_wh bigint NOT NULL CHECK(meter_wh>=0),
  recorded_by bigint NOT NULL REFERENCES users(id),
  evidence_note text NOT NULL CHECK(char_length(evidence_note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,boundary_at)
);
ALTER TABLE driver_charge_intents ADD COLUMN connector_released_at timestamptz;
ALTER TABLE driver_charge_intents DROP CONSTRAINT driver_charge_intents_state_check;
ALTER TABLE driver_charge_intents ADD CONSTRAINT driver_charge_intents_state_check
  CHECK(state IN ('sent','accepted','rejected','unknown','effect','settled','released'));
CREATE TABLE driver_start_recoveries (
  intent_id bigint PRIMARY KEY REFERENCES driver_charge_intents(id),
  operator_user_id bigint NOT NULL REFERENCES users(id),
  connection_epoch integer NOT NULL,
  fence_command_id bigint NOT NULL UNIQUE REFERENCES remote_commands(id),
  restore_command_id bigint UNIQUE REFERENCES remote_commands(id),
  evidence_note text NOT NULL CHECK(char_length(evidence_note) BETWEEN 1 AND 500),
  released_vnd bigint NOT NULL CHECK(released_vnd>=0),
  released_at timestamptz,
  fence_attempt integer NOT NULL DEFAULT 1,
  restore_attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE driver_charge_intents ADD COLUMN billing_review_required boolean NOT NULL DEFAULT false;
CREATE TABLE driver_charge_intent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id bigint NOT NULL REFERENCES driver_charge_intents(id),
  actor_id bigint REFERENCES users(id),
  event text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP INDEX driver_charge_intents_open_connector;
CREATE UNIQUE INDEX driver_charge_intents_open_connector ON driver_charge_intents(connector_id)
  WHERE connector_released_at IS NULL AND state NOT IN ('rejected','settled');
CREATE FUNCTION wp3_queue_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.received_stopped_at IS NOT NULL THEN
    INSERT INTO charge_settlement_jobs(session_id) VALUES(NEW.id)
      ON CONFLICT(session_id) DO UPDATE SET next_attempt_at=now(),updated_at=now()
      WHERE charge_settlement_jobs.state='pending';
    UPDATE driver_charge_intents SET connector_released_at=coalesce(connector_released_at,now())
      WHERE session_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wp3_session_settlement AFTER INSERT OR UPDATE OF received_stopped_at,status ON sessions
  FOR EACH ROW EXECUTE FUNCTION wp3_queue_settlement();
INSERT INTO charge_settlement_jobs(session_id,state,reason)
  SELECT s.id,CASE WHEN st.session_id IS NULL THEN 'pending' ELSE 'posted' END,
    CASE WHEN st.session_id IS NULL THEN 'recovered_stop' ELSE 'already_posted' END
  FROM sessions s LEFT JOIN charging_statements st ON st.session_id=s.id
  WHERE s.received_stopped_at IS NOT NULL;
UPDATE driver_charge_intents i SET connector_released_at=now() FROM sessions s
  WHERE i.session_id=s.id AND s.received_stopped_at IS NOT NULL;
COMMIT;
