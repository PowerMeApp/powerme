// Keep list and progress capabilities identical; POST stop rechecks its own conditions.
export const SESSION_CAPABILITIES_SQL = `
  (s.origin='app_qr' AND s.meter_stop_wh IS NULL
    AND s.status IN ('active','paused','orphaned')
    AND EXISTS(SELECT 1 FROM driver_charge_intents ci
      WHERE ci.session_id=s.id AND ci.driver_id=s.driver_id)) AS can_stop,
  (s.payment_mode='csms_billed' AND EXISTS(SELECT 1 FROM charging_statements cs
    WHERE cs.session_id=s.id AND cs.driver_id=s.driver_id)) AS statement_available`;
