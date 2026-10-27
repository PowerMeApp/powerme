-- WP3/T72: command attempts retain one business intent and immutable recovery evidence.
BEGIN;
CREATE TABLE driver_stop_attempts (
  command_id bigint PRIMARY KEY REFERENCES remote_commands(id),
  intent_id bigint NOT NULL REFERENCES driver_stop_intents(id),
  attempt_no integer NOT NULL CHECK(attempt_no > 0),
  kind text NOT NULL CHECK(kind IN ('initial','auto_retry','operator_recovery')),
  previous_command_id bigint UNIQUE REFERENCES remote_commands(id),
  connection_epoch integer,
  evidence_meter_id bigint,
  evidence_received_at timestamptz,
  operator_user_id bigint REFERENCES users(id),
  note text CHECK(char_length(note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent_id,attempt_no),
  UNIQUE(intent_id,evidence_meter_id,evidence_received_at),
  CHECK(kind <> 'operator_recovery' OR
    (previous_command_id IS NOT NULL AND connection_epoch IS NOT NULL AND evidence_meter_id IS NOT NULL
     AND evidence_received_at IS NOT NULL AND operator_user_id IS NOT NULL AND note IS NOT NULL))
);
INSERT INTO driver_stop_attempts(command_id,intent_id,attempt_no,kind)
  SELECT command_id,id,1,'initial' FROM driver_stop_intents;
CREATE TRIGGER driver_stop_attempts_no_update_delete BEFORE UPDATE OR DELETE ON driver_stop_attempts
  FOR EACH ROW EXECUTE FUNCTION session_status_history_append_only();
COMMIT;
