import type { Db } from '../db/db.module.js';

// WP3: durable exceptions stay visible independently of the latest twenty remote commands.
export async function rfidProtectionOverview(db: Db, scope: string, params: unknown[] = []) {
  const rows = (
    await db.$client.query(
      `SELECT s.id::text AS session_id,s.charge_point_id::text,s.connector_no,s.status AS session_status,
    a.status AS credit_status,h.amount_vnd::text AS held_vnd,h.state AS hold_state,h.reason AS hold_reason,
    j.state AS stop_state,j.reason AS stop_reason,j.attempts,j.attempt_limit,j.current_command_id::text,
    j.last_error,j.next_attempt_at,j.exhausted_at,b.reason AS settlement_reason,
    count(*) OVER()::int AS total,
    count(*) FILTER(WHERE j.state='exhausted') OVER()::int AS exhausted_stops,
    coalesce(sum(CASE WHEN h.state='held' THEN h.amount_vnd ELSE 0 END) OVER(),0)::text AS total_held_vnd
    FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id JOIN sites st ON st.id=cp.site_id
    LEFT JOIN credit_accounts a ON a.driver_id=s.driver_id LEFT JOIN rfid_credit_holds h ON h.session_id=s.id
    LEFT JOIN rfid_stop_jobs j ON j.session_id=s.id LEFT JOIN charge_settlement_jobs b ON b.session_id=s.id
    WHERE (${scope}) AND s.origin='rfid' AND s.payment_mode='csms_billed' AND s.driver_id IS NOT NULL
      AND (h.state='held' OR (j.session_id IS NOT NULL AND j.state<>'completed') OR NOT EXISTS(
        SELECT 1 FROM charging_statements paid JOIN credit_transactions debit ON debit.id=paid.debit_id
          AND debit.session_id=paid.session_id AND debit.transaction_type='session_debit' WHERE paid.session_id=s.id))
    ORDER BY (j.state='exhausted') DESC NULLS LAST,s.id LIMIT 50`,
      params,
    )
  ).rows;
  return {
    total: rows[0]?.total ?? 0,
    exhausted_stops: rows[0]?.exhausted_stops ?? 0,
    held_vnd: rows[0]?.total_held_vnd ?? '0',
    limit: 50,
    items: rows.map(({ total, exhausted_stops, total_held_vnd, ...row }) => row),
  };
}
