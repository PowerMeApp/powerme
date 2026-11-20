/**
 * Operator session queues (FE-12, screen 23, UC-OPS-05, WF-03) — types only, snake_case as on the
 * wire. Source: apps/csms/src/operator-api/operator-sessions.ts (wrapping Trí's BE-18 / BE-24
 * services).
 */

export type SessionQueue = 'unattributed' | 'review';

/** A stopped `unattributed` session without a decision yet (F-12). */
export interface UnattributedSession {
  session_id: string;
  transaction_no: number;
  charge_point_serial: string;
  /** Links to the charge point page (screen 20) and the station page. */
  charge_point_id: string;
  site_id: string;
  site_name: string;
  connector_no: number;
  id_tag: string;
  origin: string;
  /** closed | review | reconciled (STM-1, StopTransaction received). */
  status: string;
  energy_wh: number | null;
  delivered_offline: boolean;
  stopped_at: string;
  /** null = can be assigned; otherwise it can only be closed (BR-P08). */
  not_assignable_reason: 'free_vend_not_billable' | 'wallet_card_not_billable' | null;
  /** Open `unknown_id_tag` reconciliation records (why no driver was found at start). */
  open_records: string[];
}

/** A session in `review` waiting for the Operator's verdict (STM-1 #17). */
export interface ReviewSession {
  session_id: string;
  transaction_no: number;
  charge_point_serial: string;
  /** Links to the charge point page (screen 20) and the station page. */
  charge_point_id: string;
  site_id: string;
  site_name: string;
  connector_no: number;
  id_tag: string;
  origin: string;
  payment_mode: string;
  energy_wh: number | null;
  /** StopTransaction received: resolving it also settles the bill. */
  stopped: boolean;
  open_records: string[];
}

export type SessionQueuePage =
  | {
      queue: 'unattributed';
      items: UnattributedSession[];
      total: number;
      page: number;
      page_size: number;
    }
  | { queue: 'review'; items: ReviewSession[]; total: number; page: number; page_size: number };

export interface AssignSessionRequest {
  driver_id: string;
  note: string;
}
/** `reason`: short code a-z, 0-9, _ (≤ 40), e.g. owner_unknown, test_session, free_vend_ok. */
export interface CloseSessionRequest {
  reason: string;
  note: string;
}
/** `resolution`: short code a-z, 0-9, _ (≤ 40), e.g. meter_confirmed. */
export interface ResolveSessionRequest {
  resolution: string;
  note: string;
}

export type Settlement = 'posted' | 'already_posted' | 'pending' | 'ineligible';

export interface SessionDecisionResponse {
  session_id: string;
  already_resolved?: boolean;
  records_reviewed: number;
  settlement?: Settlement | null;
}
