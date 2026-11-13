import type { PoolClient } from 'pg';
import { ChargingError } from './charging-error.js';
import {
  DEFAULT_SMART_SEARCH,
  EMPTY_SMART_FIELDS,
  SmartFields,
  SmartSearchConfig,
} from './smart-search.js';

export interface StationSearchInput {
  query?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  availability?: 'all' | 'available' | 'in_use' | 'freeing_soon' | 'unavailable' | 'offline';
  sort?: 'name' | 'distance' | 'smart';
  socPercent?: number;
  targetSocPercent?: number;
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
  rated_power_kw: string | null;
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
export interface SearchStation extends SmartFields {
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
  estimate: { soc_percent: number; est_range_km: number; assumptions: SmartSearchConfig } | null;
  smart_unavailable_reason?: 'no_soc' | 'no_location' | 'missing_vehicle_specs';
  items: SearchStation[];
  total: number;
  page: number;
  pageSize: number;
}

export async function searchStations(
  c: PoolClient,
  driverId: number | string,
  vehicleId: number | string,
  input: StationSearchInput,
  staleAfterMs: number,
  offlineAfterMs: number,
  settings: SmartSearchConfig = DEFAULT_SMART_SEARCH,
): Promise<StationSearchResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ChargingError('invalid_search');
  const {
    query = '',
    latitude,
    longitude,
    radiusKm,
    availability = 'all',
    sort = input.socPercent !== undefined && latitude !== undefined
      ? 'smart'
      : latitude === undefined
        ? 'name'
        : 'distance',
    page = 1,
    pageSize = 20,
    includeVinfastOnly = false,
    socPercent,
    targetSocPercent = 80,
  } = input;
  const located = latitude !== undefined || longitude !== undefined;
  if (
    typeof query !== 'string' ||
    query.length > 120 ||
    /[\x00-\x1f\x7f]/.test(query) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !['all', 'available', 'in_use', 'freeing_soon', 'unavailable', 'offline'].includes(
      availability,
    ) ||
    !['name', 'distance', 'smart'].includes(sort) ||
    typeof includeVinfastOnly !== 'boolean' ||
    !Number.isFinite(targetSocPercent) ||
    targetSocPercent <= 0 ||
    targetSocPercent > 80 ||
    (socPercent !== undefined &&
      (!Number.isFinite(socPercent) || socPercent < 0 || socPercent >= targetSocPercent)) ||
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
      `SELECT m.connector_type,m.is_vinfast,m.battery_capacity_kwh::float8,m.rated_range_km,m.max_dc_kw::float8 FROM vehicles v
    JOIN vehicle_models m ON m.id=v.vehicle_model_id WHERE v.id=$1 AND v.driver_id=$2 AND v.removed_at IS NULL`,
      [vehicleId, driverId],
    )
  ).rows[0];
  if (!vehicle) throw new ChargingError('not_found');
  const reason =
    socPercent === undefined
      ? 'no_soc'
      : !located
        ? 'no_location'
        : !(
              Number.isFinite(vehicle.battery_capacity_kwh) &&
              vehicle.battery_capacity_kwh > 0 &&
              Number.isFinite(vehicle.rated_range_km) &&
              vehicle.rated_range_km > 0
            )
          ? 'missing_vehicle_specs'
          : undefined;
  const estimate = reason
    ? null
    : {
        soc_percent: socPercent!,
        est_range_km: ((vehicle.rated_range_km * socPercent!) / 100) * settings.range_factor,
        assumptions: { ...settings },
      };
  const smart = sort === 'smart' && estimate !== null;
  const effectiveSort = sort === 'smart' ? (located ? 'distance' : 'name') : sort;
  const implicitRadius = smart && radiusKm === undefined;
  const radius =
    radiusKm ?? (implicitRadius ? estimate!.est_range_km * settings.radius_factor : null);
  // Smart reads every matching candidate before ranking and slicing the requested page.
  const row = (
    await c.query<{ items: (SearchStation & { max_tariff_vnd: string | null })[]; total: number }>(
      `
    WITH base AS (
      SELECT st.id AS site_id,st.site_code,st.site_name,st.address,st.latitude,st.longitude,st.vinfast_only,
        o.id AS operator_id,o.legal_name AS operator_name,c.id AS connector_id,c.connector_no,c.connector_type,
        c.max_power_kw,cp.rated_power_kw,c.status,c.status_changed_at AS status_updated_at,cp.id AS charge_point_id,
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
        -- WF-04/AD-7: an open FaultEvent hides its connector; a whole-charge-point one (connector_id
        -- NULL, e.g. Offline) hides all of them. Driver-report events hide too (STM-6 Fig 14, AD-7).
        AND NOT EXISTS(SELECT 1 FROM fault_events f WHERE f.charge_point_id=cp.id
          AND (f.connector_id=c.id OR f.connector_id IS NULL)
          AND f.status<>'resolved')
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
          'max_power_kw',max_power_kw::text,'rated_power_kw',rated_power_kw::text,'status',status,'driver_status',driver_status,
          'status_quality',status_quality,'status_updated_at',status_updated_at,'last_message_at',last_message_at,
          'is_online',is_online,'online_changed_at',online_changed_at,'lifecycle',lifecycle,
          'available_now',available_now) ORDER BY charge_point_id,connector_no) AS connectors
      FROM classified GROUP BY site_id,site_code,site_name,address,latitude,longitude,vinfast_only,operator_id,operator_name
      HAVING bool_or(strpos(powerme_search_text(concat_ws(' ',site_code,site_name,address,display_code)),$3)>0)
        AND ($6='all' OR bool_or(driver_status=$6))
    ), matched AS (
      SELECT * FROM grouped WHERE $7::double precision IS NULL OR distance_m<=$7*1000
    ), selected AS (
      SELECT * FROM matched
      UNION ALL
      (SELECT * FROM grouped WHERE $13::boolean AND NOT EXISTS(SELECT 1 FROM matched)
        AND distance_m IS NOT NULL ORDER BY
          EXISTS(SELECT 1 FROM jsonb_array_elements(connectors) c
            WHERE c->>'driver_status' IN ('available','freeing_soon','in_use')
            AND coalesce((c->>'max_power_kw')::numeric,(c->>'rated_power_kw')::numeric)>0) DESC,
          distance_m,site_id LIMIT $14)
    ), page AS (
      SELECT * FROM selected ORDER BY
        CASE WHEN $10='distance' THEN distance_m END ASC NULLS LAST,
        powerme_search_text(site_name) COLLATE "C",site_id LIMIT $11 OFFSET $12
    )
    SELECT (SELECT count(*)::integer FROM selected) AS total,
      coalesce((SELECT jsonb_agg(jsonb_build_object('site_id',site_id::text,'site_code',site_code,
        'site_name',site_name,'address',address,'operator_id',operator_id::text,'operator_name',operator_name,
        'vinfast_only',vinfast_only,'latitude',latitude::text,'longitude',longitude::text,
        'distance_m',distance_m,'connectors',connectors,
        'max_tariff_vnd',(SELECT max(t.price_per_kwh_vnd)::text FROM tariff_periods t
          WHERE t.operator_id=page.operator_id AND t.effective_from<=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (t.effective_to IS NULL OR t.effective_to>=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date))) ORDER BY
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
        radius,
        staleAfterMs,
        offlineAfterMs,
        effectiveSort,
        smart ? null : pageSize,
        smart ? 0 : (page - 1) * pageSize,
        implicitRadius,
        settings.fallback_limit,
      ],
    )
  ).rows[0]!;
  let items = row.items.map(({ max_tariff_vnd, ...station }) => {
    const fields = { ...EMPTY_SMART_FIELDS };
    if (!estimate || station.distance_m === null) return { ...station, ...fields };
    const roadKm = (station.distance_m / 1000) * settings.road_factor;
    fields.reach =
      roadKm <= estimate.est_range_km - settings.reserve_km
        ? 'ok'
        : roadKm <= estimate.est_range_km
          ? 'tight'
          : 'risky';
    const options = station.connectors.flatMap((connector) => {
      const wait =
        connector.driver_status === 'available'
          ? settings.available_wait_min
          : connector.driver_status === 'freeing_soon'
            ? settings.freeing_soon_wait_min
            : connector.driver_status === 'in_use'
              ? settings.in_use_wait_min
              : null;
      if (wait === null) return [];
      const power = Math.min(
        Number(connector.max_power_kw ?? connector.rated_power_kw),
        vehicle.max_dc_kw ?? Infinity,
      );
      const energy = (vehicle.battery_capacity_kwh * (targetSocPercent - socPercent!)) / 100;
      const drive = (roadKm / settings.avg_speed_kmh) * 60;
      const charge =
        power > 0 && Number.isFinite(power)
          ? (energy / (power * settings.charge_efficiency)) * 60
          : null;
      return [
        {
          best_connector_id: connector.connector_id,
          est_drive_min: drive,
          est_wait_min: wait,
          est_charge_min: charge,
          est_total_min: charge === null ? null : drive + wait + charge,
          est_energy_kwh: energy,
          est_cost_vnd_max:
            max_tariff_vnd === null ||
            !Number.isSafeInteger(Number(max_tariff_vnd)) ||
            !Number.isSafeInteger(Math.ceil(energy * Number(max_tariff_vnd)))
              ? null
              : Math.ceil(energy * Number(max_tariff_vnd)),
        },
      ];
    });
    options.sort(
      (a, b) =>
        compareNullable(a.est_total_min, b.est_total_min) ||
        compareIds(a.best_connector_id, b.best_connector_id),
    );
    return { ...station, ...fields, ...options[0] };
  });
  if (smart) {
    const reachOrder = { ok: 0, tight: 1, risky: 2 };
    items.sort(
      (a, b) =>
        Number(a.est_total_min === null) - Number(b.est_total_min === null) ||
        (a.reach === null ? 3 : reachOrder[a.reach]) -
          (b.reach === null ? 3 : reachOrder[b.reach]) ||
        compareNullable(a.est_total_min, b.est_total_min) ||
        compareNullable(a.distance_m, b.distance_m) ||
        compareIds(a.site_id, b.site_id),
    );
    items = items.slice((page - 1) * pageSize, page * pageSize);
  }
  return {
    items,
    total: row.total,
    page,
    pageSize,
    estimate,
    ...(reason ? { smart_unavailable_reason: reason } : {}),
  };
}

function compareNullable(a: number | null, b: number | null): number {
  return a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;
}
function compareIds(a: string, b: string): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
