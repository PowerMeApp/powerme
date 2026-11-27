/** WP3: persistent RFID credit obligations, independent of the recent command window. */
export interface RfidCreditProtection {
  total: number;
  exhausted_stops: number;
  held_vnd: string;
  limit: number;
  items: {
    session_id: string;
    charge_point_id: string;
    connector_no: number;
    session_status: string;
    credit_status: string | null;
    held_vnd: string | null;
    hold_state: string | null;
    hold_reason: string | null;
    stop_state: string | null;
    stop_reason: string | null;
    attempts: number | null;
    attempt_limit: number | null;
    current_command_id: string | null;
    last_error: string | null;
    next_attempt_at: string | null;
    exhausted_at: string | null;
    settlement_reason: string | null;
  }[];
}
