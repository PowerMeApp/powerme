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
  site: {
    id: string;
    site_code: string;
    site_name: string;
    /** FE-03c: Charging Station coordinates for the map on screen 18; null when not set. */
    latitude: number | null;
    longitude: number | null;
  };
  connectors: ConnectorLive[];
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
  firmware_version: string | null;
  rated_power_kw: number | null;
  /** BR-P40: the charge point sends SoC. */
  reports_soc: boolean;
  supports_reservation: boolean;
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
