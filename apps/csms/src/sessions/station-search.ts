import type { PoolClient } from 'pg';
import { ChargingError } from './charging-error.js';

export interface StationSearchInput {
  query?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  availability?: 'all' | 'available' | 'in_use' | 'freeing_soon' | 'unavailable' | 'offline';
  sort?: 'name' | 'distance';
  page?: number;
  pageSize?: number;
  includeVinfastOnly?: boolean;
}
export type DriverConnectorStatus =
  'available' | 'in_use' | 'freeing_soon' | 'unavailable' | 'offline' | 'unknown';
export interface SearchConnector {
  connector_id: string;
  connector_no: number;
  charge_point_id: string;
  display_code: string | null;
  connector_type: string;
  max_power_kw: string | null;
  status: string;
  driver_status: DriverConnectorStatus;
  status_quality: 'fresh' | 'stale' | 'unknown';
  status_updated_at: string | null;
  last_message_at: string | null;
  is_online: boolean;
  online_changed_at: string | null;
  lifecycle: string;
  available_now: boolean;
}
export interface SearchStation {
  site_id: string;
  site_code: string;
  site_name: string;
  address: string | null;
  operator_id: string;
  operator_name: string;
  vinfast_only: boolean;
  latitude: string | null;
  longitude: string | null;
  distance_m: number | null;
  connectors: SearchConnector[];
}
export interface StationSearchResult {
  items: SearchStation[];
  total: number;
  page: number;
  pageSize: number;
}

