/**
 * Admin platform overview (FE-14, screen 27) — types only, snake_case as on the wire.
 * Source: apps/csms/src/operator-api/admin-platform.ts.
 */
import type { ChargePointLifecycle } from './monitoring.js';

/** GET /api/admin/v1/summary */
export interface AdminSummary {
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
