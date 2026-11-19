-- WP3: additive mode support; legacy energy payload hashes and keys remain unchanged.
BEGIN;
ALTER TABLE driver_charge_intents
  ADD COLUMN mode billing_mode NOT NULL DEFAULT 'energy_kwh',
  ADD COLUMN duration_minutes bigint,
  ADD COLUMN amount_limit_vnd bigint,
  ADD COLUMN max_duration_minutes bigint,
  ADD COLUMN max_amount_vnd bigint,
  ALTER COLUMN energy_limit_wh DROP NOT NULL;
ALTER TABLE driver_charge_intents ADD CONSTRAINT driver_charge_intents_mode_limit_check CHECK (
  (mode='full' AND energy_limit_wh IS NULL AND duration_minutes IS NULL AND amount_limit_vnd IS NULL) OR
  (mode='energy_kwh' AND energy_limit_wh>0 AND energy_limit_wh IS NOT NULL AND duration_minutes IS NULL AND amount_limit_vnd IS NULL) OR
  (mode='timed' AND duration_minutes>0 AND duration_minutes IS NOT NULL AND energy_limit_wh IS NULL AND amount_limit_vnd IS NULL) OR
  (mode='amount_vnd' AND amount_limit_vnd>0 AND amount_limit_vnd IS NOT NULL AND energy_limit_wh IS NULL AND duration_minutes IS NULL)
);
ALTER TABLE driver_charge_intents ADD CONSTRAINT driver_charge_intents_mode_caps_check CHECK (
  (max_energy_wh IS NULL OR (mode='energy_kwh' AND max_energy_wh>=0)) AND
  (max_duration_minutes IS NULL OR (mode='timed' AND max_duration_minutes>=0)) AND
  (max_amount_vnd IS NULL OR (mode='amount_vnd' AND max_amount_vnd>=0))
);
COMMIT;
