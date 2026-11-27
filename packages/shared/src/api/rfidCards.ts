/**
 * RFID card registry (UC-ADM-04, screen 30) — types only (the driver picker's `UserAccount` is in users.ts), snake_case
 * as on the wire. Sources: apps/csms/src/operator-api/admin-rfid-cards.ts (T146, contract §3.8a)
 * and admin-users.ts (T161).
 */

export type RfidCardKind = 'online' | 'free_vend';
export type RfidCardStatus = 'unlinked' | 'active' | 'blocked';

export interface RfidCard {
  id: string;
  /** The idTag as read from the card, kept exactly (1–20 characters). */
  card_identifier: string;
  card_kind: RfidCardKind;
  status: RfidCardStatus;
  driver: { id: string; email: string | null; full_name: string | null } | null;
  issued_at: string;
  updated_at: string;
}

/** GET /api/admin/v1/rfid-cards */
export interface RfidCardPage {
  items: RfidCard[];
  total: number;
  page: number;
  page_size: number;
}

/** GET /api/admin/v1/rfid-cards filters; omitted = all. `q` = card identifier prefix. */
export interface RfidCardQuery {
  status?: RfidCardStatus;
  card_kind?: RfidCardKind;
  q?: string;
}

/** POST /api/admin/v1/rfid-cards — a driver only with `online` (409 card_kind_has_no_driver). */
export interface CreateRfidCardRequest {
  card_identifier: string;
  card_kind: RfidCardKind;
  driver_id?: string | null;
}

/** PATCH /api/admin/v1/rfid-cards/{id} — at least one field; `null` unlinks. */
export interface UpdateRfidCardRequest {
  driver_id?: string | null;
  status?: 'active' | 'blocked';
}
