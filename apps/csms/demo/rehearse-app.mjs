/**
 * Diễn tập BM04 DS-01 / DS-02 ở mức Driver API — đóng vai app tài xế khi chưa có app nối thật (BE-39).
 *
 * Vì sao tồn tại: DS-01 ("get suggestion → scan QR → 10 kWh limit → limit reached → session
 * reconciled, credit debited, points earned, statement shown") và DS-02 ("credit 30,000 → start
 * refused with top-up offer; no session") đi qua 6 route và một trụ phải trả lời RemoteStart /
 * RemoteStop. Script này gọi đúng các route app sẽ gọi và kiểm kết quả, để biết backend + trụ đã
 * sẵn cho demo trước khi app nối xong, và làm kế hoạch B nếu app hỏng ở phòng demo.
 *
 * Chạy (CSMS đang lên, Driver API có JWT; trụ kịch bản `app` đang nối):
 *   node demo/scripted-station.mjs app --url ws://localhost:9000/ocpp --interval-s 3 --tick-wh 2500 &
 *   DEMO_DRIVER_PASSWORD=… node demo/rehearse-app.mjs ds-01 --api http://127.0.0.1:3000
 *   DEMO_DRIVER_PASSWORD=… node demo/rehearse-app.mjs ds-02 --api http://127.0.0.1:3000
 *
 * Tuỳ chọn: --api <gốc HTTP của CSMS> (mặc định http://127.0.0.1:3000)
 *           --code PM-D1-HCM-0001 (display_code in trên trụ)  --connector 1
 *           --limit-wh 10000 (ds-01)  --email <tài xế> (mặc định app.ds01 / app.ds02 @powerme.test)
 *           --timeout-s 180 (chờ tối đa cho từng bước poll)
 * Biến môi trường: DEMO_DRIVER_PASSWORD (bắt buộc; không có tham số dòng lệnh, không in ra).
 * Thoát mã 0 khi mọi kiểm tra đạt, 1 khi có kiểm tra sai, 2 khi thiếu cấu hình.
 *
 * LƯU Ý: ds-01 TRỪ TIỀN THẬT của tài xế mẫu trong DB đang trỏ tới (số dư app.ds01 giảm sau mỗi lần
 * chạy). Trên staging, chạy `./seed.sh --reset` trước buổi demo để số dư về 200.000.
 */
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const API = `${opt('api', 'http://127.0.0.1:3000').replace(/\/$/, '')}/api/driver/v1`;
const CODE = opt('code', 'PM-D1-HCM-0001');
const CONNECTOR_NO = Number(opt('connector', 1));
const LIMIT_WH = Number(opt('limit-wh', 10000));
const TIMEOUT_S = Number(opt('timeout-s', 180));
const PASSWORD = process.env.DEMO_DRIVER_PASSWORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let token = null;
async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function login(email) {
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`đăng nhập ${email} trả ${res.status}`);
  token = res.body.access_token;
  log(`đăng nhập ${email}: 200`);
}

async function pollUntil(what, fn) {
  const end = Date.now() + TIMEOUT_S * 1000;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last.done) return last.value;
    await sleep(1500);
  }
  throw new Error(`quá ${TIMEOUT_S} s khi chờ ${what}; lần cuối: ${JSON.stringify(last?.seen)}`);
}

/** Bước chung của hai kịch bản: xe mặc định + quét mã súng. */
async function vehicleAndConnector() {
  const me = await call('GET', '/me');
  const vehicle = me.body?.vehicles?.find((v) => v.is_default) ?? me.body?.vehicles?.[0];
  if (!vehicle) throw new Error('tài xế chưa có xe');
  log(`xe mặc định: ${vehicle.brand} ${vehicle.model_name} (${vehicle.plate_number})`);
  const scan = await call(
    'GET',
    `/connectors/by-code/${encodeURIComponent(CODE)}/${CONNECTOR_NO}?vehicle_id=${vehicle.vehicle_id}`,
  );
  check(`quét mã ${CODE} súng ${CONNECTOR_NO} → 200`, scan.status === 200, `HTTP ${scan.status}`);
  const connectorId = scan.body?.connector_id ?? scan.body?.connector?.connector_id;
  if (!connectorId) throw new Error(`không đọc được connector_id: ${JSON.stringify(scan.body)}`);
  return { vehicle, connectorId: String(connectorId) };
}

