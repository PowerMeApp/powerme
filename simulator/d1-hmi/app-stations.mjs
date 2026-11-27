#!/usr/bin/env node
// app-stations.mjs — bật 13 trụ app mẫu (PMAPP-*) bằng simulator HMI, một tiến trình, nối vào một
// CSMS (local hoặc staging), rồi cài vài ngoại lệ để app tài xế thấy nhiều trạng thái thật.
//
// VÌ SAO
//   Seed app có 14 trạm nhưng chỉ PMAPP-TD-04A luôn nối (demo-station), nên app thấy 13 trạm còn lại
//   offline. Người test app (và đầu đọc RFID USB thật) cần chạy simulator TRÊN MÁY CỦA MÌNH: đầu đọc
//   "gõ phím" vào trang /tru/<serial>, và route swipeReader chỉ nhận yêu cầu loopback (#214).
//
// CHẠY (từ gốc repo, sau `npm ci` + `npm run sim:tru3d:build`):
//   CP_PASSWORD=<mật khẩu trụ, nhận riêng> node simulator/d1-hmi/app-stations.mjs \
//     --url wss://<staging>/ocpp                 # staging (TLS + Basic Auth)
//   CP_PASSWORD=$DEMO_CHARGE_POINT_PASSWORD node simulator/d1-hmi/app-stations.mjs \
//     --url ws://localhost:9040/ocpp             # demo local `run-demo.mjs --port-offset 40`
//   Mở http://127.0.0.1:8141/ (trang tổng) · http://127.0.0.1:8141/tru/<serial> (từng trụ + RFID).
//   Ctrl+C để dừng (các trụ mất kết nối; sau ~15 phút CSMS mở cảnh báo Offline — BR-P50).
//
// TUỲ CHỌN
//   --url <ws(s)://…/ocpp>   CSMS (mặc định ws://localhost:9000/ocpp)
//   --port 8141              cổng HMI
//   --sach                   không cài ngoại lệ (mọi trụ bật, mọi súng Available)
//   --off PMAPP-TB-01A       trụ cố ý KHÔNG bật (mặc định PMAPP-TB-01A; "--off none" để bật cả 13)
//   --only A,B               chỉ bật các trụ này (vd. để thử nhanh một trụ)
//   --them-d1                bật thêm trụ D1 gốc RH24D1-00001 (trạm "Tram sac demo Quan 1"). Trụ này
//                            có mật khẩu RIÊNG: đặt CP_PASSWORD_D1. Chỉ dùng khi không có HMI/simulator
//                            nào khác đang chạy RH24D1-00001 trên CSMS đó (staging: profile `sim` tắt;
//                            local: HMI :8140 của run-demo đã dùng nó → đừng bật ở local).
//
// NGOẠI LỆ MẶC ĐỊNH (bỏ bằng --sach)
//   PMAPP-Q1-01A súng 2 Faulted (ConnectorLockFailure) · PMAPP-TD-02A súng 1 Faulted (GroundFailure)
//   PMAPP-Q7-01A súng 2 đang sạc bằng thẻ DEMO · PMAPP-TD-01B súng 1 đã cắm (Preparing)
//   PMAPP-TB-01A offline (không bật)
//   PMAPP-PN-01A, PMAPP-Q1-01B chỉ có 1 súng trong DB: simulator giả 2 súng, CSMS bỏ qua súng 2.
//
// Mật khẩu trụ chỉ đi qua biến môi trường CP_PASSWORD (không lên argv, không in ra). Một mật khẩu
// chung cho cả 13 trụ — đặt trong DB của CSMS đích (staging: Trí đặt, gửi riêng; local: seed).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALL = [
  'PMAPP-BT-01A',
  'PMAPP-PN-01A',
  'PMAPP-Q1-01A',
  'PMAPP-Q1-01B',
  'PMAPP-Q10-01A',
  'PMAPP-Q3-01A',
  'PMAPP-Q7-01A',
  'PMAPP-TB-01A',
  'PMAPP-TD-01A',
  'PMAPP-TD-01B',
  'PMAPP-TD-02A',
  'PMAPP-TD-02B',
  'PMAPP-TD-03A',
];
// QA-08: tên hiển thị = tên trạm + công suất trụ (theo apps/csms/demo/seed-app.sql).
const D1 = 'RH24D1-00001';
const NAMES = {
  [D1]: 'Tram sac demo Quan 1 · DC 120 kW (D1)',
  'PMAPP-BT-01A': 'PowerMe Landmark 81 · DC 120 kW',
  'PMAPP-PN-01A': 'PowerMe Phan Xich Long · DC 30 kW',
  'PMAPP-Q1-01A': 'PowerMe Ben Thanh · DC 120 kW',
  'PMAPP-Q1-01B': 'PowerMe Ben Thanh · AC 22 kW',
  'PMAPP-Q10-01A': 'PowerMe Van Hanh Mall · AC 7 kW',
  'PMAPP-Q3-01A': 'PowerMe Ho Con Rua · DC 60 kW',
  'PMAPP-Q7-01A': 'VinFast Crescent Mall · DC 150 kW',
  'PMAPP-TB-01A': 'VinFast Cong Hoa · DC 60 kW',
  'PMAPP-TD-01A': 'PowerMe Thao Dien · DC 50 kW',
  'PMAPP-TD-01B': 'PowerMe Thao Dien · AC 22 kW',
  'PMAPP-TD-02A': 'VinFast Vinhomes Grand Park · DC 60 kW',
  'PMAPP-TD-02B': 'VinFast Vinhomes Grand Park · AC 11 kW',
  'PMAPP-TD-03A': 'PowerMe Nha Van hoa Sinh vien · DC 60 kW',
};
// Mã in trên trụ (display_code, seed-app.sql / seed.sql) — tài xế nhập "<mã>/<súng>" trên app.
const CODES = {
  [D1]: 'PM-D1-HCM-0001',
  'PMAPP-BT-01A': 'PM-DC120-HCM-0501',
  'PMAPP-PN-01A': 'PM-DC30-HCM-0401',
  'PMAPP-Q1-01A': 'PM-DC120-HCM-0101',
  'PMAPP-Q1-01B': 'PM-AC22-HCM-0102',
  'PMAPP-Q10-01A': 'PM-AC7-HCM-0301',
  'PMAPP-Q3-01A': 'PM-DC60-HCM-0201',
  'PMAPP-Q7-01A': 'PM-DC150-HCM-0701',
  'PMAPP-TB-01A': 'PM-DC60-HCM-0901',
  'PMAPP-TD-01A': 'PM-DC50-HCM-0601',
  'PMAPP-TD-01B': 'PM-AC22-HCM-0602',
  'PMAPP-TD-02A': 'PM-DC60-HCM-0801',
  'PMAPP-TD-02B': 'PM-AC11-HCM-0802',
  'PMAPP-TD-03A': 'PM-DC60-HCM-1001',
};
const EXCEPTIONS = [
  ['PMAPP-Q1-01A', 'fault', { connector: 2, errorCode: 'ConnectorLockFailure' }],
  ['PMAPP-TD-02A', 'fault', { connector: 1, errorCode: 'GroundFailure' }],
  ['PMAPP-Q7-01A', 'plug', { connector: 2 }],
  ['PMAPP-Q7-01A', 'swipe', { connector: 2, card: 'valid' }],
  ['PMAPP-TD-01B', 'plug', { connector: 1 }],
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const url = opt('url', 'ws://localhost:9000/ocpp');
const port = Number(opt('port', 8141));
const clean = argv.includes('--sach');
const off = clean ? 'none' : opt('off', 'PMAPP-TB-01A');
const only = opt('only', null)
  ?.split(',')
  .map((s) => s.trim());
const password = process.env.CP_PASSWORD ?? '';
const withD1 = argv.includes('--them-d1');
const passwordD1 = process.env.CP_PASSWORD_D1 ?? '';

if (!/^wss?:\/\/[^\s]+$/.test(url)) fail(`--url không hợp lệ: ${url}`);
if (!(port > 0 && port < 65536)) fail(`--port không hợp lệ: ${port}`);
if (!password) fail('thiếu CP_PASSWORD (mật khẩu trụ — nhận riêng, không dán chat)');
if (only?.some((s) => !ALL.includes(s))) fail(`--only chỉ nhận: ${ALL.join(', ')}`);
if (withD1 && !passwordD1)
  fail('--them-d1 cần CP_PASSWORD_D1 (mật khẩu trụ RH24D1-00001, nhận riêng)');

const ids = [...(withD1 ? [D1] : []), ...(only ?? ALL).filter((s) => s !== off)];
if (!ids.length) fail('không còn trụ nào để bật');

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CSMS_URL: url,
    HMI_PORT: String(port),
    CP_IDS: ids.join(','),
    CP_PASSWORDS: ids.map((id) => (id === D1 ? passwordD1 : password)).join(','),
    CP_NAMES: ids.map((id) => NAMES[id] ?? '').join(','),
    CP_CODES: ids.map((id) => CODES[id] ?? '').join(','),
  },
});
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));

const base = `http://127.0.0.1:${port}`;
await waitHttp(base);
console.log(`[app-stations] ${ids.length} trụ → ${url}`);
console.log(`[app-stations] trang tổng ${base}/ · từng trụ ${base}/tru/<serial>`);
if (off !== 'none' && !only) console.log(`[app-stations] cố ý offline: ${off}`);

if (!clean) {
  await sleep(8000); // chờ Boot + StatusNotification của mọi trụ
  for (const [cp, action, body] of EXCEPTIONS) {
    if (!ids.includes(cp)) continue;
    const r = await fetch(`${base}/api/${cp}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .catch((e) => ({ ok: false, message: e.message }));
    console.log(`[app-stations] ${cp} ${action}: ${r.ok ? 'ok' : 'LỖI'} — ${r.message}`);
  }
}

function fail(msg) {
  console.error(`[app-stations] ${msg}`);
  process.exit(2);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitHttp(u) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${u}/`);
      return;
    } catch {
      await sleep(500);
    }
  }
  fail(`HMI không lên ở ${u}`);
}
