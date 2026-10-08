// Mini-CSMS — phôi thai của BE-02, dùng làm DỤNG CỤ ĐO cho bàn thí nghiệm OCPP.
//
// Chỉ làm hai việc:
//   1. Ghi MỌI frame OCPP thô ra JSONL kèm received_at (đồng hồ CSMS, tin được)
//      và cp_timestamp (đồng hồ trụ, không tin) — đúng tinh thần ADR-0005 / ADR-0009.
//   2. Trả lời tối thiểu nhưng hợp schema cho các bản tin Core, để trụ chạy được phiên sạc.
//
// Chưa có state machine, chưa có DB, chưa có đối soát. Đây không phải sản phẩm.
//
// Chạy:  node lab/mini-csms.mjs            (từ apps/csms)
//        PORT=9001 node lab/mini-csms.mjs

import ocpp from 'ocpp-rpc';
import { createWriteStream, mkdirSync } from 'node:fs';

const { RPCServer, createRPCError } = ocpp;

const PORT = Number(process.env.PORT ?? 9000);
const now = () => new Date().toISOString();

mkdirSync('lab/ocpp-traces', { recursive: true });
const tracePath = `lab/ocpp-traces/trace-${now().replace(/[:.]/g, '-')}.jsonl`;
const trace = createWriteStream(tracePath, { flags: 'a' });

let nextTransactionId = 1;

// Timestamp do TRỤ ghi trong payload, nếu có. Lưu để so với received_at.
function cpTimestampOf(action, params) {
  if (!params) return null;
  if (params.timestamp) return params.timestamp;
  if (action === 'MeterValues') return params.meterValue?.[0]?.timestamp ?? null;
  return null;
}

const server = new RPCServer({
  protocols: ['ocpp1.6'], // subprotocol WebSocket bắt buộc
  strictMode: true, // validate cả chiều vào lẫn câu trả lời của mình theo schema OCA
});

server.on('client', (client) => {
  const cp = client.identity; // đoạn cuối URL: ws://host/ocpp/<identity>
  console.log(`${now()}  ▶ ${cp} kết nối (${client.protocol})`);

  // Ghi log TRƯỚC khi bất kỳ handler nào chạy. ocpp-rpc phát 'message' cho mọi frame thô.
  client.on('message', ({ message, outbound }) => {
    const received_at = now();
    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch {}
    const [type, id, a, b] = parsed ?? [];
    const action = type === 2 ? a : null;
    const params = type === 2 ? b : null;
    trace.write(
      JSON.stringify({
        received_at,
        cp,
        dir: outbound ? 'out' : 'in',
        type,
        id,
        action,
        cp_timestamp: cpTimestampOf(action, params),
        raw: message,
      }) + '\n',
    );
    const label = { 2: `CALL ${action}`, 3: 'CALLRESULT', 4: 'CALLERROR' }[type] ?? '??';
    console.log(`${received_at}  ${outbound ? '◀ out' : '▶ in '}  ${cp}  ${label}`);
  });

  // Câu trả lời tối thiểu hợp schema OCPP 1.6
  client.handle('BootNotification', () => ({
    status: 'Accepted',
    currentTime: now(),
    interval: 60,
  }));
  client.handle('Heartbeat', () => ({ currentTime: now() }));
  client.handle('StatusNotification', () => ({}));
  client.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
  client.handle('StartTransaction', () => ({
    transactionId: nextTransactionId++,
    idTagInfo: { status: 'Accepted' },
  }));
  client.handle('MeterValues', () => ({}));
  client.handle('StopTransaction', () => ({ idTagInfo: { status: 'Accepted' } }));
  client.handle('DataTransfer', () => ({ status: 'Accepted' }));
  client.handle(({ method }) => {
    throw createRPCError('NotImplemented', `${method} chưa được hỗ trợ`);
  });

  client.on('strictValidationFailure', (e) => console.warn(`${now()}  ⚠ schema: ${e.message}`));
  client.on('close', () => console.log(`${now()}  ■ ${cp} ngắt`));
});

await server.listen(PORT);
console.log(`Mini-CSMS: ws://localhost:${PORT}/ocpp/{identity}  —  trace: ${tracePath}`);
