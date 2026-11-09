import type { Db } from '../../src/db/db.module.js';
export interface RoadSite {
  id: string;
  connector: string;
  cp: string;
  operator: string;
}

export async function addRoadSite(db: Db, index: number, status = 'Available'): Promise<RoadSite> {
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;
  const operator = (
    await q('INSERT INTO operators(tax_code,legal_name) VALUES($1,$2) RETURNING id', [
      `ROAD${index}`,
      `Synthetic Operator ${index}`,
    ])
  )[0]!.id as string;
  const id = (
    await q(
      'INSERT INTO sites(operator_id,site_code,site_name,latitude,longitude) VALUES($1,$2,$3,10.889,$4) RETURNING id',
      [operator, `ROAD${index}`, `Synthetic Road ${index}`, 106.801 + index * 0.001],
    )
  )[0]!.id as string;
  const cp = (
    await q(
      "INSERT INTO charge_points(serial_number,display_code,site_id,rated_power_kw,lifecycle,is_online,last_message_at,online_changed_at,current_epoch) VALUES($1,$1,$2,120,'in_service',true,now(),now()-interval '1 minute',1) RETURNING id",
      [`ROAD${index}`, id],
    )
  )[0]!.id as string;
  const connector = (
    await q(
      'INSERT INTO connectors(charge_point_id,connector_no,max_power_kw,status,status_changed_at) VALUES($1,1,$2,$3,now()) RETURNING id',
      [cp, index === 1 ? 120 : 60, status],
    )
  )[0]!.id as string;
  await q(
    "INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from) VALUES($1,'normal','00:00','24:00',$2,'2000-01-01')",
    [operator, [5000, 6000, 1000][index] ?? 2000],
  );
  return { id, connector, cp, operator };
}

export async function seedRoadFixture(db: Db) {
  const q = async (sql: string, args: unknown[] = []) => (await db.$client.query(sql, args)).rows;
  const driver = (
    await q(
      "INSERT INTO users(email,full_name,role) VALUES('road@example.invalid','Synthetic Road Driver','driver') RETURNING id",
    )
  )[0]!.id as string;
  const other = (
    await q(
      "INSERT INTO users(email,full_name,role) VALUES('road-other@example.invalid','Other','driver') RETURNING id",
    )
  )[0]!.id as string;
  for (const id of [driver, other])
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'synthetic-test',now())",
      [id],
    );
  const model = (
    await q(
      "INSERT INTO vehicle_models(brand,model_name,battery_capacity_kwh,rated_range_km,max_dc_kw) VALUES('Synthetic','Road',60,400,100) RETURNING id",
    )
  )[0]!.id;
  const vehicle = (
    await q(
      "INSERT INTO vehicles(id,driver_id,vehicle_model_id,plate_number) OVERRIDING SYSTEM VALUE VALUES(9007199254740994,$1,$2,'ROAD') RETURNING id",
      [driver, model],
    )
  )[0]!.id as string;
  const otherVehicle = (
    await q(
      "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number) VALUES($1,$2,'ROAD-OTHER') RETURNING id",
      [other, model],
    )
  )[0]!.id as string;
  const sites: RoadSite[] = [];
  for (let i = 0; i < 3; i++) {
    sites.push(await addRoadSite(db, i));
  }
  return { driver, other, vehicle, otherVehicle, model: String(model), sites };
}
