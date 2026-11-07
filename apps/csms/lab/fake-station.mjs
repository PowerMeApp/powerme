// Trụ giả tối giản — DỤNG CỤ TEST cho csms-ctl.mjs.
//
// ⚠️ ĐÂY KHÔNG PHẢI SIMULATOR CHÍNH THỨC CỦA ĐỒ ÁN.
//
// Simulator chính thức là SAP e-mobility-charging-stations-simulator (QA-01, WP5);
// mọi số liệu đưa vào báo cáo phải chạy trên nó. File này tồn tại vì hai lý do:
//
//   1. Thử lớp điều khiển mà không phải build SAP (vốn cần pnpm + bundle, hỏng
//      vặt trên Windows).
//   2. Mô hình hoá hành vi trụ theo ĐÚNG SPEC OCPP 1.6 cho những chỗ manual
//      Ruihua im lặng — chính là BR-P09.
//
// Nó mô phỏng một trụ DC hai súng kiểu D1-120: connector 1 = Gun A, 2 = Gun B,
// connector 0 = toàn trụ (BR-P10).
//
// Chạy:  node lab/fake-station.mjs
//        ID=RH24D1-002 CSMS=ws://localhost:9000/ocpp node lab/fake-station.mjs

import ocpp from 'ocpp-rpc';

const { RPCClient, createRPCError } = ocpp;

const ID = process.env.ID ?? 'RH24D1-001';
const CSMS = process.env.CSMS ?? 'ws://localhost:9000/ocpp';
const METER_INTERVAL = Number(process.env.METER_INTERVAL ?? 10) * 1000;

const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);

// Trạng thái từng connector. 1 = Gun A, 2 = Gun B.
const connectors = new Map([
  [1, { status: 'Available', reservation: null, tx: null }],
  [2, { status: 'Available', reservation: null, tx: null }],
]);

const client = new RPCClient({
  endpoint: CSMS,
  identity: ID,
  protocols: ['ocpp1.6'],
  strictMode: true,
});

async function setStatus(connectorId, status, errorCode = 'NoError') {
  const c = connectors.get(connectorId);
  if (c) c.status = status;
  await client.call('StatusNotification', {
    connectorId,
    status,
    errorCode,
    timestamp: now(),
  });
  log(`   connector ${connectorId} → ${status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lệnh từ CSMS xuống trụ
// ─────────────────────────────────────────────────────────────────────────────

client.handle('ReserveNow', async ({ params }) => {
  const { connectorId, reservationId, expiryDate, idTag } = params;
  const c = connectors.get(connectorId);

  // OCPP 1.6 §4.9: connector không ở trạng thái Available thì trả Occupied.
  if (!c) return { status: 'Rejected' };
  if (c.status === 'Faulted') return { status: 'Faulted' };
  if (c.status === 'Unavailable') return { status: 'Unavailable' };
  if (c.status !== 'Available') {
    log(
      `   ReserveNow #${reservationId} trên connector ${connectorId} → Occupied (đang ${c.status})`,
    );
    return { status: 'Occupied' };
  }

  c.reservation = { reservationId, idTag, expiryDate };
  // Trả lời TRƯỚC rồi mới đổi trạng thái — tránh StatusNotification chen vào
  // giữa lúc CALLRESULT chưa về, thứ tự này giống hành vi trụ thật.
  setImmediate(() => setStatus(connectorId, 'Reserved').catch(() => {}));
  log(`   ReserveNow #${reservationId} trên connector ${connectorId} → Accepted`);
  return { status: 'Accepted' };
});

client.handle('CancelReservation', async ({ params }) => {
  for (const [id, c] of connectors) {
    if (c.reservation?.reservationId === params.reservationId) {
      c.reservation = null;
      setImmediate(() => setStatus(id, 'Available').catch(() => {}));
      return { status: 'Accepted' };
    }
  }
  return { status: 'Rejected' };
});

