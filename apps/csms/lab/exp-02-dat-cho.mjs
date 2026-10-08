// EXP-02 — Đặt chỗ connector qua OCPP 1.6 Reservation profile.
//
// Mục đích: trả lời bằng SỐ LIỆU, không bằng ý kiến, cho câu hỏi phạm vi
// "FR-20 đặt chỗ = 1 ngày công?" trong bảng effort Report 2 §1.2.
//
// Đo bảy hành vi, trong đó có hai cái là NFR đã cam kết trong phiếu v1.2:
//   - "of two simultaneous reservations for one connector exactly one succeeds"
//   - connector đổi trạng thái Available ⇄ Reserved ⇄ Charging
//
// Cần: csms-ctl.mjs đang chạy (PORT 9000, CTL_PORT 9100) và một trụ đang nối.
// Chạy:  node lab/exp-02-dat-cho.mjs            (từ apps/csms)

const CTL = process.env.CTL ?? 'http://localhost:9100';
const ID = process.env.ID ?? 'RH24D1-001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, params = {}) {
  const r = await fetch(`${CTL}/call/${ID}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return { http: r.status, ...(await r.json()) };
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ✓' : '  ✗'} ${name}`);
  if (detail) console.log(`      ${detail}`);
}

console.log(`\nEXP-02 — Đặt chỗ connector (trụ ${ID})\n${'─'.repeat(60)}`);

// ── 1. Trụ có khai báo hỗ trợ Reservation không ──────────────────────────────
console.log('\n1. Dò khả năng của trụ (GetConfiguration không tham số)');
const cfg = await call('GetConfiguration', {});
const profiles =
  cfg.result?.configurationKey?.find((k) => k.key === 'SupportedFeatureProfiles')?.value ?? '';
check(
  'Trụ khai báo profile Reservation',
  profiles.includes('Reservation'),
  `SupportedFeatureProfiles = ${profiles || '(không trả về)'}`,
);

// ── 2. Đặt chỗ trên connector đang rảnh ──────────────────────────────────────
console.log('\n2. ReserveNow trên connector 1 (đang Available)');
const r1 = await call('ReserveNow', { connectorId: 1, idTag: 'DRIVER-A', reservationId: 1001 });
check('ReserveNow → Accepted', r1.result?.status === 'Accepted', `status = ${r1.result?.status}`);
await sleep(300);

// ── 3. Đặt chỗ lần hai trên cùng connector ───────────────────────────────────
console.log('\n3. ReserveNow lần hai trên cùng connector (tuần tự)');
const r2 = await call('ReserveNow', { connectorId: 1, idTag: 'DRIVER-B', reservationId: 1002 });
check(
  'Connector đã giữ chỗ → Occupied',
  r2.result?.status === 'Occupied',
  `status = ${r2.result?.status}`,
);

// ── 4. NFR: hai yêu cầu ĐỒNG THỜI, đúng một cái thành công ───────────────────
console.log('\n4. NFR — hai ReserveNow ĐỒNG THỜI trên connector 2');
const [a, b] = await Promise.all([
  call('ReserveNow', { connectorId: 2, idTag: 'DRIVER-C', reservationId: 2001 }),
  call('ReserveNow', { connectorId: 2, idTag: 'DRIVER-D', reservationId: 2002 }),
]);
const accepted = [a, b].filter((x) => x.result?.status === 'Accepted').length;
check(
  'Đúng một yêu cầu thành công',
  accepted === 1,
  `DRIVER-C → ${a.result?.status}, DRIVER-D → ${b.result?.status} (số Accepted = ${accepted})`,
);

// ── 5. Chỗ đã đặt chỉ mở cho đúng người ──────────────────────────────────────
console.log('\n5. RemoteStart bằng idTag KHÁC trên connector đã giữ chỗ');
const wrong = await call('RemoteStartTransaction', { connectorId: 1, idTag: 'DRIVER-Z' });
check(
  'Người lạ bị từ chối',
  wrong.result?.status === 'Rejected',
  `status = ${wrong.result?.status}`,
);

// ── 6. Đúng người thì mở được, và giữ chỗ bị tiêu thụ ────────────────────────
console.log('\n6. RemoteStart bằng đúng idTag đã giữ chỗ');
const right = await call('RemoteStartTransaction', { connectorId: 1, idTag: 'DRIVER-A' });
check(
  'Đúng người → Accepted',
  right.result?.status === 'Accepted',
  `status = ${right.result?.status}`,
);
await sleep(1200);

const st = await (await fetch(`${CTL}/stations`)).json();
const open = st.stations?.[0]?.openTransactions ?? {};
check(
  'Phiên sạc đã mở trên connector 1',
  Boolean(open['1']),
  `openTransactions = ${JSON.stringify(open)}`,
);

// ── 7. Huỷ chỗ đã đặt ────────────────────────────────────────────────────────
console.log('\n7. CancelReservation cho chỗ còn lại trên connector 2');
const resId = a.result?.status === 'Accepted' ? 2001 : 2002;
const cancel = await call('CancelReservation', { reservationId: resId });
check(
  'Huỷ được → Accepted',
  cancel.result?.status === 'Accepted',
  `status = ${cancel.result?.status}`,
);

const ghost = await call('CancelReservation', { reservationId: 9999 });
check(
  'Huỷ chỗ không tồn tại → Rejected',
  ghost.result?.status === 'Rejected',
  `status = ${ghost.result?.status}`,
);

// ── Tổng kết ─────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.passed).length;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Kết quả: ${pass}/${results.length} đạt`);
if (pass < results.length) {
  console.log('\nChưa đạt:');
  for (const r of results.filter((x) => !x.passed)) console.log(`  · ${r.name} — ${r.detail}`);
}
console.log('');
process.exit(pass === results.length ? 0 : 1);
