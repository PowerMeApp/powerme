// Đọc trace JSONL của mini-csms → (1) sequence diagram Mermaid, (2) bảng tóm tắt từng giao dịch.
//
// Chạy:  node lab/trace-to-mermaid.mjs lab/ocpp-traces/trace-....jsonl [--collapse] [--skew=5]
//   --collapse   gộp chuỗi MeterValues liên tiếp thành một dòng "MeterValues ×N"
//   --skew=N     đánh dấu bản tin có received_at − cp_timestamp > N giây (nghi là phát lại)

import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error('thiếu đường dẫn trace');
const collapse = flags.includes('--collapse');
const skewSec = Number((flags.find((f) => f.startsWith('--skew=')) ?? '--skew=5').split('=')[1]);

const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// Tóm tắt tham số cho từng loại bản tin — chỉ những trường có ý nghĩa nghiệp vụ
function summarize(action, p) {
  switch (action) {
    case 'BootNotification':
      return `${p.chargePointVendor} ${p.chargePointModel}`;
    case 'StatusNotification':
      return `c${p.connectorId} ${p.status}`;
    case 'Authorize':
      return `idTag=${p.idTag}`;
    case 'StartTransaction':
      return `c${p.connectorId} meterStart=${p.meterStart} Wh`;
    case 'MeterValues': {
      const sv = p.meterValue?.[0]?.sampledValue ?? [];
      const e = sv.find((s) => !s.measurand || s.measurand === 'Energy.Active.Import.Register');
      const soc = sv.find((s) => s.measurand === 'SoC');
      return `tx${p.transactionId} ${e ? e.value + ' ' + (e.unit ?? 'Wh') : ''}${soc ? ' SoC=' + soc.value + '%' : ''}`;
    }
    case 'StopTransaction':
      return `tx${p.transactionId} meterStop=${p.meterStop} Wh reason=${p.reason ?? '-'}`;
    default:
      return '';
  }
}

const skew = (r) =>
  r.cp_timestamp ? (new Date(r.received_at) - new Date(r.cp_timestamp)) / 1000 : null;

// ---- 1. Mermaid ----
const calls = new Map(); // id -> action, để ghép CALLRESULT với CALL
const lines = ['sequenceDiagram', '  participant CP as Trụ (simulator)', '  participant CS as Mini-CSMS'];
let mvRun = 0;
const flushMv = () => {
  if (mvRun > 0) lines.push(`  CP->>CS: MeterValues ×${mvRun}`, `  CS-->>CP: CALLRESULT ×${mvRun}`);
  mvRun = 0;
};

for (const r of rows) {
  const msg = JSON.parse(r.raw);
  if (r.type === 2) {
    const [, id, action, params] = msg;
    calls.set(id, action);
    // Gộp MeterValues cho gọn — nhưng KHÔNG gộp mẫu nghi phát lại (skew lớn), đó là thứ cần nhìn
    if (collapse && action === 'MeterValues' && !((skew(r) ?? 0) > skewSec)) {
      mvRun++;
      continue;
    }
    flushMv();
    const arrow = r.dir === 'in' ? 'CP->>CS' : 'CS->>CP';
    lines.push(`  ${arrow}: ${action} ${summarize(action, params)}`.trimEnd());
    const s = skew(r);
    if (s !== null && s > skewSec) lines.push(`  Note over CP,CS: ⚠ received_at − cp_timestamp = ${s.toFixed(0)}s → nghi phát lại`);
  } else if (r.type === 3) {
    const action = calls.get(msg[1]);
    const call = rows.find((x) => x.type === 2 && x.id === msg[1] && x.dir !== r.dir);
    if (collapse && action === 'MeterValues' && !((call ? skew(call) : 0) > skewSec)) continue;
    const arrow = r.dir === 'out' ? 'CS-->>CP' : 'CP-->>CS';
    const extra = action === 'StartTransaction' ? ` transactionId=${msg[2].transactionId}` : '';
    lines.push(`  ${arrow}: CALLRESULT ${action}${extra}`);
  } else if (r.type === 4) {
    lines.push(`  ${r.dir === 'out' ? 'CS-->>CP' : 'CP-->>CS'}: CALLERROR ${msg[2]}`);
  }
}
flushMv();

const out = file.replace(/\.jsonl$/, collapse ? '.collapsed.mmd' : '.mmd');
writeFileSync(out, lines.join('\n') + '\n');

// ---- 2. Bảng tóm tắt giao dịch ----
const tx = new Map();
for (const r of rows) {
  if (r.type !== 2 || r.dir !== 'in') continue;
  const [, id, action, p] = JSON.parse(r.raw);
  if (action === 'StartTransaction') {
    // transactionId nằm trong CALLRESULT cùng id
    const res = rows.find((x) => x.type === 3 && x.id === id && x.dir === 'out');
    const txId = res ? JSON.parse(res.raw)[2].transactionId : '?';
    tx.set(txId, { txId, connector: p.connectorId, meterStart: p.meterStart, mv: 0, maxSkew: 0, meterStop: null, reason: null });
  }
  if (action === 'MeterValues' && tx.has(p.transactionId)) {
    const t = tx.get(p.transactionId);
    t.mv++;
    t.maxSkew = Math.max(t.maxSkew, skew(r) ?? 0);
  }
  if (action === 'StopTransaction' && tx.has(p.transactionId)) {
    Object.assign(tx.get(p.transactionId), { meterStop: p.meterStop, reason: p.reason, maxSkew: Math.max(tx.get(p.transactionId).maxSkew, skew(r) ?? 0) });
  }
}

console.log(`frames: ${rows.length}  |  diagram: ${out}\n`);
console.log('tx   conn  meterStart   meterStop    energy(Wh)  #MV  maxSkew(s)  reason');
for (const t of tx.values()) {
  const energy = t.meterStop != null ? t.meterStop - t.meterStart : '-';
  console.log(
    `${String(t.txId).padEnd(4)} ${String(t.connector).padEnd(5)} ${String(t.meterStart).padEnd(12)} ${String(t.meterStop ?? '(mở)').padEnd(12)} ${String(energy).padEnd(11)} ${String(t.mv).padEnd(4)} ${t.maxSkew.toFixed(1).padEnd(11)} ${t.reason ?? '-'}`,
  );
}
