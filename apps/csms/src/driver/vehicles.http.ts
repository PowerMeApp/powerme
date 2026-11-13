/**
 * BE-34 — quản lý xe của tài xế (F-01 "manage profile, vehicles"; UC-ACC-03; màn hình 13
 * "Profile & Vehicles"). Bốn route, đều sau `authenticateDriver`:
 *
 * - `GET    /vehicle-models`          danh mục mẫu xe để app cho chọn khi thêm xe.
 * - `POST   /vehicles`                thêm xe `{plate_number, vehicle_model_id, is_default?}` → 201.
 * - `PATCH  /vehicles/{vehicle_id}`   chỉ `{is_default: true}` — đổi xe mặc định → 200.
 * - `DELETE /vehicles/{vehicle_id}`   gỡ xe (xoá MỀM, migration 0018) → 204.
 *
 * Phần tử trả về cùng hình dạng phần tử `vehicles[]` của `GET /me` (cùng `VEHICLE_JSON`).
 *
 * Biển số (`normalizePlate`): NFKC, in hoa, bỏ MỌI khoảng trắng; giữ `-` và `.` người dùng gõ để
 * hiển thị (vd `51K-901.01`), nhưng so trùng theo KHOÁ chỉ gồm chữ + số (`51K90101`) — index
 * `vehicles_plate_key_active` trên DB dùng đúng biểu thức đó, nên `51k 901.01`, `51K-90101` và
 * `51K90101` là MỘT biển. Biển trùng với xe đang dùng của bất kỳ ai → 409 `plate_taken` (không nói
 * xe của ai). Xe đã gỡ không giữ biển: đăng ký lại được.
 *
 * Gỡ xe không xoá dòng: `sessions.vehicle_id` và `driver_charge_intents.vehicle_id` trỏ tới xe
 * (BR-P17, lịch sử phiên), nên chỉ đặt `removed_at`. Xe đã gỡ biến khỏi `/me` và không dùng được ở
 * `/stations`, `/connectors/by-code`, `/places/*`, `/stations/{id}/route`, `POST /charges` (404 /
 * 400 như xe không thuộc tài xế). Xe đang có yêu cầu sạc chưa xong hoặc phiên chưa kết thúc → 409
 * `vehicle_in_use`. Gỡ xe mặc định → xe còn lại tạo sớm nhất (id nhỏ nhất) thành mặc định.
 *
 * Mọi thay đổi xe của MỘT tài xế xếp hàng bằng khoá dòng `drivers` (FOR UPDATE), nên hai lần thêm
 * xe đầu tiên song song không tạo hai xe mặc định và gỡ / đổi mặc định không giẫm nhau. Đua với
 * `POST /charges`: service khoá dòng xe FOR SHARE khi kiểm xe, route gỡ khoá FOR UPDATE rồi mới
 * đếm yêu cầu sạc — bên nào sau cũng thấy kết quả của bên trước.
 *
 * Không có Idempotency-Key: biển số là khoá tự nhiên, gửi lại sau khi mất phản hồi nhận 409
 * `plate_taken` và không tạo xe thứ hai; app tải lại `/me` để thấy xe đã thêm.
 */
import type { IncomingMessage } from 'node:http';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';
import { chargeTransaction } from '../sessions/charge-sql.js';
import { databaseId, DriverApiError } from './driver-auth.js';

const BASE = '/api/driver/v1';
/** Cột `vehicles.plate_number` là varchar(12). */
const PLATE_MAX = 12;
/** Biển VN ngắn nhất có ý nghĩa (vd `51K1234` = 7); 5 để không đoán thay từng loại biển đặc biệt. */
const PLATE_KEY_MIN = 5;
/** Chuỗi gốc dài hơn mức này chắc chắn không ra biển ≤ 12 ký tự đáng tin — từ chối sớm. */
const PLATE_RAW_MAX = 64;
const ADD_FIELDS = ['plate_number', 'vehicle_model_id', 'is_default'];

/** Biểu thức khoá so trùng — PHẢI giống hệt index `vehicles_plate_key_active` (migration 0018). */
export const PLATE_KEY_SQL = `upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))`;

/** Phần tử `vehicles[]` của `/me` và kết quả POST/PATCH; `v` = vehicles, `m` = vehicle_models. */
export const VEHICLE_JSON = `jsonb_build_object('vehicle_id',v.id::text,'plate_number',v.plate_number,
  'is_default',v.is_default,'vehicle_model_id',m.id::text,'brand',m.brand,'model_name',m.model_name,
  'connector_type',m.connector_type,'is_vinfast',m.is_vinfast,
  'battery_capacity_kwh',m.battery_capacity_kwh::float8,'rated_range_km',m.rated_range_km,
  'max_dc_kw',m.max_dc_kw::float8)`;

