/**
 * Charge point registry (admin) — types only, snake_case as on the wire.
 * Source: apps/csms/src/operator-api/charge-point-onboarding.ts (GET|POST /admin/v1/charge-points).
 */
import type { ChargePointLifecycle } from './monitoring.js';

/** One registered charge point; never carries a password or hash. */
export interface RegistryChargePoint {
  id: string;
  serial_number: string;
  display_code: string | null;
  model: string | null;
  firmware_version: string | null;
  rated_power_kw: number | null;
  /** YYYY-MM-DD */
  warranty_until: string | null;
  lifecycle: ChargePointLifecycle;
  is_online: boolean;
  free_vend_tag: string | null;
  operator: { id: string; legal_name: string } | null;
  site: { id: string; site_code: string; site_name: string } | null;
  created_at: string;
}

/** GET /api/admin/v1/charge-points — newest first. */
export interface RegistryChargePointPage {
  items: RegistryChargePoint[];
  total: number;
  page: number;
  page_size: number;
}

/** POST /api/admin/v1/charge-points */
export interface RegisterDeviceRequest {
  serial_number: string;
  model?: string | null;
  rated_power_kw?: number | null;
}
