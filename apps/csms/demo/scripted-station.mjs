/**
 * Trụ kịch bản — chạy đúng các kịch bản trong docs/DEMO-REVIEW-2.md mà KHÔNG cần HMI.
 *
 * Vì sao tồn tại: `lab/fake-station.mjs` chỉ bắt đầu phiên khi CSMS gửi RemoteStartTransaction, mà
 * CSMS Iteration 1 chưa có đường gửi lệnh xuống trụ — nên fake-station tự nó không tạo được phiên
 * sạc. Script này là kế hoạch B (HMI hỏng, đứt mạng ở phòng demo) và là cách kiểm chứng các kịch
 * bản trước khi HMI + console merge. Nó KHÔNG phải firmware Ruihua và KHÔNG thay SAP simulator
 * (QA-01); chỉ nói đúng giao thức OCPP 1.6J theo cùng phong cách với lab/fake-station.mjs.
 *
 * Chạy (CSMS phải đang lên, xem `npm run demo`):
 *   node demo/scripted-station.mjs <kịch bản> [tuỳ chọn]
 *
 * Kịch bản:
 *   ds-01a   quẹt thẻ hợp lệ (mặc định DEMO-CARD-0001; --tag DEMO-WALLET-0001 cho thẻ ví) → phiên active, origin=rfid
 *   ds-01b   thẻ bị chặn DEMO-BLOCKED-01 → Authorize Blocked, không có phiên
 *   ds-03a   phiên sạc → rớt mạng 60 s → nối lại KHÔNG Boot → StopTransaction phát lại mang meterStop cũ
 *            (tái hiện hiện tượng 3 của EXP-01) → phiên review + bản ghi conflict + mẫu phát lại
 *   ds-03b   StartTransaction gửi lại sau khi nối lại → khử trùng, không tạo phiên thứ hai
 *   ds-03c   thẻ lạ khi trụ offline → phiên vẫn được ghi (ADR-0012) + bản ghi unknown_id_tag
 *   ds-03d   trụ nối lại khi phiên còn orphaned và vẫn đang sạc → orphaned → active
 *
 * Tuỳ chọn: --id RH24D1-00001  --url ws://localhost:9000/ocpp  --connector 1
 *           --interval-s 10 (nhịp MeterValues)  --offline-s 60 (độ dài đứt mạng)  --fast (3 s / 15 s)
 *           --tag <idTag>
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RPCClient, createRPCError } = require('ocpp-rpc');

// ---- Tham số ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const scenario = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const fast = argv.includes('--fast');
const ID = opt('id', 'RH24D1-00001');
const URL = opt('url', 'ws://localhost:9000/ocpp');
const CONNECTOR = Number(opt('connector', 1));
const INTERVAL_S = Number(opt('interval-s', fast ? 3 : 10));
const OFFLINE_S = Number(opt('offline-s', fast ? 15 : 60));
const SAMPLE_WH = 170; // ~60 kW × 10 s; chỉ để số liệu đẹp, không có ý nghĩa vật lý

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), `[${ID}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Trạng thái trụ giả (qua nhiều lần nối lại) --------------------------------------------------
const connectorStatus = new Map([
  [1, 'Available'],
  [2, 'Available'],
]);
let client = null;

async function connect({ boot }) {
  client = new RPCClient({
    endpoint: URL,
    identity: ID,
    protocols: ['ocpp1.6'],
    strictMode: true,
    reconnect: false,
  });
  // Sau khi nối lại, CSMS gửi TriggerMessage(StatusNotification) cho connector 0/1/2 để biết trụ đang
  // ở trạng thái nào (đây là cách phiên orphaned được kéo về active — T13 #18).
  client.handle('TriggerMessage', async ({ params }) => {
    const { requestedMessage, connectorId } = params;
    if (requestedMessage !== 'StatusNotification') return { status: 'NotImplemented' };
    setImmediate(async () => {
      try {
        if (connectorId === 0) {
          await client.call('StatusNotification', {
            connectorId: 0,
            status: 'Available',
            errorCode: 'NoError',
            timestamp: now(),
          });
        } else {
          await notify(connectorId, connectorStatus.get(connectorId));
        }
      } catch (e) {
        log('✗ trả lời TriggerMessage:', e.message);
      }
    });
    return { status: 'Accepted' };
  });
  client.handle(({ method }) => {
    throw createRPCError('NotImplemented', `${method} không được hỗ trợ`);
  });
  await client.connect();
  log(`▶ đã nối ${URL}/${ID}${boot ? '' : ' (KHÔNG gửi BootNotification — như EXP-01)'}`);
  if (boot) {
    const res = await client.call('BootNotification', {
      chargePointVendor: 'Ruihua',
      chargePointModel: 'D1-120',
      chargePointSerialNumber: ID,
      firmwareVersion: '4.0.4.22',
    });
    log(`  BootNotification → ${res.status}`);
    for (const [id, st] of connectorStatus) await notify(id, st);
  }
}

async function notify(connectorId, status) {
  connectorStatus.set(connectorId, status);
  await client.call('StatusNotification', {
    connectorId,
    status,
    errorCode: 'NoError',
    timestamp: now(),
  });
  log(`  connector ${connectorId} → ${status}`);
}

/** Ngắt đột ngột (không close frame) — CSMS thấy mã 1006, giống rút cáp mạng. */
async function dropLink() {
  log('✂ NGẮT KẾT NỐI (force)');
  await client.close({ force: true });
}

