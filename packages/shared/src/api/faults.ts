/**
 * Operator fault API (FE-04a, WF-04, screen 21) — types only, snake_case as on the wire.
 * Source: apps/csms/src/operator-api/operator-faults.ts.
 */

/** How the FaultEvent was raised (D39): OCPP Faulted, charge point Offline > 900 s, driver report. */
export type FaultKind = 'faulted' | 'offline' | 'driver_report';
export type FaultStatus = 'raised' | 'acknowledged' | 'resetting' | 'resolved';
export type FaultSeverity = 'critical' | 'major' | 'minor' | 'none';
/** STM-6 transitions an Operator can trigger: t2, t4, t7. */
export type FaultAction = 'acknowledge' | 'reset' | 'close';
export type ResetType = 'Soft' | 'Hard';

export interface OperatorFault {
  id: string;
  event_no: number;
  kind: FaultKind;
  charge_point_serial: string;
  /** Charging Station name; null when the charge point has no site yet. */
  station_name: string | null;
  /** 0 = whole charge point; null = unknown connector. */
  connector_no: number | null;
  error_code: string | null;
  severity: FaultSeverity;
  hint: string;
  status: FaultStatus;
  raised_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  /** The last Reset command; `deadline` only while `resetting`. */
  reset: { command_id: string; status: string; deadline: string | null } | null;
  charge_point_online: boolean;
  /** Server-computed from STM-6 (D38); the dashboard keeps no copy of the state machine. */
  allowed_actions: FaultAction[];
}

/** GET /api/operator/v1/faults?status=open|all[&limit=1..200] */
export interface OperatorFaultList {
  faults: OperatorFault[];
}

/** POST /api/operator/v1/faults/{id}/acknowledge | close */
export interface FaultActionResponse {
  id: string;
  status: FaultStatus;
}

/** POST /api/operator/v1/faults/{id}/reset */
export interface ResetRequest {
  type: ResetType;
  /** Resend after 409 `sessions_active` to cut those sessions (D40). */
  force?: boolean;
}

export interface ResetResponse {
  fault_id: string;
  command_id: string;
  reset_status: 'Accepted' | 'Rejected';
  fault_status: FaultStatus | null;
  forced: boolean;
}

/** Extra fields of the 409 `sessions_active` error body. */
export interface SessionsActiveError {
  sessions: { connector_no: number; session_id: string }[];
}
