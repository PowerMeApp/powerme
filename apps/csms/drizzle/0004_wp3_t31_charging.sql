-- WP3/T31: durable app intents precede real OCPP sessions; WP2 session evidence stays authoritative.
BEGIN;
CREATE TABLE driver_charge_intents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id bigint NOT NULL REFERENCES drivers(user_id),
  connector_id bigint NOT NULL REFERENCES connectors(id),
  vehicle_id bigint NOT NULL REFERENCES vehicles(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  id_tag text NOT NULL UNIQUE CHECK (char_length(id_tag) <= 20),
  energy_limit_wh bigint NOT NULL CHECK (energy_limit_wh > 0),
  reserved_vnd bigint NOT NULL CHECK (reserved_vnd >= 0),
  command_id bigint UNIQUE REFERENCES remote_commands(id),
  session_id bigint UNIQUE REFERENCES sessions(id),
  state text NOT NULL CHECK (state IN ('sent','accepted','rejected','unknown','effect','settled')),
  rejection_reason text,
  max_energy_wh bigint,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(driver_id, idempotency_key)
);
CREATE UNIQUE INDEX driver_charge_intents_open_connector ON driver_charge_intents(connector_id)
  WHERE state NOT IN ('rejected','settled');
CREATE INDEX driver_charge_intents_driver ON driver_charge_intents(driver_id);

-- WP3/T31: stop retries retain one command, including uncertain outcomes after restart.
CREATE TABLE driver_stop_intents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id bigint NOT NULL REFERENCES drivers(user_id),
  session_id bigint NOT NULL REFERENCES sessions(id),
  idempotency_key text NOT NULL,
  command_id bigint NOT NULL UNIQUE REFERENCES remote_commands(id),
  state text NOT NULL CHECK (state IN ('sent','accepted','rejected','unknown','effect')),
  UNIQUE(driver_id, idempotency_key)
);
CREATE UNIQUE INDEX driver_stop_intents_open_session ON driver_stop_intents(session_id)
  WHERE state <> 'rejected';
CREATE TABLE charging_statements (
  session_id bigint PRIMARY KEY REFERENCES sessions(id),
  driver_id bigint NOT NULL REFERENCES drivers(user_id),
  energy_wh bigint NOT NULL CHECK (energy_wh >= 0),
  amount_vnd bigint NOT NULL CHECK (amount_vnd >= 0),
  earned_points bigint NOT NULL CHECK (earned_points >= 0),
  debit_id bigint NOT NULL UNIQUE REFERENCES credit_transactions(id),
  loyalty_entry_id bigint NOT NULL UNIQUE REFERENCES loyalty_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX loyalty_transactions_one_earn_per_session ON loyalty_transactions(session_id)
  WHERE transaction_type = 'earn' AND session_id IS NOT NULL;
COMMIT;