export interface NormalizedPlate {
  /** Dạng lưu và hiển thị: in hoa, không khoảng trắng, giữ `-` `.`. */
  plate: string;
  /** Dạng so trùng: chỉ A–Z 0–9. */
  key: string;
}

/** `null` nếu không phải biển số chấp nhận được (route trả 400 `invalid_plate_number`). */
export function normalizePlate(raw: unknown): NormalizedPlate | null {
  if (typeof raw !== 'string' || raw.length > PLATE_RAW_MAX) return null;
  const plate = raw.normalize('NFKC').toUpperCase().replace(/\s+/gu, '');
  if (plate.length > PLATE_MAX || !/^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(plate)) return null;
  const key = plate.replace(/[^A-Z0-9]/g, '');
  if (key.length < PLATE_KEY_MIN) return null;
  return { plate, key };
}

type Route = { name: 'models' } | { name: 'add' } | { name: 'one'; vehicleId: string };

const ALLOW: Record<Route['name'], string> = {
  models: 'GET, OPTIONS',
  add: 'POST, OPTIONS',
  one: 'PATCH, DELETE, OPTIONS',
};

export function isVehiclePath(path: string): boolean {
  return (
    path === `${BASE}/vehicle-models` ||
    path === `${BASE}/vehicles` ||
    path.startsWith(`${BASE}/vehicles/`)
  );
}

/** Method cho preflight CORS; null nếu đường dẫn không khớp route nào. */
export function vehicleRouteAllow(path: string): string | null {
  try {
    return ALLOW[matchRoute(path).name];
  } catch {
    return null;
  }
}

function matchRoute(path: string): Route {
  if (path === `${BASE}/vehicle-models`) return { name: 'models' };
  if (path === `${BASE}/vehicles`) return { name: 'add' };
  const one = new RegExp(`^${BASE}/vehicles/([^/]+)$`).exec(path);
  if (one) return { name: 'one', vehicleId: databaseId(one[1]) };
  throw new DriverApiError(404, 'not_found');
}

export interface VehicleRouteContext {
  req: IncomingMessage;
  path: string;
  q: URLSearchParams;
  driverId: string;
  db: Db;
  readBody: () => Promise<Record<string, unknown>>;
  drainBody: () => Promise<void>;
  setAllow: (methods: string) => void;
}

export async function handleVehicleRoute(
  ctx: VehicleRouteContext,
): Promise<{ status: number; body: unknown }> {
  const route = matchRoute(ctx.path);
  // OPTIONS (preflight) đã được driver.http.ts trả trước khi xác thực.
  if (!ALLOW[route.name].split(', ').includes(ctx.req.method ?? '')) {
    ctx.setAllow(ALLOW[route.name]);
    throw new DriverApiError(405, 'method_not_allowed');
  }
  if ([...ctx.q.keys()].length) throw new DriverApiError(400, 'invalid_input');
  switch (route.name) {
    case 'models':
      return { status: 200, body: { items: await listModels(ctx.db) } };
    case 'add':
      return { status: 201, body: await addVehicle(ctx.db, ctx.driverId, await ctx.readBody()) };
    case 'one':
      if (ctx.req.method === 'PATCH') {
        const body = await ctx.readBody();
        if (Object.keys(body).length !== 1 || body['is_default'] !== true)
          throw new DriverApiError(400, 'invalid_input');
        return { status: 200, body: await makeDefault(ctx.db, ctx.driverId, route.vehicleId) };
      }
      await ctx.drainBody();
      await removeVehicle(ctx.db, ctx.driverId, route.vehicleId);
      return { status: 204, body: null };
  }
}

async function listModels(db: Db) {
  return (
    await db.$client.query(
      `SELECT id::text AS vehicle_model_id,brand,model_name,connector_type,is_vinfast,
         battery_capacity_kwh::float8 AS battery_capacity_kwh,rated_range_km,max_dc_kw::float8 AS max_dc_kw
       FROM vehicle_models ORDER BY brand,model_name,id`,
    )
  ).rows;
}

/** Khoá dòng `drivers`: mọi thay đổi xe của một tài xế chạy lần lượt. */
async function lockDriver(c: PoolClient, driverId: string) {
  await c.query('SELECT 1 FROM drivers WHERE user_id=$1 FOR UPDATE', [driverId]);
}

async function readVehicle(c: PoolClient, vehicleId: string) {
  return (
    await c.query(
      `SELECT ${VEHICLE_JSON} AS vehicle FROM vehicles v
       JOIN vehicle_models m ON m.id=v.vehicle_model_id WHERE v.id=$1`,
      [vehicleId],
    )
  ).rows[0]!.vehicle;
}

