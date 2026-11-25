import type { Db } from '../db/db.module.js';
import { DriverApiError } from './driver-auth.js';
import { SESSION_CAPABILITIES_SQL } from '../sessions/session-capabilities.js';

export function parseSessionListQuery(q: URLSearchParams) {
  for (const key of q.keys())
    if (!['view', 'page', 'page_size'].includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
  const view = q.get('view') ?? 'all';
  if (view !== 'all' && view !== 'active') throw new DriverApiError(400, 'invalid_input');
  const page = (name: string, fallback: number, max: number) => {
    const value = q.get(name);
    if (value === null) return fallback;
    if (
      value.length === 0 ||
      value.length > 6 ||
      value[0] === '0' ||
      /[^0-9]/.test(value) ||
      Number(value) > max
    )
      throw new DriverApiError(400, 'invalid_input');
    return Number(value);
  };
  return { view, page: page('page', 1, 100000), pageSize: page('page_size', 20, 100) };
}

export function sessionInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('session_integer_out_of_range');
  return result;
}

interface SessionRow {
  total: string;
  session_id: string | null;
  status: string;
  origin: string;
  payment_mode: string;
  can_stop: boolean;
  statement_available: boolean;
  started_at: Date;
  stopped_at: Date | null;
  updated_at: Date;
  energy_wh: string | null;
  amount_vnd: string | null;
  settlement_state: string | null;
  connector_id: string;
  connector_no: number;
  charge_point_display_code: string | null;
  site_id: string | null;
  site_name: string | null;
  vehicle_id: string | null;
  vehicle_label: string | null;
}

export async function driverSessions(db: Db, driverId: string, q: URLSearchParams) {
  const { view, page, pageSize } = parseSessionListQuery(q);
  // One statement gives page rows and total the same MVCC snapshot, even beyond the last page.
  const { rows } = await db.$client.query<SessionRow>(
    `WITH owned AS (
      SELECT s.id AS session_id,s.status,s.origin,s.payment_mode,${SESSION_CAPABILITIES_SQL},
        s.received_started_at AS started_at,s.received_stopped_at AS stopped_at,s.updated_at,
        s.energy_wh,st.amount_vnd,j.state AS settlement_state,s.connector_id,s.connector_no,
        cp.display_code AS charge_point_display_code,site.id AS site_id,site.site_name,
        v.id AS vehicle_id,v.plate_number AS vehicle_label
      FROM sessions s JOIN charge_points cp ON cp.id=s.charge_point_id
      LEFT JOIN sites site ON site.id=cp.site_id
      LEFT JOIN vehicles v ON v.id=s.vehicle_id AND v.driver_id=s.driver_id
      LEFT JOIN charge_settlement_jobs j ON j.session_id=s.id
      LEFT JOIN charging_statements st ON st.session_id=s.id AND st.driver_id=s.driver_id
        AND s.payment_mode='csms_billed'
      WHERE s.driver_id=$1 AND ($2::text='all' OR (s.meter_stop_wh IS NULL
        AND s.status IN ('pending','active','paused','stopping','orphaned','review')))
    )
    SELECT totals.total,p.* FROM (SELECT count(*)::text AS total FROM owned) totals
    LEFT JOIN LATERAL (SELECT * FROM owned ORDER BY started_at DESC,session_id DESC
      LIMIT $3 OFFSET $4) p ON true
    ORDER BY p.started_at DESC,p.session_id DESC`,
    [driverId, view, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows
      .filter((row) => row.session_id !== null)
      .map(({ total: _total, ...row }) => ({
        ...row,
        energy_wh: sessionInteger(row.energy_wh),
        amount_vnd: sessionInteger(row.amount_vnd),
      })),
    total: sessionInteger(rows[0]!.total)!,
    page,
    page_size: pageSize,
  };
}
