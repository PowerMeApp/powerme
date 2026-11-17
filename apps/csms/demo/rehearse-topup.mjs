/**
 * Diễn tập BM04 DS-03 / DS-04 (nạp Charging Credit qua VNPay) ở mức Driver API — đóng vai app tài
 * xế khi app chưa có màn nạp tiền, và (chỉ ở LOCAL) đóng vai VNPay bằng một IPN tự ký (BE-42).
 *
 * DS-03  "Driver with 600 points → top up 200,000, redeem 500 points, pay in VNPay sandbox →
 *         credit +200,000; TopUp credited; one e-invoice"
 * DS-04  "Cancel at VNPay, then resend the same IPN → TopUp failed, balance unchanged; duplicate
 *         IPN credits nothing"
 *
 * Hai cách chạy:
 *   --simulate-vnpay   LOCAL: script tự gửi IPN có chữ ký tới /billing/vnpay/ipn. Cần
 *                      VNPAY_HASH_SECRET trong môi trường = đúng secret CSMS đang dùng (secret GIẢ
 *                      của bản local). Bị từ chối nếu --api không phải loopback :30xx của bản local —
 *                      không bao giờ dùng secret sandbox thật ở đây.
 *   (mặc định)         STAGING / sandbox thật: script in `payment_url`, người trình bày mở trong
 *                      trình duyệt và trả tiền (DS-03) hoặc bấm huỷ (DS-04); script chờ kết quả do
 *                      VNPay báo về. Không gửi lại IPN được (không có secret) — bước "duplicate IPN"
 *                      của DS-04 chỉ kiểm được ở chế độ --simulate-vnpay.
 *
 * Chạy local (xem docs/demo/DIEN-TAP-BM04.md):
 *   VNPAY_HASH_SECRET=… DEMO_DRIVER_PASSWORD=… node demo/rehearse-topup.mjs ds-03 \
 *     --api http://127.0.0.1:3000 --simulate-vnpay
 *
 * Tuỳ chọn: --api <gốc HTTP của CSMS>  --email <tài xế> (mặc định app.ds03@powerme.test)
 *           --amount 200000  --points 500  --timeout-s 900 (chờ người trả tiền ở chế độ thật)
 * Biến môi trường: DEMO_DRIVER_PASSWORD (bắt buộc), VNPAY_HASH_SECRET (chỉ --simulate-vnpay).
 * Không in mật khẩu, token hay secret. Thoát 0 khi mọi kiểm tra đạt, 1 khi có kiểm tra sai, 2 khi
 * thiếu cấu hình.
 *
 * LƯU Ý: ds-03 cộng tiền và trừ điểm THẬT trong DB đang trỏ tới; chạy lại cần `seed --reset`
 * (tài xế hết 600 điểm sau lần đầu). Hoá đơn điện tử (T32 Phần 7) chưa có nên KHÔNG được kiểm.
 */
