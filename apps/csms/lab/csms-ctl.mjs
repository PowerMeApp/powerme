// CSMS-CTL — mini-CSMS có thêm MẶT ĐIỀU KHIỂN để gửi lệnh xuống trụ.
//
// mini-csms.mjs chỉ nghe và ghi. File này giữ nguyên phần ghi trace, thêm ba thứ:
//
//   1. Sổ đăng ký kết nối — giữ lại `client` theo identity, nên về sau còn gọi
//      xuống trụ được. mini-csms vứt tham chiếu này đi nên không interact được.
//   2. API HTTP để gửi mọi lệnh chiều xuống: RemoteStart/Stop, ReserveNow,
//      CancelReservation, Reset, UnlockConnector, Get/ChangeConfiguration,
//      TriggerMessage, ChangeAvailability.
//   3. Nút cắt kết nối theo lệnh — để lặp lại ba kịch bản ngắt một cách chính
//      xác, thay vì rút mạng bằng tay như EXP-01.
//
// Đây vẫn là DỤNG CỤ ĐO, không phải sản phẩm: chưa có state machine, chưa có DB,
// chưa có đối soát. BE-02 thật dựng trên NestJS sau.
//
// Chạy:  node lab/csms-ctl.mjs                 (từ apps/csms)
//        PORT=9000 CTL_PORT=9100 node lab/csms-ctl.mjs

import ocpp from 'ocpp-rpc';
import { createServer } from 'node:http';
import { openTrace, now } from './trace.mjs';

const { RPCServer, createRPCError } = ocpp;

const PORT = Number(process.env.PORT ?? 9000);
const CTL_PORT = Number(process.env.CTL_PORT ?? 9100);

const trace = openTrace('lab/ocpp-traces', 'ctl');

// identity -> { client, connectedAt, epoch, transactions: Map<connectorId, txId> }
const stations = new Map();

let nextTransactionId = 1;
let nextReservationId = 1;

const log = (...a) => console.log(now(), ...a);

// ─────────────────────────────────────────────────────────────────────────────
// Máy chủ OCPP
// ─────────────────────────────────────────────────────────────────────────────
const server = new RPCServer({
  protocols: ['ocpp1.6'],
  strictMode: true, // validate CẢ chiều ra — lệnh sai schema bị chặn tại chỗ
});

