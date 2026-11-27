/**
 * Admin platform overview (FE-14, screen 27) — types only, snake_case as on the wire.
 * Source: apps/csms/src/operator-api/admin-platform.ts.
 */
import type { ChargePointLifecycle, OperatorChargePoint } from './monitoring.js';

/** GET /api/admin/v1/summary */
export interface AdminSummary {
  /** Platform statistics (20/11). */
  operators: { total: number; active: number };
  sites: number;
  network: {
    /** Charge points in service, by the operator API's Offline rule. */
    in_service_online: number;
    in_service_offline: number;
    /** Connectors of non-decommissioned charge points, in the driver groups (BR-P38). */
    connectors: {
      available: number;
      in_use: number;
      freeing_soon: number;
      unavailable: number;
      offline: number;
    };
    open_faults: { total: number; critical: number; major: number; minor: number; none: number };
  };
  users: { driver: number; operator_staff: number; admin: number; suspended: number };
  charge_points: {
    by_lifecycle: Partial<Record<ChargePointLifecycle, number>>;
    /** Not offline by the operator API rule (D20). */
    online: number;
  };
  rfid_cards: { active: number; blocked: number; unlinked: number };
  /** UC-ADM-08 work queues; shown with FE-09 (D36). */
  billing_exceptions: {
    late_payments: number;
    invoices_needs_review: number;
    failed_refunds: number;
  };
}

/** One Operator of the platform (GET /api/admin/v1/operators, OpenAPI `Operator`, FE-18). */
export interface PlatformOperator {
  id: string;
  tax_code: string;
  legal_name: string;
  status: 'active' | 'suspended' | 'closed';
}

export interface PlatformOperatorPage {
  items: PlatformOperator[];
  total: number;
  page: number;
  page_size: number;
}

/** Screen 31 (FE-18, UC-ADM-07): a charge point of any Operator, with its Operator and open faults. */
export interface NetworkChargePoint extends OperatorChargePoint {
  operator: { id: string; legal_name: string };
  open_faults: { total: number; top_severity: 'critical' | 'major' | 'minor' | 'none' | null };
}

/** GET /api/admin/v1/network/charge-points */
export interface NetworkChargePointPage {
  items: NetworkChargePoint[];
  total: number;
  page: number;
  page_size: number;
}

/** Screen 31 filters; omitted = all (decommissioned hidden unless chosen). */
export interface NetworkQuery {
  operator_id?: string;
  online?: boolean;
  lifecycle?: ChargePointLifecycle;
  charge_point_q?: string;
  site_q?: string;
}
