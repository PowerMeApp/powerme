import type { Db } from '../db/db.module.js';
import { DriverApiError } from './driver-auth.js';
import { ProviderCache } from './provider-cache.js';
import { Coordinate, VietmapAdapter } from './vietmap.js';

export class RoadDiscovery {
  constructor(
    private readonly db: Db,
    private readonly provider: VietmapAdapter,
    private readonly cache = new ProviderCache(),
  ) {}

  private async ownedVehicle(driver: string, vehicle: string) {
    const result = await this.db.$client.query(
      `SELECT v.id FROM vehicles v JOIN users u ON u.id=v.driver_id
       JOIN drivers d ON d.user_id=u.id WHERE v.id=$1 AND v.driver_id=$2 AND v.removed_at IS NULL
       AND u.role='driver' AND u.account_status='active'`,
      [vehicle, driver],
    );
    if (!result.rowCount) throw new DriverApiError(404, 'not_found');
  }
  async autocomplete(driver: string, vehicle: string, text: string, focus?: Coordinate) {
    await this.ownedVehicle(driver, vehicle);
    return this.cache.run(driver, JSON.stringify(['autocomplete', text, focus]), () =>
      this.provider.autocomplete(text, focus),
    );
  }
  async place(driver: string, vehicle: string, ref: string) {
    await this.ownedVehicle(driver, vehicle);
    return this.cache.run(driver, JSON.stringify(['place', ref]), () => this.provider.place(ref));
  }
  async route(
    driver: string,
    vehicle: string,
    site: string,
    from: Coordinate,
    includeVinfastOnly: boolean,
    signal?: AbortSignal,
  ) {
    await this.ownedVehicle(driver, vehicle);
    const destination = (
      await this.db.$client.query<Coordinate>(
        `SELECT st.latitude::float8,st.longitude::float8 FROM sites st
       JOIN operators o ON o.id=st.operator_id AND o.status='active'
       WHERE st.id=$1 AND EXISTS(SELECT 1 FROM charge_points cp
         JOIN connectors c ON c.charge_point_id=cp.id
         JOIN vehicles v ON v.id=$2 AND v.driver_id=$3 AND v.removed_at IS NULL
         JOIN vehicle_models m ON m.id=v.vehicle_model_id
         WHERE cp.site_id=st.id AND cp.lifecycle='in_service' AND m.connector_type=c.connector_type
         AND (NOT st.vinfast_only OR m.is_vinfast OR $4))`,
        [site, vehicle, driver, includeVinfastOnly],
      )
    ).rows[0];
    if (!destination) throw new DriverApiError(404, 'not_found');
    if (destination.latitude === null || destination.longitude === null)
      throw new DriverApiError(503, 'station_location_unavailable');
    const result = await this.cache.run(
      driver,
      JSON.stringify(['road', site, from, destination]),
      () => this.provider.roadRoute(from, destination),
      signal,
    );
    return {
      site_id: site,
      ...result.value,
      computed_at: result.computed_at,
      cached: result.cached,
      quality: 'provider_estimate',
    };
  }
}