client.handle('RemoteStartTransaction', async ({ params }) => {
  const connectorId = params.connectorId ?? 1;
  const c = connectors.get(connectorId);
  if (!c) return { status: 'Rejected' };
  if (c.tx) return { status: 'Rejected' };

  // Chỗ đã đặt chỉ mở được cho đúng idTag đã giữ chỗ.
  if (c.reservation && c.reservation.idTag !== params.idTag) {
    log(`   RemoteStart bị từ chối: connector ${connectorId} đang giữ cho ${c.reservation.idTag}`);
    return { status: 'Rejected' };
  }

  setImmediate(() => startSession(connectorId, params.idTag).catch((e) => log('✗', e.message)));
  return { status: 'Accepted' };
});

client.handle('RemoteStopTransaction', async ({ params }) => {
  for (const [id, c] of connectors) {
    if (c.tx?.transactionId === params.transactionId) {
      setImmediate(() => stopSession(id, 'Remote').catch((e) => log('✗', e.message)));
      return { status: 'Accepted' };
    }
  }
  return { status: 'Rejected' };
});

client.handle('UnlockConnector', async ({ params }) => {
  const c = connectors.get(params.connectorId);
  return { status: c ? 'Unlocked' : 'NotSupported' };
});

client.handle('ChangeAvailability', async ({ params }) => {
  const c = connectors.get(params.connectorId);
  if (!c) return { status: 'Rejected' };
  if (c.tx) return { status: 'Scheduled' }; // đang sạc thì hoãn tới khi xong
  const status = params.type === 'Inoperative' ? 'Unavailable' : 'Available';
  setImmediate(() => setStatus(params.connectorId, status).catch(() => {}));
  return { status: 'Accepted' };
});

client.handle('Reset', async ({ params }) => {
  log(`   Reset ${params.type} — sẽ nối lại sau 5 giây`);
  setTimeout(() => {
    client.close({ code: 1012, reason: 'Reset' }).catch(() => {});
    setTimeout(() => boot().catch((e) => log('✗', e.message)), 5000);
  }, 500);
  return { status: 'Accepted' };
});

// Khai báo theo đúng template powerme-d1.station-template.json.
const CONFIG = new Map([
  [
    'MeterValuesSampledData',
    {
      value: 'SoC,Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage',
      readonly: false,
    },
  ],
  ['MeterValueSampleInterval', { value: String(METER_INTERVAL / 1000), readonly: false }],
  [
    'SupportedFeatureProfiles',
    {
      value:
        'Core,FirmwareManagement,LocalAuthListManagement,SmartCharging,RemoteTrigger,Reservation',
      readonly: true,
    },
  ],
  ['AuthorizeRemoteTxRequests', { value: 'false', readonly: false }],
  ['ReserveConnectorZeroSupported', { value: 'false', readonly: true }],
  ['HeartbeatInterval', { value: '60', readonly: false }],
  ['NumberOfConnectors', { value: '2', readonly: true }],
]);

client.handle('GetConfiguration', async ({ params }) => {
  // Không truyền key thì trả về MỌI key trụ hỗ trợ — đây là cách dò khả năng
  // của firmware thật mà không cần hỏi hãng.
  const want = params?.key?.length ? params.key : [...CONFIG.keys()];
  const configurationKey = [];
  const unknownKey = [];
  for (const k of want) {
    const v = CONFIG.get(k);
    if (v) configurationKey.push({ key: k, readonly: v.readonly, value: v.value });
    else unknownKey.push(k);
  }
  return unknownKey.length ? { configurationKey, unknownKey } : { configurationKey };
});

client.handle('ChangeConfiguration', async ({ params }) => {
  const v = CONFIG.get(params.key);
  if (!v) return { status: 'NotSupported' };
  if (v.readonly) return { status: 'Rejected' };
  v.value = params.value;
  return { status: 'Accepted' };
});

client.handle('TriggerMessage', async ({ params }) => {
  const { requestedMessage, connectorId } = params;
  const supported = ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues'];
  if (!supported.includes(requestedMessage)) return { status: 'NotImplemented' };

  setImmediate(async () => {
    try {
      if (requestedMessage === 'Heartbeat') await client.call('Heartbeat', {});
      if (requestedMessage === 'StatusNotification') {
        for (const [id, c] of connectors) {
          if (!connectorId || connectorId === id) await setStatus(id, c.status);
        }
      }
      if (requestedMessage === 'MeterValues') {
        for (const [id, c] of connectors) if (c.tx) await sendMeterValues(id);
      }
    } catch (e) {
      log('✗', e.message);
    }
  });
  return { status: 'Accepted' };
});

