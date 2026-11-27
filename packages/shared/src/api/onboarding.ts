/**
 * Charge Point Onboarding (UC-OPS-01, screen 19, FE-02) — types only, snake_case as on the wire.
 * Sources: apps/csms/src/operator-api/operator-sites.ts (GET /operator/v1/sites) and
 * charge-point-onboarding.ts (POST /operator/v1/charge-points/onboard, BE-44).
 */

/** One Charging Station of the caller's Operator (OpenAPI `Site`). */
export interface Site {
  id: string;
  site_code: string;
  site_name: string;
  address: string | null;
  vinfast_only: boolean;
  latitude: number | null;
  longitude: number | null;
}

/** GET /api/operator/v1/sites (OpenAPI `SitePage`). */
export interface SitePage {
  items: Site[];
  total: number;
  page: number;
  page_size: number;
}

export type ConnectorType = 'ccs2' | 'chademo' | 'gbt' | 'type2';

export interface OnboardConnector {
  /** 1 or 2 (BR-P10), no duplicates. */
  connector_no: 1 | 2;
  connector_type?: ConnectorType;
  max_power_kw?: number | null;
}

/** POST /api/operator/v1/charge-points/onboard — `site_id` is a number: the parser rejects a string. */
export interface OnboardRequest {
  serial_number: string;
  site_id: number;
  connectors: OnboardConnector[];
}

/** 201 — the password is shown once and never again (BR-P49). */
export interface OnboardResult {
  charge_point_id: string;
  display_code: string;
  lifecycle: 'awaiting_connection';
  ocpp_url: string;
  identity: string;
  password: string;
}