async function addVehicle(db: Db, driverId: string, body: Record<string, unknown>) {
  for (const key of Object.keys(body))
    if (!ADD_FIELDS.includes(key)) throw new DriverApiError(400, 'invalid_input');
  const wantDefault = body['is_default'];
  if (wantDefault !== undefined && typeof wantDefault !== 'boolean')
    throw new DriverApiError(400, 'invalid_input');
  const modelId = databaseId(body['vehicle_model_id']);
  const plate = normalizePlate(body['plate_number']);
  if (!plate) throw new DriverApiError(400, 'invalid_plate_number');
  try {
    return await chargeTransaction(db, async (c) => {
      await lockDriver(c, driverId);
      if (!(await c.query('SELECT 1 FROM vehicle_models WHERE id=$1', [modelId])).rowCount)
        throw new DriverApiError(400, 'unknown_vehicle_model');
      if (
        (
          await c.query(
            `SELECT 1 FROM vehicles WHERE ${PLATE_KEY_SQL}=$1 AND removed_at IS NULL LIMIT 1`,
            [plate.key],
          )
        ).rowCount
      )
        throw new DriverApiError(409, 'plate_taken');
      // Chưa có xe mặc định (xe đầu tiên) → xe mới là mặc định dù app gửi gì.
      const hasDefault = (
        await c.query(
          'SELECT 1 FROM vehicles WHERE driver_id=$1 AND is_default AND removed_at IS NULL',
          [driverId],
        )
      ).rowCount;
      const isDefault = !hasDefault || wantDefault === true;
      if (isDefault && hasDefault)
        await c.query(
          `UPDATE vehicles SET is_default=false,updated_at=now() WHERE driver_id=$1 AND is_default`,
          [driverId],
        );
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO vehicles(plate_number,driver_id,vehicle_model_id,is_default)
           VALUES($1,$2,$3,$4) RETURNING id::text AS id`,
          [plate.plate, driverId, modelId, isDefault],
        )
      ).rows[0]!.id;
      return readVehicle(c, id);
    });
  } catch (error) {
    // Tài xế khác thêm cùng biển ở cùng lúc: bên sau vấp index của 0018.
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'vehicles_plate_key_active')
      throw new DriverApiError(409, 'plate_taken');
    throw error;
  }
}

/** Xe đang dùng của chính tài xế, khoá FOR UPDATE; không có / của người khác / đã gỡ → 404. */
async function ownedVehicle(c: PoolClient, driverId: string, vehicleId: string) {
  const row = (
    await c.query<{ is_default: boolean }>(
      'SELECT is_default FROM vehicles WHERE id=$1 AND driver_id=$2 AND removed_at IS NULL FOR UPDATE',
      [vehicleId, driverId],
    )
  ).rows[0];
  if (!row) throw new DriverApiError(404, 'not_found');
  return row;
}

async function makeDefault(db: Db, driverId: string, vehicleId: string) {
  return chargeTransaction(db, async (c) => {
    await lockDriver(c, driverId);
    const vehicle = await ownedVehicle(c, driverId, vehicleId);
    if (!vehicle.is_default) {
      await c.query(
        `UPDATE vehicles SET is_default=false,updated_at=now() WHERE driver_id=$1 AND is_default`,
        [driverId],
      );
      await c.query(`UPDATE vehicles SET is_default=true,updated_at=now() WHERE id=$1`, [
        vehicleId,
      ]);
    }
    return readVehicle(c, vehicleId);
  });
}

async function removeVehicle(db: Db, driverId: string, vehicleId: string) {
  await chargeTransaction(db, async (c) => {
    await lockDriver(c, driverId);
    const vehicle = await ownedVehicle(c, driverId, vehicleId);
    // "Đang dùng": yêu cầu sạc còn giữ tiền / chờ quyết toán (cùng định nghĩa `held` của
    // DriverChargingService.start) hoặc phiên chưa kết thúc.
    const inUse = (
      await c.query(
        `SELECT 1 FROM driver_charge_intents WHERE vehicle_id=$1
           AND state NOT IN ('rejected','settled','released')
         UNION ALL SELECT 1 FROM sessions WHERE vehicle_id=$1
           AND status IN ('pending','active','paused','stopping','orphaned')
         LIMIT 1`,
        [vehicleId],
      )
    ).rowCount;
    if (inUse) throw new DriverApiError(409, 'vehicle_in_use');
    await c.query(
      `UPDATE vehicles SET removed_at=now(),is_default=false,updated_at=now() WHERE id=$1`,
      [vehicleId],
    );
    if (vehicle.is_default)
      await c.query(
        `UPDATE vehicles SET is_default=true,updated_at=now() WHERE id=(
           SELECT id FROM vehicles WHERE driver_id=$1 AND removed_at IS NULL ORDER BY id LIMIT 1)`,
        [driverId],
      );
  });
}