function meterValuesParams(connectorId, transactionId, wh, ts = now()) {
  return {
    connectorId,
    transactionId,
    meterValue: [
      {
        timestamp: ts,
        sampledValue: [
          { value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          {
            value: String(Math.min(100, 20 + Math.round(wh / 40))),
            measurand: 'SoC',
            unit: 'Percent',
          },
          { value: '60000', measurand: 'Power.Active.Import', unit: 'W' },
          { value: '400', measurand: 'Voltage', unit: 'V' },
          { value: '150', measurand: 'Current.Import', unit: 'A' },
        ],
      },
    ],
  };
}

async function authorize(idTag) {
  const res = await client.call('Authorize', { idTag });
  log(`  Authorize ${idTag} → ${res.idTagInfo.status}`);
  return res.idTagInfo.status;
}

async function startTx(connectorId, idTag, ts = now(), meterStart = 0) {
  const res = await client.call('StartTransaction', {
    connectorId,
    idTag,
    meterStart,
    timestamp: ts,
  });
  log(`  StartTransaction → transactionId=${res.transactionId} (${res.idTagInfo.status})`);
  return res.transactionId;
}

async function sendMeter(connectorId, transactionId, wh, ts) {
  await client.call('MeterValues', meterValuesParams(connectorId, transactionId, wh, ts));
  log(`  MeterValues tx=${transactionId} ${wh} Wh${ts ? ` (cp_timestamp ${ts})` : ''}`);
}

async function stopTx(transactionId, idTag, meterStop, reason = 'Local', ts = now()) {
  await client.call('StopTransaction', { transactionId, idTag, meterStop, timestamp: ts, reason });
  log(`  StopTransaction tx=${transactionId} meterStop=${meterStop} Wh (${reason})`);
}

async function plugAndStart(idTag) {
  await notify(CONNECTOR, 'Preparing');
  const txId = await startTx(CONNECTOR, idTag);
  await notify(CONNECTOR, 'Charging');
  return txId;
}

// ---- Kịch bản ------------------------------------------------------------------------------
const SCENARIOS = {
  async 'ds-01a'() {
    const tag = opt('tag', 'DEMO-CARD-0001');
    await connect({ boot: true });
    if ((await authorize(tag)) !== 'Accepted') throw new Error('thẻ không được chấp nhận');
    const tx = await plugAndStart(tag);
    let wh = 0;
    for (let i = 0; i < 3; i++) {
      await sleep(INTERVAL_S * 1000);
      wh += SAMPLE_WH;
      await sendMeter(CONNECTOR, tx, wh);
    }
    await notify(CONNECTOR, 'Finishing');
    await stopTx(tx, tag, wh);
    await notify(CONNECTOR, 'Available');
    return { tx };
  },

  async 'ds-01b'() {
    const tag = opt('tag', 'DEMO-BLOCKED-01');
    await connect({ boot: true });
    const status = await authorize(tag);
    log(
      status === 'Accepted'
        ? '✗ BẤT NGỜ: thẻ bị chấp nhận'
        : '  trụ từ chối, không gửi StartTransaction',
    );
  },

  async 'ds-03a'() {
    const tag = opt('tag', 'DEMO-CARD-0001');
    await connect({ boot: true });
    await authorize(tag);
    const tx = await plugAndStart(tag);
    let wh = 0;
    for (let i = 0; i < 3; i++) {
      await sleep(INTERVAL_S * 1000);
      wh += SAMPLE_WH;
      await sendMeter(CONNECTOR, tx, wh);
    }
    const whAtDrop = wh; // số này sẽ đóng băng vào meterStop (firmware lỗi, EXP-01 hiện tượng 3)
    await dropLink();

    // Trong lúc mất mạng, trụ vẫn sạc và xếp hàng MeterValues (mang cp_timestamp thật).
    const queued = [];
    const outageEnd = Date.now() + OFFLINE_S * 1000;
    log(`  offline ${OFFLINE_S} s — trụ vẫn sạc và xếp hàng MeterValues`);
    while (Date.now() + INTERVAL_S * 1000 <= outageEnd) {
      await sleep(INTERVAL_S * 1000);
      wh += SAMPLE_WH;
      queued.push({ wh, ts: now() });
    }
    await sleep(Math.max(0, outageEnd - Date.now()));
    const stopTs = queued.length ? queued[queued.length - 1].ts : now();

    // Nối lại KHÔNG Boot. Thứ tự như EXP-01: MeterValues live → StopTransaction phát lại → MeterValues phát lại.
    await connect({ boot: false });
    wh += SAMPLE_WH;
    await sendMeter(CONNECTOR, tx, wh);
    await sleep(1000);
    await stopTx(tx, tag, whAtDrop, 'Local', stopTs);
    for (const q of queued) await sendMeter(CONNECTOR, tx, q.wh, q.ts);
    await notify(CONNECTOR, 'Available');
    return { tx, whAtDrop, lastSampleWh: wh };
  },

  async 'ds-03b'() {
    const tag = opt('tag', 'DEMO-CARD-0001');
    await connect({ boot: true });
    await authorize(tag);
    await notify(CONNECTOR, 'Preparing');
    const ts = now();
    const first = await startTx(CONNECTOR, tag, ts); // CSMS đã ghi phiên…
    await dropLink(); // …nhưng trụ không chắc đã nhận CALLRESULT nên giữ bản tin trong hàng đợi
    await sleep(2000);
    await connect({ boot: false });
    const second = await startTx(CONNECTOR, tag, ts); // gửi lại Y NGUYÊN (cùng timestamp, meterStart)
    log(
      first === second
        ? `✓ khử trùng: cùng transactionId ${first}`
        : `✗ KHÁC transactionId: ${first} vs ${second}`,
    );
    await notify(CONNECTOR, 'Charging');
    await sleep(INTERVAL_S * 1000);
    await sendMeter(CONNECTOR, first, SAMPLE_WH);
    await stopTx(first, tag, SAMPLE_WH);
    await notify(CONNECTOR, 'Available');
    return { first, second };
  },

  async 'ds-03c'() {
    const tag = opt('tag', 'UNKNOWN-TAG-99'); // KHÔNG có trong seed
    await connect({ boot: true });
    log('  online: thẻ lạ bị Authorize từ chối…');
    await authorize(tag);
    await dropLink();
    log(
      '  offline: trụ chấp nhận cục bộ (local pre-authorize) và vẫn sạc — xếp hàng StartTransaction',
    );
    const startTs = now();
    await sleep(Math.min(OFFLINE_S, 10) * 1000);
    const stopTs = now();
    await connect({ boot: false });
    await notify(CONNECTOR, 'Preparing');
    const tx = await startTx(CONNECTOR, tag, startTs);
    await sendMeter(CONNECTOR, tx, SAMPLE_WH, stopTs);
    await stopTx(tx, tag, SAMPLE_WH, 'Local', stopTs);
    await notify(CONNECTOR, 'Available');
    return { tx };
  },

  async 'ds-03d'() {
    const tag = opt('tag', 'DEMO-CARD-0001');
    const offlineS = Number(opt('offline-s', 15));
    await connect({ boot: true });
    await authorize(tag);
    const tx = await plugAndStart(tag);
    let wh = 0;
    for (let i = 0; i < 2; i++) {
      await sleep(INTERVAL_S * 1000);
      wh += SAMPLE_WH;
      await sendMeter(CONNECTOR, tx, wh);
    }
    await dropLink();
    log(`  offline ${offlineS} s — phiên đang sạc, CSMS phải đánh dấu orphaned`);
    await sleep(offlineS * 1000);
    await connect({ boot: false }); // CSMS gửi TriggerMessage → trả Charging → LIVE_MESSAGE → active
    await sleep(2000);
    for (let i = 0; i < 2; i++) {
      wh += SAMPLE_WH;
      await sendMeter(CONNECTOR, tx, wh);
      await sleep(INTERVAL_S * 1000);
    }
    await notify(CONNECTOR, 'Finishing');
    await stopTx(tx, tag, wh);
    await notify(CONNECTOR, 'Available');
    return { tx };
  },
};

if (!scenario || !SCENARIOS[scenario]) {
  console.error(`Kịch bản: ${Object.keys(SCENARIOS).join(' | ')}\nXem đầu file để biết tuỳ chọn.`);
  process.exit(2);
}

try {
  log(`=== kịch bản ${scenario} ===`);
  const out = await SCENARIOS[scenario]();
  log(`=== xong ${scenario} ${out ? JSON.stringify(out) : ''} ===`);
  await sleep(500);
  await client?.close({ code: 1000, reason: 'kịch bản xong' }).catch(() => {});
  process.exit(0);
} catch (err) {
  console.error(`${now()} [${ID}] ✗ ${err?.stack ?? err}`);
  process.exit(1);
}
