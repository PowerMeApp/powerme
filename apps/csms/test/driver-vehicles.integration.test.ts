/**
 * BE-34 — quản lý xe của tài xế qua HTTP thật + Postgres riêng: `GET /vehicle-models`,
 * `POST /vehicles`, `PATCH /vehicles/{id}`, `DELETE /vehicles/{id}` (xoá mềm, migration 0018).
 * Chạy bằng `npm run test:driver-discovery -w @powerme/csms` (runner tạo DB mới cho mỗi suite).
 *
 * Vì sao tồn tại: hỏng âm thầm ở đây là mất lịch sử phiên khi gỡ xe, xe đã gỡ vẫn chọn được để
 * tìm trạm / sạc, hai xe mặc định, biển trùng lọt qua vì khác hoa/thường/dấu, hoặc lộ xe của người
 * khác. Phiên / yêu cầu sạc "đang dùng xe" được chèn thẳng bằng SQL (đúng các cột service ghi) —
 * luồng OCPP thật đã có ở driver-charges.integration.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import { loadConfig, type CsmsConfig } from '../src/config.js';
import { ConsoleCommands } from '../src/console/console.commands.js';
import { ConsoleQueries } from '../src/console/console.queries.js';
import { ConsoleServer } from '../src/console/console.server.js';
import { createDb, type Db } from '../src/db/db.module.js';
import { ConnectionRegistry } from '../src/ocpp-gateway/connection-registry.js';
import { ChargeSettlementService } from '../src/sessions/charge-settlement.service.js';
import { loadChargePolicy } from '../src/sessions/charge-policy.config.js';
import { DriverChargingService } from '../src/sessions/driver-charging.service.js';
import { migrate } from './helpers/apply-migrations.js';

const url = process.env['MB03_TEST_DATABASE_URL'];
const describeDb = url ? describe : describe.skip;
const secret = randomBytes(32);
const issuer = 'powerme-be34-test';
const audience = 'powerme-driver-test';
// BE-38 (0022): ảnh mẫu xe; mẫu không có ảnh trả null.
const VF8_IMAGE =
  'https://commons.wikimedia.org/wiki/Special:FilePath/VinFast_VF_8_DSC_8474.jpg?width=640';
const VF8_CREDIT = 'Alexander Migl / Wikimedia Commons, CC BY-SA 4.0';

describeDb('BE-34 driver vehicles over HTTP and dedicated Postgres', () => {
  let db: Db;
  let server: ConsoleServer;
  let config: CsmsConfig;
  let base: string;
  let driver: string;
  let other: string;
  let fresh: string;
  let token: string;
  let otherToken: string;
  let freshToken: string;
  let vf8: string;
  let leaf: string;
  let connector: string;
  let chargePoint: string;
  const q = async (sql: string, params: unknown[] = []) =>
    (await db.$client.query(sql, params)).rows;

  async function jwt(sub: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      role: 'driver',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
  }
  async function call(
    method: string,
    path: string,
    options: { auth?: string | null; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const auth = options.auth === undefined ? token : options.auth;
    const response = await fetch(`${base}/api/driver/v1${path}`, {
      method,
      headers: {
        ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }
  const add = (body: unknown, auth?: string) => call('POST', '/vehicles', { body, auth });
  const me = async (auth?: string) => (await call('GET', '/me', { auth })).body.vehicles as any[];
  const plates = async (auth?: string) =>
    (await me(auth)).map((v) => [v.plate_number, v.is_default]);

  async function addDriver(email: string) {
    const id = (
      await q(
        "INSERT INTO users(email,full_name,role) VALUES($1,'BE34','driver') RETURNING id::text AS id",
        [email],
      )
    )[0]!.id as string;
    await q(
      "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'local-test',now())",
      [id],
    );
    return id;
  }
  /** Phiên app đang chạy trên xe (đúng các cột sessions.service ghi khi StartTransaction). */
  async function openSession(vehicleId: string, driverId = driver) {
    return (
      await q(
        `INSERT INTO sessions(connector_id,charge_point_id,connector_no,id_tag,driver_id,vehicle_id,
           origin,payment_mode,status,cp_started_at,meter_start_wh)
         VALUES($1,$2,1,$3,$4,$5,'app_qr','csms_billed','active',now(),0) RETURNING id::text AS id`,
        [connector, chargePoint, 'BE34' + randomBytes(6).toString('hex'), driverId, vehicleId],
      )
    )[0]!.id as string;
  }
  async function intent(vehicleId: string, state: string) {
    return (
      await q(
        `INSERT INTO driver_charge_intents(driver_id,connector_id,vehicle_id,idempotency_key,request_hash,
           id_tag,energy_limit_wh,reserved_vnd,state)
         VALUES($1,$2,$3,$4,'h',$5,1000,0,$6) RETURNING id::text AS id`,
        [
          driver,
          connector,
          vehicleId,
          'be34-' + randomBytes(6).toString('hex'),
          'P3' + randomBytes(6).toString('hex'),
          state,
        ],
      )
    )[0]!.id as string;
  }

  beforeAll(async () => {
    if (!url) throw new Error('Missing test database');
    const parsed = new URL(url);
    if (
      process.env['MB03_TEST_ALLOW_EMPTY_DATABASE'] !== 'true' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !/^\/powerme_mb03_driver_test_\d+_[a-f0-9]{8}$/.test(parsed.pathname)
    )
      throw new Error('Requires explicit opt-in and a new isolated MB03 loopback test database');
    Logger.overrideLogger(['error']);
    db = createDb(url);
    if ((await q("SELECT to_regclass('public.users') AS table_name"))[0]?.table_name)
      throw new Error('Test database must be new and empty; never reset user data');
    await migrate(db.$client);
    driver = await addDriver('be34-a@example.invalid');
    other = await addDriver('be34-b@example.invalid');
    fresh = await addDriver('be34-c@example.invalid');
    vf8 = (
      await q(
        `INSERT INTO vehicle_models(brand,model_name,connector_type,battery_capacity_kwh,rated_range_km,max_dc_kw,is_vinfast,image_url,image_credit)
         VALUES('VinFast','VF 8 Plus','ccs2',87.7,457,150,true,$1,$2) RETURNING id::text AS id`,
        [VF8_IMAGE, VF8_CREDIT],
      )
    )[0]!.id;
    leaf = (
      await q(
        "INSERT INTO vehicle_models(brand,model_name,connector_type) VALUES('Nissan','Leaf','chademo') RETURNING id::text AS id",
      )
    )[0]!.id;
    const op = (
      await q(
        "INSERT INTO operators(tax_code,legal_name) VALUES('BE34','BE34 Operator') RETURNING id",
      )
    )[0]!.id;
    const site = (
      await q(
        "INSERT INTO sites(site_code,operator_id,site_name,latitude,longitude) VALUES('BE34',$1,'BE34 site',10.8,106.8) RETURNING id",
        [op],
      )
    )[0]!.id;
    chargePoint = (
      await q(
        "INSERT INTO charge_points(serial_number,display_code,site_id,lifecycle,is_online,last_message_at,online_changed_at) VALUES('BE34','PM-BE34',$1,'in_service',true,now(),now()) RETURNING id::text AS id",
        [site],
      )
    )[0]!.id;
    connector = (
      await q(
        "INSERT INTO connectors(charge_point_id,connector_no,status,status_changed_at) VALUES($1,1,'Available',now()) RETURNING id::text AS id",
        [chargePoint],
      )
    )[0]!.id;
    config = {
      ...loadConfig({
        DATABASE_URL: url,
        DRIVER_API_JWT_SECRET_BASE64: secret.toString('base64'),
        DRIVER_API_JWT_ISSUER: issuer,
        DRIVER_API_JWT_AUDIENCE: audience,
      }),
      consolePort: 0,
    };
    const registry = new ConnectionRegistry(db);
    const policy = loadChargePolicy({});
    server = new ConsoleServer(
      config,
      new ConsoleQueries(db, config, registry),
      new ConsoleCommands(db, registry),
      db,
      new DriverChargingService(db, registry, new ChargeSettlementService(db, policy), policy),
    );
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
    token = await jwt(driver);
    otherToken = await jwt(other);
    freshToken = await jwt(fresh);
  });
  afterAll(async () => {
    await server?.stop();
    await db?.$client.end();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  });

  it('GET /vehicle-models trả danh mục với id chuỗi và số đo dạng số', async () => {
    const res = await call('GET', '/vehicle-models');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.items).toEqual([
      {
        vehicle_model_id: leaf,
        brand: 'Nissan',
        model_name: 'Leaf',
        connector_type: 'chademo',
        is_vinfast: false,
        battery_capacity_kwh: null,
        rated_range_km: null,
        max_dc_kw: null,
        image_url: null,
        image_credit: null,
      },
      {
        vehicle_model_id: vf8,
        brand: 'VinFast',
        model_name: 'VF 8 Plus',
        connector_type: 'ccs2',
        is_vinfast: true,
        battery_capacity_kwh: 87.7,
        rated_range_km: 457,
        max_dc_kw: 150,
        image_url: VF8_IMAGE,
        image_credit: VF8_CREDIT,
      },
    ]);
    expect((await call('GET', '/vehicle-models?brand=VinFast')).status).toBe(400);
    expect((await call('GET', '/vehicle-models', { auth: null })).status).toBe(401);
    const post = await call('POST', '/vehicle-models', { body: {} });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('thêm xe đầu tiên: 201, biển chuẩn hoá, tự mặc định (kể cả khi gửi is_default=false), có trong /me', async () => {
    const res = await add({
      plate_number: '  51k-901.01 ',
      vehicle_model_id: vf8,
      is_default: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      vehicle_id: expect.stringMatching(/^[1-9][0-9]*$/),
      plate_number: '51K-901.01',
      is_default: true,
      vehicle_model_id: vf8,
      brand: 'VinFast',
      model_name: 'VF 8 Plus',
      connector_type: 'ccs2',
      is_vinfast: true,
      battery_capacity_kwh: 87.7,
      rated_range_km: 457,
      max_dc_kw: 150,
      image_url: VF8_IMAGE,
      image_credit: VF8_CREDIT,
    });
    // Cùng hình dạng phần tử /me.
    expect(await me()).toEqual([res.body]);
  });

  it('xe thứ hai không mặc định; xe thứ ba is_default=true thì cờ chuyển, chỉ một xe mặc định', async () => {
    const second = await add({ plate_number: '51K-901.02', vehicle_model_id: leaf });
    expect(second.status).toBe(201);
    expect(second.body.is_default).toBe(false);
    const third = await add({
      plate_number: '51K 777.77',
      vehicle_model_id: vf8,
      is_default: true,
    });
    expect(third.status).toBe(201);
    expect(third.body).toMatchObject({ plate_number: '51K777.77', is_default: true });
    expect(await plates()).toEqual([
      ['51K777.77', true],
      ['51K-901.01', false],
      ['51K-901.02', false],
    ]);
  });

  it('biển trùng (khác hoa/thường, khoảng trắng, dấu) → 409 plate_taken, cả với tài xế khác, không ghi gì', async () => {
    const before = await q('SELECT count(*)::int AS n FROM vehicles');
    for (const plate of [
      '51k-901.01',
      ' 51K 901.01 ',
      '51K90101',
      '51K-90101',
      '５１Ｋ－９０１．０１',
    ])
      for (const auth of [token, otherToken]) {
        const res = await add({ plate_number: plate, vehicle_model_id: vf8 }, auth);
        expect([plate, res.status, res.body]).toEqual([
          plate,
          409,
          { error: 'plate_taken', detail: 'plate_taken' },
        ]);
      }
    expect(await q('SELECT count(*)::int AS n FROM vehicles')).toEqual(before);
    expect(await me(otherToken)).toEqual([]);
  });

  it('body sai → 400 với mã ổn định; Content-Type / kích thước như các route khác', async () => {
    const cases: [unknown, string][] = [
      [{ plate_number: '51K-1', vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: '51K-901.01.99.99', vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: '51K--90101', vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: '-51K90101', vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: '51Đ-12345', vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: 51123456, vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ vehicle_model_id: vf8 }, 'invalid_plate_number'],
      [{ plate_number: '51K-555.55', vehicle_model_id: '999999' }, 'unknown_vehicle_model'],
      [{ plate_number: '51K-555.55', vehicle_model_id: Number(vf8) }, 'invalid_input'],
      [{ plate_number: '51K-555.55', vehicle_model_id: 'abc' }, 'invalid_input'],
      [{ plate_number: '51K-555.55', vehicle_model_id: vf8, is_default: 'yes' }, 'invalid_input'],
      [{ plate_number: '51K-555.55', vehicle_model_id: vf8, driver_id: other }, 'invalid_input'],
      ['[1]', 'invalid_input'],
      ['{bad', 'invalid_input'],
    ];
    for (const [body, code] of cases) {
      const res = await add(body);
      expect([body, res.status, res.body?.error]).toEqual([body, 400, code]);
    }
    expect(
      (
        await call('POST', '/vehicles', {
          body: '{}',
          headers: { 'Content-Type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (await call('POST', '/vehicles', { body: JSON.stringify({ x: 'a'.repeat(20000) }) })).status,
    ).toBe(413);
    expect((await call('POST', '/vehicles?x=1', { body: {} })).status).toBe(400);
    const get = await call('GET', '/vehicles');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    expect((await call('GET', '/vehicles/abc')).status).toBe(400);
    expect((await call('GET', '/vehicles/1/x')).status).toBe(404);
    expect((await me()).map((v) => v.plate_number)).not.toContain('51K-555.55');
  });

  it('PATCH đặt mặc định: chỉ {is_default: true}; xe người khác / không có → 404', async () => {
    const [, first] = await me();
    expect(first.plate_number).toBe('51K-901.01');
    const res = await call('PATCH', `/vehicles/${first.vehicle_id}`, {
      body: { is_default: true },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...first, is_default: true });
    // /me: xe mặc định trước, rồi theo thứ tự tạo.
    expect(await plates()).toEqual([
      ['51K-901.01', true],
      ['51K-901.02', false],
      ['51K777.77', false],
    ]);
    // Gọi lại vẫn 200, không đổi gì.
    expect(
      (await call('PATCH', `/vehicles/${first.vehicle_id}`, { body: { is_default: true } })).status,
    ).toBe(200);
    for (const body of [{ is_default: false }, {}, { is_default: true, plate_number: 'X' }])
      expect((await call('PATCH', `/vehicles/${first.vehicle_id}`, { body })).body.error).toBe(
        'invalid_input',
      );
    expect(
      (
        await call('PATCH', `/vehicles/${first.vehicle_id}`, {
          body: { is_default: true },
          auth: otherToken,
        })
      ).body,
    ).toEqual({ error: 'not_found', detail: 'not_found' });
    expect((await call('PATCH', '/vehicles/999999', { body: { is_default: true } })).status).toBe(
      404,
    );
  });

  it('DELETE xe của người khác hoặc không tồn tại → 404 như nhau, không đổi gì', async () => {
    const [mine] = await me();
    const before = await q('SELECT id,removed_at,is_default FROM vehicles ORDER BY id');
    for (const [path, auth] of [
      [`/vehicles/${mine.vehicle_id}`, otherToken],
      ['/vehicles/999999', token],
      ['/vehicles/9223372036854775807', token],
    ] as const) {
      const res = await call('DELETE', path, { auth });
      expect([path, res.status, res.body]).toEqual([
        path,
        404,
        { error: 'not_found', detail: 'not_found' },
      ]);
    }
    expect(await q('SELECT id,removed_at,is_default FROM vehicles ORDER BY id')).toEqual(before);
    const res = await call('POST', `/vehicles/${mine.vehicle_id}`, { body: {} });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('PATCH, DELETE, OPTIONS');
  });

  it('xe đang có phiên chưa kết thúc / yêu cầu sạc chưa xong → 409 vehicle_in_use', async () => {
    const leafCar = (await me()).find((v) => v.plate_number === '51K-901.02')!;
    const session = await openSession(leafCar.vehicle_id);
    let res = await call('DELETE', `/vehicles/${leafCar.vehicle_id}`);
    expect([res.status, res.body]).toEqual([
      409,
      { error: 'vehicle_in_use', detail: 'vehicle_in_use' },
    ]);
    await q("UPDATE sessions SET status='closed',meter_stop_wh=100 WHERE id=$1", [session]);
    const open = await intent(leafCar.vehicle_id, 'effect');
    res = await call('DELETE', `/vehicles/${leafCar.vehicle_id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('vehicle_in_use');
    await q("UPDATE driver_charge_intents SET state='settled' WHERE id=$1", [open]);
    // Yêu cầu bị từ chối / đã thả không giữ xe.
    await intent(leafCar.vehicle_id, 'rejected');
    expect((await me()).map((v) => v.plate_number)).toContain('51K-901.02');
  });

  it('gỡ xe có lịch sử: 204, lịch sử còn nguyên, xe biến khỏi /me, /stations và tra QR; biển đăng ký lại được', async () => {
    const leafCar = (await me()).find((v) => v.plate_number === '51K-901.02')!;
    const history = await q(
      `SELECT 'session' AS kind,id::text,vehicle_id::text FROM sessions WHERE vehicle_id=$1
       UNION ALL SELECT 'intent',id::text,vehicle_id::text FROM driver_charge_intents WHERE vehicle_id=$1
       ORDER BY 1,2`,
      [leafCar.vehicle_id],
    );
    expect(history).toHaveLength(3);
    const res = await fetch(`${base}/api/driver/v1/vehicles/${leafCar.vehicle_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(
      await q(
        `SELECT 'session' AS kind,id::text,vehicle_id::text FROM sessions WHERE vehicle_id=$1
         UNION ALL SELECT 'intent',id::text,vehicle_id::text FROM driver_charge_intents WHERE vehicle_id=$1
         ORDER BY 1,2`,
        [leafCar.vehicle_id],
      ),
    ).toEqual(history);
    const row = (
      await q('SELECT plate_number,is_default,removed_at FROM vehicles WHERE id=$1', [
        leafCar.vehicle_id,
      ])
    )[0]!;
    expect(row).toMatchObject({ plate_number: '51K-901.02', is_default: false });
    expect(row.removed_at).toBeInstanceOf(Date);
    expect((await me()).map((v) => v.vehicle_id)).not.toContain(leafCar.vehicle_id);

    // Xe đã gỡ không chọn được nữa.
    expect((await call('GET', `/stations?vehicle_id=${leafCar.vehicle_id}`)).body).toEqual({
      error: 'not_found',
      detail: 'not_found',
    });
    expect(
      (await call('GET', `/connectors/by-code/PM-BE34/1?vehicle_id=${leafCar.vehicle_id}`)).status,
    ).toBe(404);
    expect(
      (await call('PATCH', `/vehicles/${leafCar.vehicle_id}`, { body: { is_default: true } }))
        .status,
    ).toBe(404);
    expect((await call('DELETE', `/vehicles/${leafCar.vehicle_id}`)).status).toBe(404);

    // Bán xe: người khác đăng ký lại cùng biển (khác dạng gõ) → xe mới, xe cũ vẫn giữ lịch sử.
    const again = await add({ plate_number: '51k90102', vehicle_model_id: leaf }, otherToken);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ plate_number: '51K90102', is_default: true });
    expect(again.body.vehicle_id).not.toBe(leafCar.vehicle_id);
    // Nhưng chỉ một xe đang dùng mang biển đó.
    expect((await add({ plate_number: '51K-901.02', vehicle_model_id: leaf })).status).toBe(409);
  });

  it('gỡ xe mặc định → xe còn lại tạo sớm nhất thành mặc định; gỡ xe cuối → không còn xe', async () => {
    expect(await plates()).toEqual([
      ['51K-901.01', true],
      ['51K777.77', false],
    ]);
    const extra = await add({ plate_number: '30A-123.45', vehicle_model_id: vf8 });
    const [def] = await me();
    expect((await call('DELETE', `/vehicles/${def.vehicle_id}`)).status).toBe(204);
    // 51K777.77 tạo trước 30A-123.45 → thành mặc định.
    expect(await plates()).toEqual([
      ['51K777.77', true],
      ['30A-123.45', false],
    ]);
    // POST /charges với xe đã gỡ (VF 8, cùng chuẩn ccs2 với súng) bị từ chối như xe không thuộc
    // mình; xe còn dùng thì qua bước kiểm xe (dừng ở súng không có kết nối OCPP).
    await q(
      "INSERT INTO credit_accounts(driver_id,status,balance_vnd) VALUES($1,'active',500000)",
      [driver],
    );
    const charge = (vehicleId: string) =>
      call('POST', '/charges', {
        body: {
          connector_id: connector,
          vehicle_id: vehicleId,
          mode: 'energy_kwh',
          energy_limit_wh: 1000,
        },
        headers: { 'Idempotency-Key': 'be34-' + randomBytes(8).toString('hex') },
      });
    expect((await charge(def.vehicle_id)).body.error).toBe('vehicle_not_owned_or_incompatible');
    expect((await charge(extra.body.vehicle_id)).body.error).toBe('connector_unavailable');
    for (const v of await me())
      expect((await call('DELETE', `/vehicles/${v.vehicle_id}`)).status).toBe(204);
    expect(await me()).toEqual([]);
    expect(extra.body.is_default).toBe(false);
    // Thêm lại sau khi gỡ hết: xe đầu tiên tự mặc định.
    const back = await add({ plate_number: '51K-901.01', vehicle_model_id: vf8 });
    expect(back.body.is_default).toBe(true);
    expect(
      await q(
        'SELECT count(*)::int AS n FROM vehicles WHERE driver_id=$1 AND is_default AND removed_at IS NULL',
        [driver],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('hai lần thêm xe đầu tiên song song → đúng một xe mặc định; cùng biển song song → một 201, một 409', async () => {
    const [a, b] = await Promise.all([
      add({ plate_number: '60A-111.11', vehicle_model_id: vf8 }, freshToken),
      add({ plate_number: '60A-222.22', vehicle_model_id: vf8 }, freshToken),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.is_default, b.body.is_default].sort()).toEqual([false, true]);
    const results = await Promise.all([
      add({ plate_number: '60A-333.33', vehicle_model_id: vf8 }, freshToken),
      add({ plate_number: '60A33333', vehicle_model_id: vf8 }, otherToken),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('plate_taken');
  });

  it('preflight CORS của route xe khai đúng method và Content-Type', async () => {
    const pre = async (path: string) =>
      (
        await fetch(`${base}/api/driver/v1${path}`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:3001' },
        })
      ).headers;
    expect((await pre('/vehicles')).get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect((await pre('/vehicles')).get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
    expect((await pre('/vehicles/12')).get('access-control-allow-methods')).toBe(
      'PATCH, DELETE, OPTIONS',
    );
    expect((await pre('/vehicle-models')).get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect((await pre('/vehicle-models')).get('access-control-allow-headers')).toBe(
      'Authorization',
    );
  });
});