client.handle(({ method }) => {
  throw createRPCError('NotImplemented', `${method} khong duoc ho tro`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phiên sạc
// ─────────────────────────────────────────────────────────────────────────────

async function startSession(connectorId, idTag) {
  const c = connectors.get(connectorId);
  await setStatus(connectorId, 'Preparing');

  const res = await client.call('StartTransaction', {
    connectorId,
    idTag,
    meterStart: 0, // Wh — số nguyên, KHÔNG phải kWh (ADR-0009)
    timestamp: now(),
    ...(c.reservation ? { reservationId: c.reservation.reservationId } : {}),
  });

  c.tx = {
    transactionId: res.transactionId,
    idTag,
    meterWh: 0,
    soc: 20,
    startedAt: Date.now(),
  };
  c.reservation = null; // giữ chỗ tiêu thụ xong thì hết hiệu lực
  await setStatus(connectorId, 'Charging');
  log(`   phiên ${res.transactionId} bắt đầu trên connector ${connectorId}`);

  c.timer = setInterval(() => sendMeterValues(connectorId).catch(() => {}), METER_INTERVAL);
}

async function sendMeterValues(connectorId) {
  const c = connectors.get(connectorId);
  if (!c?.tx) return;

  // 120 kW chia đôi hai súng, lấy tròn 60 kW cho súng đang sạc.
  const kw = 60;
  const deltaWh = Math.round((kw * 1000 * METER_INTERVAL) / 3_600_000);
  c.tx.meterWh += deltaWh;
  c.tx.soc = Math.min(100, c.tx.soc + 2);

  await client.call('MeterValues', {
    connectorId,
    transactionId: c.tx.transactionId,
    meterValue: [
      {
        timestamp: now(),
        sampledValue: [
          { value: String(c.tx.meterWh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          { value: String(c.tx.soc), measurand: 'SoC', unit: 'Percent' },
          { value: String(kw * 1000), measurand: 'Power.Active.Import', unit: 'W' },
          { value: '400', measurand: 'Voltage', unit: 'V' },
          { value: '150', measurand: 'Current.Import', unit: 'A' },
        ],
      },
    ],
  });

  if (c.tx.soc >= 100) await stopSession(connectorId, 'Local'); // sạc đầy, trụ tự dừng
}

async function stopSession(connectorId, reason) {
  const c = connectors.get(connectorId);
  if (!c?.tx) return;
  clearInterval(c.timer);
  const tx = c.tx;
  c.tx = null;

  await setStatus(connectorId, 'Finishing');
  await client.call('StopTransaction', {
    transactionId: tx.transactionId,
    idTag: tx.idTag,
    meterStop: tx.meterWh,
    timestamp: now(),
    reason,
  });
  log(`   phiên ${tx.transactionId} dừng (${reason}, ${tx.meterWh} Wh)`);
  await setStatus(connectorId, 'Available');
}

// ─────────────────────────────────────────────────────────────────────────────
// Khởi động
// ─────────────────────────────────────────────────────────────────────────────

async function boot() {
  await client.connect();
  const res = await client.call('BootNotification', {
    chargePointVendor: 'Ruihua',
    chargePointModel: 'D1-120',
    chargePointSerialNumber: ID,
    firmwareVersion: '4.0.4.22',
  });
  log(`▶ BootNotification → ${res.status}, heartbeat mỗi ${res.interval}s`);

  for (const [id, c] of connectors) await setStatus(id, c.status);
  setInterval(() => client.call('Heartbeat', {}).catch(() => {}), (res.interval || 60) * 1000);
}

client.on('close', () => log('■ mất kết nối tới CSMS'));
client.on('open', () => log(`▶ đã nối tới ${CSMS}/${ID}`));

await boot();
log(`Trụ giả ${ID} sẵn sàng — 2 connector, DC 120 kW`);