server.on('client', (client) => {
  const cp = client.identity;

  // Trụ nối lại với cùng identity khi phiên cũ còn treo: ocpp-rpc KHÔNG tự xử.
  // Đóng kết nối cũ trước, nếu không hai socket cùng mang một identity.
  const old = stations.get(cp);
  if (old && old.client !== client) {
    log(`⚠ ${cp} nối lại khi kết nối cũ còn treo — đóng kết nối cũ`);
    old.client.close({ code: 1012, reason: 'Thay the boi ket noi moi' }).catch(() => {});
  }

  const epoch = trace.newEpoch(cp);
  stations.set(cp, { client, connectedAt: now(), epoch: epoch.n, transactions: new Map() });
  log(`▶ ${cp} kết nối (epoch ${epoch.n}, ${client.protocol})`);

  client.on('message', (ev) => {
    const { type, action } = trace.write(cp, ev);
    const label = { 2: `CALL ${action}`, 3: 'CALLRESULT', 4: 'CALLERROR' }[type] ?? '??';
    log(`${ev.outbound ? '◀ out' : '▶ in '}  ${cp}  ${label}`);
  });

  client.handle('BootNotification', () => ({
    status: 'Accepted',
    currentTime: now(),
    interval: 60,
  }));
  client.handle('Heartbeat', () => ({ currentTime: now() }));
  client.handle('StatusNotification', ({ params }) => {
    const err = params.errorCode && params.errorCode !== 'NoError' ? ` (${params.errorCode})` : '';
    log(`   ${cp} connector ${params.connectorId} → ${params.status}${err}`);
    return {};
  });
  client.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
  client.handle('StartTransaction', ({ params }) => {
    const transactionId = nextTransactionId++;
    stations.get(cp)?.transactions.set(params.connectorId, transactionId);
    return { transactionId, idTagInfo: { status: 'Accepted' } };
  });
  client.handle('MeterValues', () => ({}));
  client.handle('StopTransaction', ({ params }) => {
    const st = stations.get(cp);
    if (st) {
      for (const [c, tx] of st.transactions) {
        if (tx === params.transactionId) st.transactions.delete(c);
      }
    }
    return { idTagInfo: { status: 'Accepted' } };
  });
  client.handle('DataTransfer', () => ({ status: 'Accepted' }));
  client.handle(({ method }) => {
    throw createRPCError('NotImplemented', `${method} chua duoc ho tro`);
  });

  client.on('strictValidationFailure', (e) => log(`⚠ schema: ${e.message}`));
  client.on('close', () => {
    if (stations.get(cp)?.client === client) stations.delete(cp);
    log(`■ ${cp} ngắt`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mặt điều khiển HTTP
// ─────────────────────────────────────────────────────────────────────────────

// Tham số mặc định cho từng lệnh. Chỉ điền chỗ còn thiếu, không ghi đè cái người
// gọi đã truyền — để gõ curl nhanh nhưng vẫn ép được giá trị khi cần.
function withDefaults(action, p, st) {
  const d = { ...p };
  switch (action) {
    case 'RemoteStartTransaction':
      d.idTag ??= 'PWRME-TEST-01';
      break;
    case 'RemoteStopTransaction':
      // Không truyền thì lấy giao dịch đang mở gần nhất của trụ đó.
      d.transactionId ??= [...(st?.transactions.values() ?? [])].at(-1);
      break;
    case 'ReserveNow':
      d.connectorId ??= 1;
      d.idTag ??= 'PWRME-TEST-01';
      d.reservationId ??= nextReservationId++;
      // Mặc định giữ chỗ 15 phút — đúng cửa sổ mặc định của FR-20.
      d.expiryDate ??= new Date(Date.now() + 15 * 60_000).toISOString();
      break;
    case 'CancelReservation':
      d.reservationId ??= nextReservationId - 1;
      break;
    case 'Reset':
      d.type ??= 'Soft';
      break;
    case 'UnlockConnector':
      d.connectorId ??= 1;
      break;
    case 'TriggerMessage':
      d.requestedMessage ??= 'StatusNotification';
      break;
    case 'ChangeAvailability':
      d.connectorId ??= 1;
      d.type ??= 'Operative';
      break;
  }
  return d;
}

const ALLOWED = new Set([
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'CancelReservation',
  'Reset',
  'UnlockConnector',
  'ChangeAvailability',
  'GetConfiguration',
  'ChangeConfiguration',
  'TriggerMessage',
  'GetLocalListVersion',
  'DataTransfer',
]);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null; // body có nhưng hỏng — khác với không có body
  }
}

const ctl = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);

  // GET /stations — trụ nào đang nối, epoch bao nhiêu, giao dịch nào đang mở
  if (req.method === 'GET' && seg[0] === 'stations' && seg.length === 1) {
    return json(res, 200, {
      trace: trace.path,
      stations: [...stations.entries()].map(([id, s]) => ({
        identity: id,
        connectedAt: s.connectedAt,
        epoch: s.epoch,
        openTransactions: Object.fromEntries(s.transactions),
      })),
    });
  }

  // POST /call/:identity/:Action — body JSON là params, thiếu thì lấy mặc định
  if (req.method === 'POST' && seg[0] === 'call' && seg.length === 3) {
    const [, identity, action] = seg;
    const st = stations.get(identity);
    if (!st) return json(res, 404, { error: `Tru "${identity}" khong dang ket noi` });
    if (!ALLOWED.has(action)) {
      return json(res, 400, { error: `Lenh "${action}" khong nam trong danh sach cho phep` });
    }

    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: 'Body khong phai JSON hop le' });

    const params = withDefaults(action, body, st);
    const sentAt = now();
    try {
      const result = await st.client.call(action, params);
      log(`✓ ${identity} ${action} → ${JSON.stringify(result)}`);
      return json(res, 200, { sentAt, action, params, result });
    } catch (err) {
      // Lỗi ở đây có hai nguồn: trụ từ chối (CALLERROR), hoặc strictMode chặn vì
      // payload sai schema. Trả nguyên văn để còn phân biệt được.
      log(`✗ ${identity} ${action} → ${err.message}`);
      return json(res, 502, {
        sentAt,
        action,
        params,
        error: err.message,
        rpcErrorCode: err.rpcErrorCode ?? null,
        details: err.details ?? null,
      });
    }
  }

  // POST /disconnect/:identity — cắt kết nối để chạy kịch bản ngắt
  if (req.method === 'POST' && seg[0] === 'disconnect' && seg.length === 2) {
    const st = stations.get(seg[1]);
    if (!st) return json(res, 404, { error: `Tru "${seg[1]}" khong dang ket noi` });
    await st.client.close({ code: 1001, reason: 'Ngat theo kich ban thi nghiem' }).catch(() => {});
    log(`✂ ${seg[1]} bị cắt theo lệnh`);
    return json(res, 200, { disconnected: seg[1], at: now() });
  }

  json(res, 404, {
    error: 'Khong co route nay',
    routes: [
      'GET  /stations',
      'POST /call/:identity/:Action   (body = params JSON, co the bo trong)',
      'POST /disconnect/:identity',
    ],
  });
});

await server.listen(PORT);
ctl.listen(CTL_PORT);

console.log(`
  OCPP        ws://localhost:${PORT}/ocpp/{identity}
  Dieu khien  http://localhost:${CTL_PORT}/stations
  Trace       ${trace.path}
`);