import { createHmac, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const ROOT = opt('api', 'http://127.0.0.1:3000').replace(/\/$/, '');
const API = `${ROOT}/api/driver/v1`;
const EMAIL = opt('email', 'app.ds03@powerme.test');
const AMOUNT = Number(opt('amount', 200000));
const POINTS = Number(opt('points', 500));
const TIMEOUT_S = Number(opt('timeout-s', 900));
const SIMULATE = argv.includes('--simulate-vnpay');
const PASSWORD = process.env.DEMO_DRIVER_PASSWORD;
const HASH_SECRET = process.env.VNPAY_HASH_SECRET ?? '';

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

// ---- VNPay giả (chỉ local) -------------------------------------------------------------------
/** Cùng cách encode và ký với src/billing/vnpay.adapter.ts (vnpEncode, vnpSignData, HMAC-SHA512). */
const vnpEncode = (v) =>
  encodeURIComponent(v)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
function signedIpnQuery(params) {
  const data = Object.keys(params)
    .sort()
    .map((k) => `${vnpEncode(k)}=${vnpEncode(params[k])}`)
    .join('&');
  const hash = createHmac('sha512', HASH_SECRET).update(data, 'utf8').digest('hex');
  return `${data}&vnp_SecureHash=${hash}`;
}
const payDate = () => {
  const t = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
  return t.slice(0, 19).replace(/[-T:]/g, '');
};
/** IPN như VNPay gửi, dựng từ chính tham số của `payment_url` (mã merchant, TxnRef, số tiền). */
function ipnFor(paymentUrl, { responseCode, transactionStatus, transactionNo }) {
  const q = new URL(paymentUrl).searchParams;
  return signedIpnQuery({
    vnp_Amount: q.get('vnp_Amount'),
    vnp_BankCode: 'NCB',
    vnp_OrderInfo: q.get('vnp_OrderInfo') ?? 'Nap Charging Credit',
    vnp_PayDate: payDate(),
    vnp_ResponseCode: responseCode,
    vnp_TmnCode: q.get('vnp_TmnCode'),
    vnp_TransactionNo: transactionNo,
    vnp_TransactionStatus: transactionStatus,
    vnp_TxnRef: q.get('vnp_TxnRef'),
  });
}
async function sendIpn(query) {
  const res = await fetch(`${ROOT}/billing/vnpay/ipn?${query}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Bước chung ------------------------------------------------------------------------------
async function login() {
  const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`đăng nhập ${EMAIL} trả ${res.status}`);
  token = res.body.access_token;
  log(`đăng nhập ${EMAIL}: 200`);
}
async function createTopUp(points) {
  const res = await call('POST', '/billing/top-ups', {
    headers: { 'idempotency-key': randomUUID() },
    body: { amount_vnd: AMOUNT, ...(points > 0 ? { points_to_redeem: points } : {}) },
  });
  check(
    'tạo top-up → 201 pending',
    res.status === 201 && res.body?.status === 'pending',
    `HTTP ${res.status} ${res.body?.error ?? ''}`,
  );
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const t = res.body;
  log(
    `  top-up #${t.top_up_id}: nạp ${t.amount_vnd}, dùng ${t.points_redeemed} điểm (giảm ${t.points_discount_vnd}), phải trả ${t.amount_paid_vnd}`,
  );
  return t;
}
async function waitFinal(topUpId) {
  const end = Date.now() + TIMEOUT_S * 1000;
  let last = null;
  while (Date.now() < end) {
    last = (await call('GET', `/billing/top-ups/${topUpId}`)).body;
    if (last?.status && last.status !== 'pending') return last;
    await sleep(2000);
  }
  throw new Error(`quá ${TIMEOUT_S} s mà top-up vẫn ${last?.status}`);
}
const credit = async () => (await call('GET', '/credit')).body;

const SCENARIOS = {
  async 'ds-03'() {
    await login();
    const before = await credit();
    const quote = (await call('GET', `/billing/top-ups/quote?amount_vnd=${AMOUNT}`)).body;
    log(
      `số dư trước: ${before.balance_vnd} VND; điểm đang có ${quote.points_available}, dùng tối đa ${quote.max_points}`,
    );
    check(
      `tài xế có đủ điểm để đổi ${POINTS}`,
      quote.max_points >= POINTS,
      `max_points ${quote.max_points}`,
    );
    const t = await createTopUp(POINTS);
    check(`đổi đúng ${POINTS} điểm`, t.points_redeemed === POINTS, `${t.points_redeemed}`);
    check(
      'số phải trả = số nạp − giảm giá do điểm',
      t.amount_paid_vnd === t.amount_vnd - t.points_discount_vnd && t.points_discount_vnd > 0,
      `${t.amount_vnd} − ${t.points_discount_vnd} = ${t.amount_paid_vnd}`,
    );
    if (SIMULATE) {
      const ipn = await sendIpn(
        ipnFor(t.payment_url, {
          responseCode: '00',
          transactionStatus: '00',
          transactionNo: String(Date.now()).slice(-8),
        }),
      );
      check(
        'VNPay (giả) báo thành công → IPN trả RspCode 00',
        ipn.body?.RspCode === '00',
        JSON.stringify(ipn.body),
      );
    } else {
      log('MỞ link sau trong trình duyệt và TRẢ TIỀN ở VNPay sandbox (script đang chờ):');
      console.log(`\n  ${t.payment_url}\n`);
    }
    const final = await waitFinal(t.top_up_id);
    check('top-up kết thúc ở credited', final.status === 'credited', final.status);
    const after = await credit();
    log(`số dư sau: ${after.balance_vnd} VND`);
    check(
      `Charging Credit tăng đúng ${AMOUNT} (đủ số nạp, không phải số đã trả)`,
      after.balance_vnd - before.balance_vnd === AMOUNT,
      `${before.balance_vnd} → ${after.balance_vnd}`,
    );
    const q2 = (await call('GET', `/billing/top-ups/quote?amount_vnd=${AMOUNT}`)).body;
    check(
      `điểm giảm đúng ${POINTS}`,
      quote.points_available - q2.points_available === POINTS,
      `${quote.points_available} → ${q2.points_available}`,
    );
    const tx = (await call('GET', '/credit/transactions?page=1&page_size=5')).body;
    const rows = (tx?.items ?? []).filter((r) => String(r.top_up_id) === String(t.top_up_id));
    check('đúng một dòng cộng tiền cho top-up này', rows.length === 1, `${rows.length} dòng`);
    log('  (hoá đơn điện tử — T32 Phần 7 — chưa có trong CSMS nên không kiểm)');
  },

  async 'ds-04'() {
    await login();
    const before = await credit();
    log(`số dư trước: ${before.balance_vnd} VND`);
    const t = await createTopUp(0);
    let cancelIpn = null;
    if (SIMULATE) {
      // Tài xế bấm huỷ ở VNPay: ResponseCode 24, TransactionStatus 02.
      cancelIpn = ipnFor(t.payment_url, {
        responseCode: '24',
        transactionStatus: '02',
        transactionNo: '0',
      });
      const first = await sendIpn(cancelIpn);
      check(
        'VNPay (giả) báo huỷ → IPN trả RspCode 00 (đã ghi nhận)',
        first.body?.RspCode === '00',
        JSON.stringify(first.body),
      );
    } else {
      log('MỞ link sau trong trình duyệt và BẤM HUỶ ở VNPay sandbox (script đang chờ):');
      console.log(`\n  ${t.payment_url}\n`);
    }
    const final = await waitFinal(t.top_up_id);
    check('top-up kết thúc ở failed', final.status === 'failed', final.status);
    if (SIMULATE) {
      const again = await sendIpn(cancelIpn);
      check(
        'gửi lại ĐÚNG IPN đó → RspCode 02 (đã xử lý), không ghi thêm',
        again.body?.RspCode === '02',
        JSON.stringify(again.body),
      );
      // Kể cả một IPN "thành công" tới sau cho top-up đã failed cũng không được cộng tiền (khoản trễ).
      const late = await sendIpn(
        ipnFor(t.payment_url, {
          responseCode: '00',
          transactionStatus: '00',
          transactionNo: String(Date.now()).slice(-8),
        }),
      );
      check(
        'IPN thành công tới SAU khi đã failed → không cộng tiền (ghi khoản trễ), RspCode 00',
        late.body?.RspCode === '00',
        JSON.stringify(late.body),
      );
    } else {
      log(
        '  (gửi lại IPN chỉ kiểm được với --simulate-vnpay; ở sandbox thật không có secret để ký)',
      );
    }
    const after = await credit();
    check('số dư không đổi', after.balance_vnd === before.balance_vnd, `${after.balance_vnd} VND`);
    const still = (await call('GET', `/billing/top-ups/${t.top_up_id}`)).body;
    check('top-up vẫn failed sau các IPN lặp', still.status === 'failed', still.status);
    const next = await call('POST', '/billing/top-ups', {
      headers: { 'idempotency-key': randomUUID() },
      body: { amount_vnd: AMOUNT },
    });
    check(
      'tài xế tạo được top-up mới ngay sau đó (không bị kẹt)',
      next.status === 201,
      `HTTP ${next.status} ${next.body?.error ?? ''}`,
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
if (SIMULATE) {
  const host = new URL(ROOT);
  if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.protocol !== 'http:') {
    console.error('--simulate-vnpay chỉ dùng với CSMS local (http://127.0.0.1:<cổng>).');
    process.exit(2);
  }
  if (!HASH_SECRET) {
    console.error('--simulate-vnpay cần VNPAY_HASH_SECRET (secret GIẢ của bản local).');
    process.exit(2);
  }
}

try {
  log(
    `=== diễn tập ${scenario} trên ${API}${SIMULATE ? ' (VNPay giả, local)' : ' (VNPay thật)'} ===`,
  );
  await SCENARIOS[scenario]();
} catch (err) {
  check(`chạy hết kịch bản ${scenario}`, false, String(err?.message ?? err));
}
const failed = checks.filter((c) => !c.ok);
log(`=== ${scenario}: ${checks.length - failed.length}/${checks.length} kiểm tra đạt ===`);
process.exit(failed.length ? 1 : 0);