export async function searchStations(
  c: PoolClient,
  driverId: number,
  vehicleId: number,
  input: StationSearchInput,
  staleAfterMs: number,
  offlineAfterMs: number,
): Promise<StationSearchResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ChargingError('invalid_search');
  const {
    query = '',
    latitude,
    longitude,
    radiusKm,
    availability = 'all',
    sort = latitude === undefined ? 'name' : 'distance',
    page = 1,
    pageSize = 20,
    includeVinfastOnly = false,
  } = input;
  const located = latitude !== undefined || longitude !== undefined;
  if (
    typeof query !== 'string' ||
    query.length > 120 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !['all', 'available', 'in_use', 'freeing_soon', 'unavailable', 'offline'].includes(
      availability,
    ) ||
    !['name', 'distance'].includes(sort) ||
    typeof includeVinfastOnly !== 'boolean' ||
    (located &&
      (typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180)) ||
    (sort === 'distance' && !located) ||
    (radiusKm !== undefined &&
      (!located || !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20040))
  )
    throw new ChargingError('invalid_search');
  const vehicle = (
    await c.query(
      `SELECT m.connector_type,m.is_vinfast FROM vehicles v
    JOIN vehicle_models m ON m.id=v.vehicle_model_id WHERE v.id=$1 AND v.driver_id=$2`,
      [vehicleId, driverId],
    )
  ).rows[0];
  if (!vehicle) throw new ChargingError('not_found');
  // WP3/T72: one SQL snapshot groups/paginates sites; connection, raw status and freshness stay separate.
  const row = (
    await c.query<{ items: SearchStation[]; total: number }>(
      `
    WITH base AS (
      SELECT st.id AS site_id,st.site_code,st.site_name,st.address,st.latitude,st.longitude,st.vinfast_only,
        o.id AS operator_id,o.legal_name AS operator_name,c.id AS connector_id,c.connector_no,c.connector_type,
        c.max_power_kw,c.status,c.status_changed_at AS status_updated_at,cp.id AS charge_point_id,
        cp.display_code,cp.is_online,cp.online_changed_at,cp.last_message_at,cp.lifecycle,
        CASE WHEN NOT cp.is_online OR cp.last_message_at IS NULL OR
          cp.last_message_at < now()-($9::bigint*interval '1 millisecond') THEN true ELSE false END AS offline,
        CASE WHEN c.status_changed_at IS NULL THEN 'unknown'
          WHEN cp.last_message_at IS NULL OR cp.last_message_at>now() OR c.status_changed_at>now()
            OR cp.last_message_at < now()-($8::bigint*interval '1 millisecond')
            OR c.status_changed_at < cp.online_changed_at THEN 'stale' ELSE 'fresh' END AS status_quality,
        EXISTS(SELECT 1 FROM driver_charge_intents i WHERE i.connector_id=c.id AND i.connector_released_at IS NULL
          AND i.state NOT IN ('rejected','settled','released')) OR
        EXISTS(SELECT 1 FROM sessions s WHERE s.connector_id=c.id AND s.received_stopped_at IS NULL
          AND s.status IN ('pending','active','paused','stopping','orphaned')) OR
        EXISTS(SELECT 1 FROM sessions s WHERE s.connector_id=c.id AND s.received_stopped_at>c.status_changed_at)
          AS occupied
      FROM sites st JOIN operators o ON o.id=st.operator_id AND o.status='active'
      JOIN charge_points cp ON cp.site_id=st.id AND cp.lifecycle='in_service'
      JOIN connectors c ON c.charge_point_id=cp.id AND c.connector_type=$1
      WHERE ($2 OR NOT st.vinfast_only)
    ), classified AS (
      SELECT *,CASE WHEN offline THEN 'offline'
        WHEN status='Available' AND (status_quality<>'fresh' OR occupied) THEN 'unknown'
        WHEN status='Available' THEN 'available'
        WHEN status IN ('Preparing','Charging','SuspendedEV','SuspendedEVSE') THEN 'in_use'
        WHEN status='Finishing' THEN 'freeing_soon' ELSE 'unavailable' END AS driver_status,
        (status='Available' AND NOT offline AND status_quality='fresh' AND NOT occupied) AS available_now
      FROM base
    ), grouped AS (
      SELECT site_id,site_code,site_name,address,latitude,longitude,vinfast_only,operator_id,operator_name,
        CASE WHEN $4::double precision IS NULL OR latitude IS NULL OR longitude IS NULL THEN NULL ELSE
          round((6371000*2*asin(sqrt(least(1.0,greatest(0.0,
            power(sin(radians(latitude::double precision-$4)/2),2)+
            cos(radians($4))*cos(radians(latitude::double precision))*
            power(sin(radians(longitude::double precision-$5)/2),2))))))::numeric)::double precision END AS distance_m,
        jsonb_agg(jsonb_build_object('connector_id',connector_id::text,'connector_no',connector_no,
          'charge_point_id',charge_point_id::text,'display_code',display_code,'connector_type',connector_type,
          'max_power_kw',max_power_kw::text,'status',status,'driver_status',driver_status,
          'status_quality',status_quality,'status_updated_at',status_updated_at,'last_message_at',last_message_at,
          'is_online',is_online,'online_changed_at',online_changed_at,'lifecycle',lifecycle,
          'available_now',available_now) ORDER BY charge_point_id,connector_no) AS connectors
      FROM classified GROUP BY site_id,site_code,site_name,address,latitude,longitude,vinfast_only,operator_id,operator_name
      HAVING bool_or(strpos(powerme_search_text(concat_ws(' ',site_code,site_name,address,display_code)),$3)>0)
        AND ($6='all' OR bool_or(driver_status=$6))
    ), matched AS (
      SELECT * FROM grouped WHERE $7::double precision IS NULL OR distance_m<=$7*1000
    ), page AS (
      SELECT * FROM matched ORDER BY
        CASE WHEN $10='distance' THEN distance_m END ASC NULLS LAST,
        powerme_search_text(site_name) COLLATE "C",site_id LIMIT $11 OFFSET $12
    )
    SELECT (SELECT count(*)::integer FROM matched) AS total,
      coalesce((SELECT jsonb_agg(jsonb_build_object('site_id',site_id::text,'site_code',site_code,
        'site_name',site_name,'address',address,'operator_id',operator_id::text,'operator_name',operator_name,
        'vinfast_only',vinfast_only,'latitude',latitude::text,'longitude',longitude::text,
        'distance_m',distance_m,'connectors',connectors) ORDER BY
          CASE WHEN $10='distance' THEN distance_m END ASC NULLS LAST,
          powerme_search_text(site_name) COLLATE "C",site_id) FROM page),'[]'::jsonb) AS items
    `,
      [
        vehicle.connector_type,
        includeVinfastOnly || vehicle.is_vinfast,
        query
          .trim()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[đĐ]/g, 'd')
          .toLowerCase(),
        latitude ?? null,
        longitude ?? null,
        availability,
        radiusKm ?? null,
        staleAfterMs,
        offlineAfterMs,
        sort,
        pageSize,
        (page - 1) * pageSize,
      ],
    )
  ).rows[0]!;
  return { ...row, page, pageSize };
}