const SCENARIOS = {
  /** DS-01: sạc tới hạn mức, phiên reconciled, trừ tiền theo biểu giá, cộng điểm, có bảng kê. */
  async 'ds-01'() {
    await login(opt('email', 'app.ds01@powerme.test'));
    const { vehicle, connectorId } = await vehicleAndConnector();
    const before = (await call('GET', '/credit')).body;
    log(`số dư trước: ${before.balance_vnd} VND (khả dụng ${before.available_vnd})`);

    const key = randomUUID();
    const start = await call('POST', '/charges', {
      headers: { 'idempotency-key': key },
      body: {
        connector_id: connectorId,
        vehicle_id: vehicle.vehicle_id,
        mode: 'energy_kwh',
        energy_limit_wh: LIMIT_WH,
      },
    });
    check(
      'POST /charges → 202',
      start.status === 202,
      `HTTP ${start.status} ${start.body?.outcome ?? ''}`,
    );
    if (start.status !== 202) throw new Error(JSON.stringify(start.body));

    const sessionId = await pollUntil('phiên bắt đầu', async () => {
      const r = await call('GET', `/charges/${key}`);
      const o = r.body?.outcome;
      if (
        ['topuprequired', 'requiresconfirmation', 'rejected', 'start_timeout', 'released'].includes(
          o,
        )
      )
        throw new Error(`bắt đầu thất bại: ${o}`);
      return { done: Boolean(r.body?.session_id), value: r.body?.session_id, seen: o };
    });
    check('trụ nhận lệnh và phiên bắt đầu', true, `session_id ${sessionId}`);

    let lastWh = -1;
    const final = await pollUntil('phiên dừng và quyết toán', async () => {
      const p = (await call('GET', `/sessions/${sessionId}/progress`)).body ?? {};
      if (p.consumed_wh !== lastWh) {
        lastWh = p.consumed_wh;
        log(`  tiến độ: ${p.status}, ${p.consumed_wh} Wh, tạm tính ${p.estimated_cost_vnd} VND`);
      }
      return {
        done: p.meter_stop_wh != null && p.settlement_state === 'posted',
        value: p,
        seen: { status: p.status, settlement_state: p.settlement_state },
      };
    });
    check('phiên kết thúc ở reconciled', final.status === 'reconciled', final.status);
    check(
      `dừng khi chạm hạn mức ${LIMIT_WH} Wh (không quá một nhịp)`,
      final.consumed_wh >= LIMIT_WH,
      `${final.consumed_wh} Wh`,
    );

    const st = await call('GET', `/sessions/${sessionId}/statement`);
    check('có bảng kê (statement) → 200', st.status === 200, `HTTP ${st.status}`);
    const s = st.body ?? {};
    log(`  bảng kê: ${s.energy_wh} Wh, ${s.amount_vnd} VND, +${s.earned_points} điểm`);
    check('bảng kê có tiền > 0', Number(s.amount_vnd) > 0);
    check(
      'điểm thưởng = 1 điểm / 1.000 VND (BR-P34)',
      s.earned_points === Math.floor(Number(s.amount_vnd) / 1000),
      `${s.earned_points} điểm`,
    );

    const after = (await call('GET', '/credit')).body;
    log(`số dư sau: ${after.balance_vnd} VND (giữ ${after.held_vnd})`);
    check(
      'số dư giảm đúng bằng tiền trên bảng kê',
      before.balance_vnd - after.balance_vnd === s.amount_vnd,
      `${before.balance_vnd} − ${after.balance_vnd} = ${before.balance_vnd - after.balance_vnd}`,
    );
    check('không còn tiền bị giữ', after.held_vnd === 0, `held ${after.held_vnd}`);

    const tx = (await call('GET', '/credit/transactions?page=1&page_size=5')).body;
    const debits = (tx?.items ?? []).filter((t) => String(t.session_id) === String(sessionId));
    check(
      'đúng một dòng trừ tiền cho phiên (không trừ hai lần)',
      debits.length === 1,
      `${debits.length} dòng`,
    );
  },

  /** DS-02: số dư dưới mức khởi đầu → từ chối kèm gợi ý nạp tiền, không có phiên. */
  async 'ds-02'() {
    await login(opt('email', 'app.ds02@powerme.test'));
    const { vehicle, connectorId } = await vehicleAndConnector();
    const before = (await call('GET', '/credit')).body;
    log(`số dư: ${before.balance_vnd} VND`);
    const key = randomUUID();
    const start = await call('POST', '/charges', {
      headers: { 'idempotency-key': key },
      body: {
        connector_id: connectorId,
        vehicle_id: vehicle.vehicle_id,
        mode: 'energy_kwh',
        energy_limit_wh: LIMIT_WH,
      },
    });
    log(`  POST /charges → HTTP ${start.status} ${JSON.stringify(start.body)}`);
    const got = (await call('GET', `/charges/${key}`)).body ?? start.body ?? {};
    const outcome = start.body?.outcome ?? start.body?.error ?? got.outcome;
    check(
      'bắt đầu bị từ chối với lý do nạp tiền (topuprequired)',
      /topup/i.test(String(outcome)),
      String(outcome),
    );
    check('không có phiên nào được tạo', !start.body?.session_id && !got.session_id);
    await sleep(3000);
    const after = (await call('GET', '/credit')).body;
    check(
      'số dư không đổi, không giữ tiền',
      after.balance_vnd === before.balance_vnd && after.held_vnd === 0,
      `${after.balance_vnd} VND, held ${after.held_vnd}`,
    );
  },
};

if (!scenario || !SCENARIOS[scenario]) {
  console.error(`Kịch bản: ${Object.keys(SCENARIOS).join(' | ')}. Xem đầu file để biết tuỳ chọn.`);
  process.exit(2);
}
if (!PASSWORD) {
  console.error('Thiếu DEMO_DRIVER_PASSWORD (mật khẩu tài xế mẫu).');
  process.exit(2);
}

try {
  log(`=== diễn tập ${scenario} trên ${API} ===`);
  await SCENARIOS[scenario]();
} catch (err) {
  check(`chạy hết kịch bản ${scenario}`, false, String(err?.message ?? err));
}
const failed = checks.filter((c) => !c.ok);
log(`=== ${scenario}: ${checks.length - failed.length}/${checks.length} kiểm tra đạt ===`);
process.exit(failed.length ? 1 : 0);
