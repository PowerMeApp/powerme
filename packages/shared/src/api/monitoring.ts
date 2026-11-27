import type { RfidCreditProtection } from './rfid-protection.js';
/**
 * Operator charge point monitoring (FE-03, screens 17 and 18) — types only, snake_case as on the
 * wire. Source: apps/csms/src/operator-api/operator-monitoring.ts.
 */
import type { OperatorFault } from './faults.js';

/** The 9 raw OCPP 1.6 ChargePointStatus values; the dashboard shows them as is (D21). */
export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEVSE'
  | 'SuspendedEV'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';
export type ChargePointLifecycle =
  'registered' | 'awaiting_connection' | 'in_service' | 'disabled' | 'decommissioned';
/** BR-P39 / D20: `offline` overrides the status; `stale` = possibly out of date. */
export type StatusQuality = 'fresh' | 'stale' | 'offline';

export interface ConnectorLive {
  connector_id: string;
  connector_no: number;
  connector_type: 'ccs2' | 'chademo' | 'gbt' | 'type2' | null;
  max_power_kw: number | null;
  status: ConnectorStatus;
  status_updated_at: string | null;
  status_quality: StatusQuality;
  /** Latest ChargePointErrorCode while Faulted. */
  error_code: string | null;
  active_session_id: string | null;
}

/**
 * T150 / BR-P52: why the CSMS could not confirm that the charge point stopped authorising cards on
 * its own while offline. `not_checked` = no check yet (the charge point has not booted since T150).
 */
export type OfflineCardRiskReason =
  | 'not_checked'
  | 'no_response'
  | 'key_missing'
  | 'rejected'
  | 'not_supported'
  | 'reboot_required'
  | 'change_failed';

/** Latest GetConfiguration / ChangeConfiguration check after BootNotification (migration 0030). */
export interface OfflineAuthCheck {
  checked_at: string;
  epoch: number | null;
  /** key → value read; null = the charge point did not return the key (unknownKey). */
  config_values: Record<string, { value: string | null; readonly: boolean } | null> | null;
  /** key → ChangeConfiguration answer, `timeout` / `error`, or `skipped` (already false). */
  change_results: Record<string, string>;
  supported_feature_profiles: string | null;
  /** TxDefaultProfile fallback: OCPP status, `unsupported`, or null (off / not needed). */
  fallback_profile_status: string | null;
}

export interface OperatorChargePoint {
  id: string;
  serial_number: string;
  display_code: string | null;
  model: string | null;
  lifecycle: ChargePointLifecycle;
  /** Socket open in the CSMS process right now. */
  connected: boolean;
  is_online: boolean;
  last_message_at: string | null;
  site: { id: string; site_code: string; site_name: string };
  connectors: ConnectorLive[];
  /** T150 / BR-P52: offline authorisation not confirmed off — a blocked/unknown card may charge offline. */
  offline_card_risk: boolean;
  offline_card_risk_reason: OfflineCardRiskReason | null;
}

/** One row of `remote_commands` (UC-OPS-04); `action` is the OCPP action name as sent. */
export interface RemoteCommandRow {
  id: string;
  charge_point_id: string;
  action: string;
  connector_no: number | null;
  status: 'pending' | 'sent' | 'accepted' | 'rejected' | 'timeout' | 'failed';
  requested_at: string;
  sent_at: string | null;
  responded_at: string | null;
  error: string | null;
}

/** GET /api/operator/v1/charge-points/{id} (FE-05, screen 20). */
export interface OperatorChargePointDetail extends OperatorChargePoint {
  rfid_credit_protection?: RfidCreditProtection;
  firmware_version: string | null;
  rated_power_kw: number | null;
  /** BR-P40: the charge point sends SoC. */
  reports_soc: boolean;
  supports_reservation: boolean;
  /** T150: null = never checked. */
  offline_auth_check: OfflineAuthCheck | null;
  /** Same DTO as screen 21, with `allowed_actions`. */
  open_faults: OperatorFault[];
  /** Newest first, at most 20. */
  recent_commands: RemoteCommandRow[];
}

/** GET /api/operator/v1/charge-points query. */
export interface ChargePointQuery {
  site_id?: string;
  lifecycle?: ChargePointLifecycle;
  online?: boolean;
  page?: number;
  page_size?: number;
}

/** GET /api/operator/v1/charge-points (contract §2.4 list shape). */
export interface ChargePointPage {
  items: OperatorChargePoint[];
  total: number;
  page: number;
  page_size: number;
}

/** GET /api/operator/v1/summary — screen 17 tiles. */
export interface OperatorSummary {
  charge_points: {
    total: number;
    online: number;
    offline: number;
    by_lifecycle: Partial<Record<ChargePointLifecycle, number>>;
  };
  /** Driver-app grouping (BR-P38); Offline counted on its own. */
  connectors: {
    available: number;
    in_use: number;
    freeing_soon: number;
    unavailable: number;
    offline: number;
  };
  open_faults: { total: number; critical: number; major: number; minor: number; none: number };
  sessions_to_review: number;
  unattributed_sessions: number;
  /** T72: driver starts with an unknown outcome, waiting for the Operator. */
  uncertain_starts: number;
}
