// WP3: expressions accept only trusted SQL identifiers/placeholders; callers bind all external values.
export function heldCreditSql(driver: string, ownSession = 'NULL', ownIntent = 'NULL'): string {
  return `(coalesce((SELECT sum(q.reserved_vnd) FROM driver_charge_intents q
    WHERE q.driver_id=${driver} AND q.id IS DISTINCT FROM ${ownIntent}::bigint
      AND (${ownSession}::bigint IS NULL OR q.session_id IS DISTINCT FROM ${ownSession}::bigint)
      AND q.state NOT IN ('rejected','settled','released')),0)
    + coalesce((SELECT sum(h.amount_vnd) FROM rfid_credit_holds h
      JOIN credit_accounts ca ON ca.id=h.credit_account_id WHERE ca.driver_id=${driver}
      AND h.session_id IS DISTINCT FROM ${ownSession}::bigint AND h.state='held'),0))`;
}

// WP3: unknown/zero obligations cannot disappear behind a zero monetary hold, even after Stop.
export function unresolvedRfidSql(
  driver: string,
  ownSession = 'NULL',
  blockingOnly = true,
): string {
  return `(SELECT count(*) FROM sessions exposure LEFT JOIN rfid_credit_holds eh ON eh.session_id=exposure.id
    WHERE exposure.driver_id=${driver} AND exposure.id IS DISTINCT FROM ${ownSession}::bigint
    AND exposure.origin='rfid' AND exposure.payment_mode='csms_billed'
    AND NOT EXISTS(SELECT 1 FROM charging_statements paid JOIN credit_transactions debit
      ON debit.id=paid.debit_id AND debit.session_id=paid.session_id AND debit.transaction_type='session_debit'
      WHERE paid.session_id=exposure.id)
    ${blockingOnly ? "AND (eh.session_id IS NULL OR eh.amount_vnd=0 OR eh.state<>'held')" : ''})`;
}
export function availableCreditSql(
  driver: string,
  balance: string,
  ownSession = 'NULL',
  ownIntent = 'NULL',
): string {
  return `(${balance}-${heldCreditSql(driver, ownSession, ownIntent)})`;
}
